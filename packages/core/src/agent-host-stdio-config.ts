import { CoreError } from "./contracts.js"

/**
 * Explicit local configuration for an external stdio Agent Host Adapter
 * (Issue #33 REQ-002). The operator pins exactly one executable with a
 * sha256 digest; the model never scans directories and never lets an
 * employee package select executable code.
 */
export const AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION =
  "agent-host-stdio-config.v1" as const

const CONFIG_ERROR = "AGENT_HOST_STDIO_CONFIG_INVALID"

const HOST_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/
const HEX_64_PATTERN = /^[0-9a-f]{64}$/
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/

export interface StdioAdapterConfig {
  schema: typeof AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION
  hostId: string
  displayName: string
  executable: string
  args: readonly string[]
  digest: { algorithm: "sha256"; hex: string }
  envAllowlist: readonly string[]
  workingDirectoryPolicy: "request" | "config_directory"
  timeoutMs: number
  maxStderrBytes: number
}

function configError(message: string, details?: unknown): CoreError {
  return new CoreError(CONFIG_ERROR, message, {
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

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
}

const CONFIG_KEYS = Object.freeze([
  "schema",
  "hostId",
  "displayName",
  "executable",
  "args",
  "digest",
  "envAllowlist",
  "workingDirectoryPolicy",
  "timeoutMs",
  "maxStderrBytes",
])

function rejectsExpansion(text: string): boolean {
  // No shell expansion, interpolation or globbing may hide in a pinned value.
  return !/[$`~*?{}[\]<>|&;]/.test(text)
}

/**
 * Validates an explicit Adapter configuration candidate. Directory scanning,
 * package-selected executables and out-of-allowlist environment propagation
 * are rejected; only a digest-pinned executable with fixed literal
 * arguments is accepted.
 */
export function validateStdioAdapterConfig(
  value: unknown,
): StdioAdapterConfig {
  if (!plainRecord(value)) {
    throw configError("stdio adapter config must be an object")
  }
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw configError(`unknown stdio adapter config field: ${key}`)
    }
  }
  if (value.schema !== AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION) {
    throw configError(
      `schema must be ${AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION}`,
    )
  }
  if (
    typeof value.hostId !== "string" ||
    !HOST_ID_PATTERN.test(value.hostId)
  ) {
    throw configError("hostId must be a lowercase ASCII identifier")
  }
  if (!boundedString(value.displayName, 256)) {
    throw configError("displayName is required")
  }
  if (
    !boundedString(value.executable, 2048) ||
    !rejectsExpansion(value.executable)
  ) {
    throw configError(
      "executable must be one explicit literal path without glob or shell expansion",
    )
  }
  if (!Array.isArray(value.args) || value.args.length > 64) {
    throw configError("args must be a fixed literal array (max 64)")
  }
  for (const arg of value.args) {
    if (!boundedString(arg, 2048) || !rejectsExpansion(arg)) {
      throw configError("every argument must be a fixed literal string")
    }
  }
  const digest = value.digest
  if (
    !plainRecord(digest) ||
    Object.keys(digest).some((key) => !["algorithm", "hex"].includes(key)) ||
    digest.algorithm !== "sha256" ||
    typeof digest.hex !== "string" ||
    !HEX_64_PATTERN.test(digest.hex)
  ) {
    throw configError("digest must pin the executable with a sha256 hex value")
  }
  if (!Array.isArray(value.envAllowlist) || value.envAllowlist.length > 128) {
    throw configError("envAllowlist must be an explicit array (max 128)")
  }
  const seen = new Set<string>()
  for (const name of value.envAllowlist) {
    if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name) || seen.has(name)) {
      throw configError(
        "envAllowlist entries must be unique UPPER_SNAKE names; no wildcard or bulk propagation",
      )
    }
    seen.add(name)
  }
  if (
    value.workingDirectoryPolicy !== "request" &&
    value.workingDirectoryPolicy !== "config_directory"
  ) {
    throw configError("workingDirectoryPolicy must be explicit")
  }
  if (
    typeof value.timeoutMs !== "number" ||
    !Number.isInteger(value.timeoutMs) ||
    value.timeoutMs < 1_000 ||
    value.timeoutMs > 600_000
  ) {
    throw configError("timeoutMs must be an integer between 1000 and 600000")
  }
  if (
    typeof value.maxStderrBytes !== "number" ||
    !Number.isInteger(value.maxStderrBytes) ||
    value.maxStderrBytes < 1024 ||
    value.maxStderrBytes > 262_144
  ) {
    throw configError("maxStderrBytes must be an integer between 1024 and 262144")
  }
  return value as unknown as StdioAdapterConfig
}

/**
 * Builds the bounded, allowlist-filtered environment for the Adapter child
 * process. Nothing outside the allowlist is propagated.
 */
export function stdioAdapterEnvironment(
  config: StdioAdapterConfig,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of config.envAllowlist) {
    const entry = source[name]
    if (typeof entry === "string") environment[name] = entry
  }
  return environment
}
