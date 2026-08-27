import {
  createDingTalkDedupeCache,
  normalizeDingTalkMessage,
} from "./message.js"
import {
  createDingTalkReplier,
} from "./reply.js"
import {
  createDingTalkStreamSupervisor,
  DingTalkConnectionError,
} from "./stream.js"

export * from "./message.js"
export * from "./reply.js"
export * from "./stream.js"

export class DingTalkDependencyError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = "DingTalkDependencyError"
    this.code = options.code ?? "DINGTALK_DEPENDENCY_ERROR"
  }
}

/**
 * Channel-shaped wrapper that mirrors the runtime's start(handler)/stop()
 * lifecycle while preserving the lower-level adapter for advanced use.
 */
export class DingTalkChannel {
  constructor(options = {}) {
    this.options = { ...options }
    this.adapter = null
    this.replyTargets = new Map()
  }

  async start(handler = this.options.onMessage) {
    if (typeof handler !== "function") {
      throw new TypeError("DingTalk channel requires a message handler")
    }
    if (this.adapter && this.adapter.state !== "stopped") {
      throw new DingTalkConnectionError(
        "DingTalk channel has already been started",
        { code: "DINGTALK_CHANNEL_ALREADY_STARTED" },
      )
    }

    const { onMessage: _ignored, ...adapterOptions } = this.options
    this.adapter = createDingTalkChannelAdapter({
      ...adapterOptions,
      onMessage: async (transportMessage, context) => {
        const message = {
          id: transportMessage.dedupeKey,
          threadId: transportMessage.threadKey,
          actorId: transportMessage.actorKey,
          text: transportMessage.text,
          channel: "dingtalk",
          metadata: {
            messageType: transportMessage.messageType,
            quotedText: transportMessage.quotedText,
          },
        }
        this.replyTargets.set(message.id, {
          reply: context.reply,
          at: buildSenderAt(transportMessage.sender),
        })
        try {
          return await handler(message)
        } finally {
          this.replyTargets.delete(message.id)
        }
      },
    })
    await this.adapter.start()
    return this
  }

  async reply(message, result) {
    const target = this.replyTargets.get(message?.id)
    if (!target?.reply) {
      throw new DingTalkConnectionError(
        "DingTalk reply target is unavailable",
        { code: "DINGTALK_REPLY_TARGET_UNAVAILABLE" },
      )
    }
    const text = formatRuntimeReply(result)
    if (!text) {
      throw new TypeError("DingTalk reply requires an answer or escalation message")
    }
    return target.reply.replyText(text, target.at)
  }

  async stop() {
    try {
      await this.adapter?.stop()
    } finally {
      this.replyTargets.clear()
    }
  }

  get state() {
    return this.adapter?.state ?? "idle"
  }
}

/**
 * Lazy loader keeps dingtalk-stream optional for offline tests and other
 * channel-only installations.
 */
export async function loadDingTalkStreamSdk(
  importer = () => import("dingtalk-stream"),
) {
  try {
    return await importer()
  } catch (error) {
    throw new DingTalkDependencyError(
      "The optional dingtalk-stream dependency is required to start this channel",
      {
        code: "DINGTALK_STREAM_DEPENDENCY_MISSING",
        cause: error,
      },
    )
  }
}

/**
 * Create a DingTalk Stream channel adapter.
 *
 * Tests may inject sdk, client, clientFactory, fetchImpl, clocks, and sleep.
 */
export function createDingTalkChannelAdapter(options = {}) {
  const {
    clientId,
    clientSecret,
    sdk: injectedSdk,
    client: injectedClient,
    clientFactory,
    sdkLoader = loadDingTalkStreamSdk,
    onMessage,
    onError,
    logger,
    fetchImpl = globalThis.fetch,
    dedupe = createDingTalkDedupeCache(options.dedupeOptions),
    replierOptions = {},
    supervisorOptions = {},
  } = options

  if (typeof onMessage !== "function") {
    throw new TypeError("onMessage must be a function")
  }
  if (!dedupe || typeof dedupe.claim !== "function") {
    throw new TypeError("dedupe.claim must be a function")
  }

  let state = "idle"
  let client = null
  let sdk = null
  let supervisor = null
  let unsubscribe = null
  let listener = null

  async function start() {
    if (state === "running") return adapter
    if (state !== "idle") {
      throw new DingTalkConnectionError(
        `DingTalk channel cannot start from state ${state}`,
        { code: "DINGTALK_CHANNEL_INVALID_STATE" },
      )
    }
    state = "starting"

    try {
      sdk = injectedSdk ?? (
        (injectedClient || clientFactory) && options.topic
          ? {}
          : await sdkLoader()
      )
      client = injectedClient ?? createClient({
        sdk,
        clientId,
        clientSecret,
        clientFactory,
      })

      const topic = options.topic ?? sdk?.TOPIC_ROBOT
      if (typeof client.registerCallbackListener !== "function") {
        throw new DingTalkDependencyError(
          "DingTalk Stream client does not support callback listeners",
          { code: "DINGTALK_STREAM_CLIENT_INCOMPATIBLE" },
        )
      }
      if (topic === undefined || topic === null || topic === "") {
        throw new DingTalkDependencyError(
          "DingTalk Stream robot topic is unavailable",
          { code: "DINGTALK_STREAM_TOPIC_UNAVAILABLE" },
        )
      }

      listener = async (envelope) => {
        acknowledgeEnvelope(client, envelope, {
          successAck: options.successAck ?? sdk?.EventAck?.SUCCESS,
          onError: (error) => reportError(error, "ack"),
        })
        supervisor?.markAlive()
        if (state !== "running" && state !== "starting") return

        try {
          const message = normalizeDingTalkMessage(envelope)
          if (!dedupe.claim(message.dedupeKey)) {
            safeLog(logger, "debug", "dingtalk.message.duplicate")
            return
          }

          let reply = null
          if (message.reply.sessionWebhook) {
            try {
              reply = createDingTalkReplier({
                webhookUrl: message.reply.sessionWebhook,
                fetchImpl,
                logger,
                ...replierOptions,
              })
            } catch (error) {
              reportError(error, "reply-target")
            }
          }

          await onMessage(message, { reply })
          safeLog(logger, "debug", "dingtalk.message.handled")
        } catch (error) {
          reportError(error, "message")
        }
      }

      const registration = client.registerCallbackListener(topic, listener)
      if (typeof registration === "function") unsubscribe = registration

      supervisor = createDingTalkStreamSupervisor(client, {
        logger,
        onError: (error, context) => {
          reportError(error, context?.stage ?? "connection")
        },
        ...supervisorOptions,
      })
      await supervisor.start()
      state = "running"
      safeLog(logger, "info", "dingtalk.channel.started")
      return adapter
    } catch (error) {
      state = "failed"
      try {
        await supervisor?.stop()
      } catch {}
      safeUnsubscribe()
      reportError(error, "start")
      throw error
    }
  }

  async function stop() {
    if (state === "stopped") return
    state = "stopping"
    safeUnsubscribe()
    try {
      await supervisor?.stop()
    } finally {
      listener = null
      state = "stopped"
      dedupe.clear?.()
      safeLog(logger, "info", "dingtalk.channel.stopped")
    }
  }

  function reportError(error, stage) {
    safeLog(logger, "error", "dingtalk.channel.error", {
      stage,
      errorCode: safeErrorCode(error),
    })
    try {
      onError?.(error, { stage })
    } catch {}
  }

  function safeUnsubscribe() {
    if (unsubscribe) {
      try {
        unsubscribe()
      } catch {}
      unsubscribe = null
      return
    }
    if (listener && typeof client?.unregisterCallbackListener === "function") {
      try {
        client.unregisterCallbackListener(options.topic ?? sdk?.TOPIC_ROBOT, listener)
      } catch {}
      return
    }
    if (listener && typeof client?.off === "function") {
      try {
        client.off(options.topic ?? sdk?.TOPIC_ROBOT, listener)
      } catch {}
      return
    }
    if (listener && typeof client?.removeListener === "function") {
      try {
        client.removeListener(options.topic ?? sdk?.TOPIC_ROBOT, listener)
      } catch {}
    }
  }

  const adapter = {
    start,
    stop,
    get state() {
      return state
    },
    get client() {
      return client
    },
  }
  return adapter
}

function createClient({ sdk, clientId, clientSecret, clientFactory }) {
  if (!clientId || !clientSecret) {
    throw new DingTalkDependencyError(
      "DingTalk client credentials are required when no client is injected",
      { code: "DINGTALK_CREDENTIALS_MISSING" },
    )
  }
  const factory = clientFactory ?? (
    typeof sdk?.DWClient === "function"
      ? (config) => new sdk.DWClient(config)
      : null
  )
  if (!factory) {
    throw new DingTalkDependencyError(
      "DingTalk Stream client constructor is unavailable",
      { code: "DINGTALK_STREAM_CLIENT_UNAVAILABLE" },
    )
  }
  return factory({
    clientId,
    clientSecret,
    autoReconnect: false,
    keepAlive: true,
    debug: false,
  })
}

function acknowledgeEnvelope(client, envelope, options) {
  const messageId = envelope?.headers?.messageId ?? envelope?.headers?.messageid
  if (!messageId || typeof client.socketCallBackResponse !== "function") return
  try {
    const result = client.socketCallBackResponse(messageId, options.successAck)
    Promise.resolve(result).catch(options.onError)
  } catch (error) {
    options.onError(error)
  }
}

function buildSenderAt(sender) {
  if (sender?.userId) return { atUserIds: [sender.userId] }
  if (sender?.encryptedId) return { atDingtalkIds: [sender.encryptedId] }
  return {}
}

function formatRuntimeReply(result) {
  const answer = typeof result?.answer === "string" && result.answer.trim()
    ? result.answer.trim()
    : typeof result?.escalation?.message === "string"
      ? result.escalation.message.trim()
      : ""
  if (!answer) return ""

  const citations = Array.isArray(result?.citations)
    ? result.citations
      .map((citation) => {
        const label = firstNonEmptyString(citation?.label, citation?.title, citation?.id)
        const uri = firstNonEmptyString(citation?.uri)
        if (!label && !uri) return null
        if (label && uri) return `- ${label}: ${uri}`
        return `- ${label ?? uri}`
      })
      .filter(Boolean)
    : []
  return citations.length > 0
    ? `${answer}\n\nReferences:\n${citations.join("\n")}`
    : answer
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

function safeErrorCode(error) {
  if (typeof error?.code === "string" && error.code.length > 0) {
    return error.code
  }
  return "DINGTALK_UNKNOWN_ERROR"
}

function safeLog(logger, level, event, details) {
  try {
    logger?.[level]?.(event, details)
  } catch {}
}
