import { CoreError } from "./contracts.js"
import {
  validateAgentHostEventWire,
  validateAgentHostProbeWire,
  validateAgentHostRunRequestWire,
} from "./agent-host-wire.js"
import type {
  AgentHostEvent,
  AgentHostProbeResult,
  AgentHostRunRequest,
} from "./agent-host.js"

/**
 * Versioned stdio/JSONL protocol for external Agent Host Adapters
 * (Issue #33 R1 freeze). Stdout carries protocol messages only; diagnostics
 * go to stderr. Every unknown version or field fails closed.
 */
export const AGENT_HOST_STDIO_PROTOCOL_VERSION = "agent-host-stdio.v1"

export const AGENT_HOST_STDIO_MAX_LINE_BYTES = 1_048_576

const STDIO_ERROR_CODES = {
  badFraming: "agent_host_stdio_bad_framing",
  protocolMismatch: "agent_host_stdio_protocol_mismatch",
  unknownMessage: "agent_host_stdio_unknown_message",
  badResponse: "agent_host_stdio_bad_response",
  hostError: "agent_host_stdio_host_error",
} as const

export const AGENT_HOST_STDIO_ERROR_CODES = STDIO_ERROR_CODES

function stdioError(
  code: string,
  message: string,
  details?: unknown,
): CoreError {
  return new CoreError(code, message, {
    status: 400,
    retryable: false,
    details,
  })
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
}

export type AgentHostStdioRequestKind = "probe" | "preflight" | "run" | "cancel"

export interface AgentHostStdioRequest {
  protocol: typeof AGENT_HOST_STDIO_PROTOCOL_VERSION
  id: string
  kind: AgentHostStdioRequestKind
  payload?: AgentHostRunRequest | { runId: string }
}

export type AgentHostStdioMessage =
  | AgentHostStdioRequest
  | {
      protocol: typeof AGENT_HOST_STDIO_PROTOCOL_VERSION
      id: string
      kind: "response"
      ok: true
      result?: unknown
    }
  | {
      protocol: typeof AGENT_HOST_STDIO_PROTOCOL_VERSION
      id: string
      kind: "response"
      ok: false
      error: { code: string; message: string; retryable: boolean }
    }
  | {
      protocol: typeof AGENT_HOST_STDIO_PROTOCOL_VERSION
      id: string
      kind: "event"
      event: AgentHostEvent
    }

/**
 * Serializes one protocol message as a single JSONL line. The message must
 * already be validated; encoding never repairs malformed input.
 */
export function encodeAgentHostStdioLine(message: unknown): string {
  const text = JSON.stringify(message)
  if (text === undefined) {
    throw stdioError(
      STDIO_ERROR_CODES.badFraming,
      "stdio protocol message is not serializable",
    )
  }
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes > AGENT_HOST_STDIO_MAX_LINE_BYTES) {
    throw stdioError(
      STDIO_ERROR_CODES.badFraming,
      "stdio protocol message exceeds the line bound",
      { bound: AGENT_HOST_STDIO_MAX_LINE_BYTES, bytes },
    )
  }
  return text
}

function parseLine(line: string): unknown {
  const text = line.trim()
  if (text.length === 0) {
    throw stdioError(
      STDIO_ERROR_CODES.badFraming,
      "stdio line must carry exactly one JSON message",
    )
  }
  if (Buffer.byteLength(text, "utf8") > AGENT_HOST_STDIO_MAX_LINE_BYTES) {
    throw stdioError(
      STDIO_ERROR_CODES.badFraming,
      "stdio protocol message exceeds the line bound",
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    throw stdioError(
      STDIO_ERROR_CODES.badFraming,
      "stdio line is not valid JSON",
    )
  }
}

function checkEnvelope(value: unknown): Record<string, unknown> {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["protocol", "id", "kind", "payload", "ok", "result", "error", "event"])
  ) {
    throw stdioError(
      STDIO_ERROR_CODES.unknownMessage,
      "stdio message carries unknown fields",
    )
  }
  if (value.protocol !== AGENT_HOST_STDIO_PROTOCOL_VERSION) {
    throw stdioError(
      STDIO_ERROR_CODES.protocolMismatch,
      `stdio protocol must be ${AGENT_HOST_STDIO_PROTOCOL_VERSION}`,
    )
  }
  if (!boundedId(value.id)) {
    throw stdioError(
      STDIO_ERROR_CODES.unknownMessage,
      "stdio message id is invalid",
    )
  }
  return value
}

const REQUEST_KINDS = new Set(["probe", "preflight", "run", "cancel"])

/** Fail-closed parser for one request line spoken by the outer runtime. */
export function parseAgentHostStdioRequest(line: string): AgentHostStdioRequest {
  const value = checkEnvelope(parseLine(line))
  const allowed = ["protocol", "id", "kind", "payload"]
  if (
    !exactKeys(value, allowed) ||
    typeof value.kind !== "string" ||
    !REQUEST_KINDS.has(value.kind)
  ) {
    throw stdioError(
      STDIO_ERROR_CODES.unknownMessage,
      "stdio request kind is invalid",
    )
  }
  if (value.kind === "run" || value.kind === "preflight") {
    validateAgentHostRunRequestWire(value.payload)
  } else if (value.kind === "cancel") {
    const payload = value.payload
    if (
      !plainRecord(payload) ||
      !exactKeys(payload, ["runId"]) ||
      typeof payload.runId !== "string" ||
      payload.runId.length === 0 ||
      payload.runId.length > 256
    ) {
      throw stdioError(
        STDIO_ERROR_CODES.unknownMessage,
        "stdio cancel request must carry exactly one runId",
      )
    }
  } else if (value.payload !== undefined) {
    throw stdioError(
      STDIO_ERROR_CODES.unknownMessage,
      "stdio request payload is not allowed for this kind",
    )
  }
  return value as unknown as AgentHostStdioRequest
}

/**
 * Fail-closed parser for one line spoken by an external Adapter. Validates
 * the envelope and every embedded agent-host.v1 shape (probe result, run
 * request echo, native event) so a misbehaving Adapter cannot inject
 * unvalidated wire data.
 */
export function parseAgentHostStdioHostLine(
  line: string,
  expectedHostId: string,
): AgentHostStdioMessage {
  const value = checkEnvelope(parseLine(line))
  const kind = value.kind
  if (kind === "event") {
    if (!exactKeys(value, ["protocol", "id", "kind", "event"])) {
      throw stdioError(
        STDIO_ERROR_CODES.unknownMessage,
        "stdio event message carries unknown fields",
      )
    }
    const event = validateAgentHostEventWire(value.event)
    return {
      protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
      id: value.id as string,
      kind: "event",
      event,
    }
  }
  if (kind !== "response") {
    throw stdioError(
      STDIO_ERROR_CODES.unknownMessage,
      "stdio host line must be a response or event",
    )
  }
  if (value.ok === true) {
    if (!exactKeys(value, ["protocol", "id", "kind", "ok", "result"])) {
      throw stdioError(
        STDIO_ERROR_CODES.badResponse,
        "stdio success response carries unknown fields",
      )
    }
    if (value.result !== undefined && !plainRecord(value.result)) {
      throw stdioError(
        STDIO_ERROR_CODES.badResponse,
        "stdio success result must be an object",
      )
    }
    return value as unknown as AgentHostStdioMessage
  }
  if (value.ok !== false) {
    throw stdioError(
      STDIO_ERROR_CODES.badResponse,
      "stdio response must carry a boolean ok flag",
    )
  }
  if (!exactKeys(value, ["protocol", "id", "kind", "ok", "error"])) {
    throw stdioError(
      STDIO_ERROR_CODES.badResponse,
      "stdio error response carries unknown fields",
    )
  }
  const error = value.error
  if (
    !plainRecord(error) ||
    !exactKeys(error, ["code", "message", "retryable"]) ||
    typeof error.code !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(error.code) ||
    typeof error.message !== "string" ||
    error.message.length > 4096 ||
    typeof error.retryable !== "boolean"
  ) {
    throw stdioError(
      STDIO_ERROR_CODES.badResponse,
      "stdio error response is malformed",
    )
  }
  return value as unknown as AgentHostStdioMessage
}

/** Extracts a validated probe result from a success response. */
export function probeResultFromStdioResponse(
  message: AgentHostStdioMessage,
  expectedHostId: string,
): AgentHostProbeResult {
  if (message.kind !== "response") {
    throw stdioError(
      STDIO_ERROR_CODES.badResponse,
      "stdio probe exchange expected a response",
    )
  }
  if (message.ok !== true) {
    const error = message.error
    throw stdioError(
      STDIO_ERROR_CODES.hostError,
      "agent host refused the probe exchange",
      { code: error.code, retryable: error.retryable },
    )
  }
  return validateAgentHostProbeWire(message.result, expectedHostId)
}
