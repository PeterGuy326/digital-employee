export const DEFAULT_STREAM_WATCHDOG_INTERVAL_MS = 30_000
export const DEFAULT_STREAM_STALE_AFTER_MS = 3 * 60_000
export const DEFAULT_STREAM_WAKE_DRIFT_MS = 60_000
export const DEFAULT_STREAM_CONNECT_TIMEOUT_MS = 20_000
export const DEFAULT_STREAM_RECONNECT_ATTEMPTS = 3
export const DEFAULT_STREAM_RECONNECT_BACKOFF_MS = 5_000

export class DingTalkConnectionError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = "DingTalkConnectionError"
    this.code = options.code ?? "DINGTALK_CONNECTION_ERROR"
    this.attempts = options.attempts ?? null
  }
}

/**
 * Add lifecycle, activity tracking, timeout, and bounded reconnect behavior to
 * an injected dingtalk-stream client without importing SDK internals.
 */
export function createDingTalkStreamSupervisor(client, options = {}) {
  if (!client || typeof client.connect !== "function") {
    throw new TypeError("client.connect must be a function")
  }

  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const logger = options.logger
  const onError = options.onError
  const startTimer = options.startTimer !== false
  const watchdogIntervalMs =
    options.watchdogIntervalMs ?? DEFAULT_STREAM_WATCHDOG_INTERVAL_MS
  const staleAfterMs =
    options.staleAfterMs ?? DEFAULT_STREAM_STALE_AFTER_MS
  const wakeDriftMs =
    options.wakeDriftMs ?? DEFAULT_STREAM_WAKE_DRIFT_MS
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_STREAM_CONNECT_TIMEOUT_MS
  const reconnectAttempts =
    options.reconnectAttempts ?? DEFAULT_STREAM_RECONNECT_ATTEMPTS
  const reconnectBackoffMs =
    options.reconnectBackoffMs ?? DEFAULT_STREAM_RECONNECT_BACKOFF_MS
  const setIntervalImpl = options.setIntervalImpl ?? setInterval
  const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval

  if (typeof now !== "function") throw new TypeError("now must be a function")
  if (typeof sleep !== "function") throw new TypeError("sleep must be a function")
  requirePositiveInteger(watchdogIntervalMs, "watchdogIntervalMs")
  requirePositiveInteger(staleAfterMs, "staleAfterMs")
  requireNonNegativeInteger(wakeDriftMs, "wakeDriftMs")
  requirePositiveInteger(connectTimeoutMs, "connectTimeoutMs")
  requirePositiveInteger(reconnectAttempts, "reconnectAttempts")
  requireNonNegativeInteger(reconnectBackoffMs, "reconnectBackoffMs")

  let stopped = false
  let started = false
  let timer = null
  let reconnectPromise = null
  let connectPromise = null
  let generation = 0
  let lastAliveAt = now()
  let lastTickAt = lastAliveAt
  const restorers = []

  wrapActivityMethod("heartbeat")
  wrapActivityMethod("onDownStream")

  function markAlive() {
    if (!stopped) lastAliveAt = now()
  }

  async function connectOnce() {
    if (stopped) {
      throw new DingTalkConnectionError("DingTalk Stream supervisor is stopped", {
        code: "DINGTALK_STREAM_STOPPED",
      })
    }
    if (connectPromise) return connectPromise

    const currentGeneration = generation
    connectPromise = (async () => {
      await withTimeout(
        Promise.resolve().then(() => client.connect()),
        connectTimeoutMs,
      )
      if (stopped || generation !== currentGeneration) {
        safeDisconnect(client)
        throw new DingTalkConnectionError(
          "DingTalk Stream connection was superseded",
          { code: "DINGTALK_CONNECT_SUPERSEDED" },
        )
      }
      if (typeof client.connected === "boolean" && !client.connected) {
        throw new DingTalkConnectionError(
          "DingTalk Stream client did not become connected",
          { code: "DINGTALK_CONNECT_UNCONFIRMED" },
        )
      }
      markAlive()
      lastTickAt = now()
    })()

    try {
      return await connectPromise
    } catch (error) {
      if (error instanceof DingTalkConnectionError) throw error
      throw new DingTalkConnectionError("DingTalk Stream connect failed", {
        code: error?.code === "DINGTALK_CONNECT_TIMEOUT"
          ? error.code
          : "DINGTALK_CONNECT_FAILED",
        cause: error,
      })
    } finally {
      connectPromise = null
    }
  }

  async function start() {
    if (started && !stopped) return
    if (stopped) {
      throw new DingTalkConnectionError(
        "A stopped DingTalk Stream supervisor cannot be restarted",
        { code: "DINGTALK_STREAM_STOPPED" },
      )
    }

    await connectOnce()
    started = true
    if (startTimer && timer === null) {
      timer = setIntervalImpl(() => {
        void watchdogTick().catch((error) => reportError(error, "watchdog"))
      }, watchdogIntervalMs)
      timer?.unref?.()
    }
    safeLog(logger, "info", "dingtalk.stream.connected")
  }

  async function forceReconnect(trigger = "manual") {
    if (stopped) return false
    if (reconnectPromise) return reconnectPromise

    reconnectPromise = (async () => {
      generation++
      safeDisconnect(client)
      safeLog(logger, "warn", "dingtalk.stream.reconnecting", { trigger })

      let lastError = null
      for (let attempt = 1; attempt <= reconnectAttempts; attempt++) {
        if (stopped) return false
        try {
          await connectOnce()
          safeLog(logger, "info", "dingtalk.stream.reconnected", { attempt })
          return true
        } catch (error) {
          lastError = error
          safeLog(logger, "warn", "dingtalk.stream.reconnect_failed", {
            attempt,
            errorCode: safeErrorCode(error),
          })
          safeDisconnect(client)
          if (attempt < reconnectAttempts && reconnectBackoffMs > 0) {
            await sleep(reconnectBackoffMs)
          }
        }
      }

      throw new DingTalkConnectionError(
        "DingTalk Stream reconnect attempts were exhausted",
        {
          code: "DINGTALK_RECONNECT_EXHAUSTED",
          attempts: reconnectAttempts,
          cause: lastError,
        },
      )
    })()

    try {
      return await reconnectPromise
    } finally {
      reconnectPromise = null
    }
  }

  async function watchdogTick() {
    if (stopped || reconnectPromise) return false
    const timestamp = now()
    const drift = timestamp - lastTickAt - watchdogIntervalMs
    const staleFor = timestamp - lastAliveAt
    lastTickAt = timestamp

    if (typeof client.connected === "boolean" && !client.connected) {
      return forceReconnect("disconnected")
    }
    if (drift > wakeDriftMs) {
      return forceReconnect("wake-drift")
    }
    if (staleFor > staleAfterMs) {
      return forceReconnect("activity-timeout")
    }
    return false
  }

  async function stop() {
    if (stopped) return
    stopped = true
    generation++
    if (timer !== null) {
      clearIntervalImpl(timer)
      timer = null
    }
    for (const restore of restorers.splice(0)) restore()
    safeDisconnect(client)
    safeLog(logger, "info", "dingtalk.stream.stopped")
  }

  function wrapActivityMethod(name) {
    if (typeof client[name] !== "function") return
    const original = client[name]
    const wrapped = function wrappedActivityMethod(...args) {
      markAlive()
      return Reflect.apply(original, this, args)
    }
    client[name] = wrapped
    restorers.push(() => {
      if (client[name] === wrapped) client[name] = original
    })
  }

  function reportError(error, stage) {
    safeLog(logger, "error", "dingtalk.stream.error", {
      stage,
      errorCode: safeErrorCode(error),
    })
    try {
      onError?.(error, { stage })
    } catch {}
  }

  return {
    start,
    stop,
    connect: connectOnce,
    forceReconnect,
    watchdogTick,
    markAlive,
    get state() {
      if (stopped) return "stopped"
      if (reconnectPromise) return "reconnecting"
      if (started) return "running"
      return "idle"
    },
    get lastAliveAt() {
      return lastAliveAt
    },
  }
}

function withTimeout(promise, timeoutMs) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new DingTalkConnectionError(
        `DingTalk Stream connect timed out after ${timeoutMs}ms`,
        { code: "DINGTALK_CONNECT_TIMEOUT" },
      ))
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function safeDisconnect(client) {
  try {
    const result = client.disconnect?.()
    if (result && typeof result.catch === "function") {
      result.catch(() => {})
    }
    return result
  } catch {
    return undefined
  }
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

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}
