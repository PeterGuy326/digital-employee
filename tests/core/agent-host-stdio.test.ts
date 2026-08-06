import assert from "node:assert/strict"
import test from "node:test"

import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/src/agent-host.js"
import type { AgentHostRunRequest } from "../../packages/core/src/agent-host.js"
import {
  AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION,
  stdioAdapterEnvironment,
  validateStdioAdapterConfig,
} from "../../packages/core/src/agent-host-stdio-config.js"
import {
  AGENT_HOST_STDIO_MAX_LINE_BYTES,
  AGENT_HOST_STDIO_PROTOCOL_VERSION,
  encodeAgentHostStdioLine,
  parseAgentHostStdioHostLine,
  parseAgentHostStdioRequest,
  probeResultFromStdioResponse,
} from "../../packages/core/src/agent-host-stdio.js"

const RUN_REQUEST: AgentHostRunRequest = {
  runId: "run-1",
  employeeId: "employee-1",
  workingDirectory: "/tmp/employee",
  prompt: "hello",
  policy: {
    tools: { default: "deny", allow: [{ name: "noop", mode: "read" }] },
    filesystem: { read: ["."], write: [] },
    network: { mode: "deny", hosts: [] },
    approval: { mode: "never" },
    maxTurns: 4,
  },
}

function code(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as { code: unknown }).code)
    : ""
}

test("run and cancel requests round-trip through the JSONL wire", () => {
  const runLine = encodeAgentHostStdioLine({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id: "exchange-1",
    kind: "run",
    payload: RUN_REQUEST,
  })
  const run = parseAgentHostStdioRequest(runLine)
  assert.equal(run.kind, "run")
  assert.deepEqual(run.payload, RUN_REQUEST)

  const cancelLine = encodeAgentHostStdioLine({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id: "exchange-2",
    kind: "cancel",
    payload: { runId: "run-1" },
  })
  const cancel = parseAgentHostStdioRequest(cancelLine)
  assert.equal(cancel.kind, "cancel")
  assert.deepEqual(cancel.payload, { runId: "run-1" })
})

test("probe requests must not carry a payload", () => {
  const line = encodeAgentHostStdioLine({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id: "exchange-3",
    kind: "probe",
    payload: { runId: "unexpected" },
  })
  assert.throws(
    () => parseAgentHostStdioRequest(line),
    (error: unknown) => code(error) === "agent_host_stdio_unknown_message",
  )
})

test("cancel requests require exactly one bounded runId", () => {
  const line = encodeAgentHostStdioLine({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id: "exchange-4",
    kind: "cancel",
    payload: { runId: "run-1", extra: true },
  })
  assert.throws(
    () => parseAgentHostStdioRequest(line),
    (error: unknown) => code(error) === "agent_host_stdio_unknown_message",
  )
})

test("unknown protocol versions and fields fail closed", () => {
  const wrongVersion = JSON.stringify({
    protocol: "agent-host-stdio.v2",
    id: "exchange-5",
    kind: "probe",
  })
  assert.throws(
    () => parseAgentHostStdioRequest(wrongVersion),
    (error: unknown) =>
      code(error) === "agent_host_stdio_protocol_mismatch",
  )
  const unknownField = JSON.stringify({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id: "exchange-6",
    kind: "probe",
    escalation: true,
  })
  assert.throws(
    () => parseAgentHostStdioRequest(unknownField),
    (error: unknown) => code(error) === "agent_host_stdio_unknown_message",
  )
})

test("malformed framing fails closed", () => {
  assert.throws(
    () => parseAgentHostStdioRequest("not-json"),
    (error: unknown) => code(error) === "agent_host_stdio_bad_framing",
  )
  assert.throws(
    () => parseAgentHostStdioRequest("   "),
    (error: unknown) => code(error) === "agent_host_stdio_bad_framing",
  )
  assert.throws(
    () =>
      encodeAgentHostStdioLine({
        protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
        id: "exchange-7",
        kind: "run",
        payload: { prompt: "x".repeat(AGENT_HOST_STDIO_MAX_LINE_BYTES) },
      }),
    (error: unknown) => code(error) === "agent_host_stdio_bad_framing",
  )
})

test("host events are validated against the agent-host.v1 wire", () => {
  const good = encodeAgentHostStdioLine({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id: "exchange-8",
    kind: "event",
    event: {
      type: "run.started",
      runId: "run-1",
      timestamp: "2026-08-06T03:00:00.000Z",
    },
  })
  const parsed = parseAgentHostStdioHostLine(good, "reference-stdio-host")
  assert.equal(parsed.kind, "event")

  const malformedEvent = encodeAgentHostStdioLine({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id: "exchange-9",
    kind: "event",
    event: {
      type: "run.started",
      runId: "run-1",
      timestamp: "2026-08-06T03:00:00.000Z",
      secretField: "leak",
    },
  })
  assert.throws(
    () => parseAgentHostStdioHostLine(malformedEvent, "reference-stdio-host"),
    (error: unknown) => code(error) === "agent_host_stream_failed",
  )
})

test("host responses distinguish success and structured failure", () => {
  const success = encodeAgentHostStdioLine({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id: "exchange-10",
    kind: "response",
    ok: true,
    result: { hello: true },
  })
  assert.equal(
    parseAgentHostStdioHostLine(success, "reference-stdio-host").kind,
    "response",
  )
  const failure = encodeAgentHostStdioLine({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id: "exchange-11",
    kind: "response",
    ok: false,
    error: {
      code: "agent_host_preflight_invalid",
      message: "refused",
      retryable: false,
    },
  })
  const parsed = parseAgentHostStdioHostLine(failure, "reference-stdio-host")
  assert.equal(parsed.kind, "response")
  assert.equal("ok" in parsed && parsed.ok, false)

  const malformed = encodeAgentHostStdioLine({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id: "exchange-12",
    kind: "response",
    ok: false,
    error: { code: "BAD CODE", message: "x", retryable: false },
  })
  assert.throws(
    () => parseAgentHostStdioHostLine(malformed, "reference-stdio-host"),
    (error: unknown) => code(error) === "agent_host_stdio_bad_response",
  )
})

test("probe results are bound to the expected host identity", () => {
  const capabilities = createUnknownAgentHostCapabilities()
  const probe = {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    hostId: "reference-stdio-host",
    displayName: "Reference Stdio Host",
    status: "ready",
    available: true,
    adapterStatus: "runnable",
    capabilities,
    capabilitySource: "conformance_test",
    issues: [],
  }
  const response = parseAgentHostStdioHostLine(
    encodeAgentHostStdioLine({
      protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
      id: "exchange-13",
      kind: "response",
      ok: true,
      result: probe,
    }),
    "reference-stdio-host",
  )
  assert.equal(
    probeResultFromStdioResponse(response, "reference-stdio-host").hostId,
    "reference-stdio-host",
  )
  assert.throws(
    () => probeResultFromStdioResponse(response, "other-host"),
    (error: unknown) => code(error) === "AGENT_HOST_PROBE_INVALID",
  )
})

const VALID_CONFIG = {
  schema: AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION,
  hostId: "reference-stdio-host",
  displayName: "Reference Stdio Host",
  executable: "/opt/hosts/reference-host",
  args: ["serve", "--protocol", AGENT_HOST_STDIO_PROTOCOL_VERSION],
  digest: { algorithm: "sha256", hex: "a".repeat(64) },
  envAllowlist: ["PATH", "HOME"],
  workingDirectoryPolicy: "request",
  timeoutMs: 10_000,
  maxStderrBytes: 16_384,
}

test("explicit digest-pinned configuration is accepted", () => {
  const config = validateStdioAdapterConfig(VALID_CONFIG)
  assert.equal(config.hostId, "reference-stdio-host")
  assert.deepEqual(config.args, [
    "serve",
    "--protocol",
    AGENT_HOST_STDIO_PROTOCOL_VERSION,
  ])
})

test("configuration candidates with scanning or expansion are rejected", () => {
  const variants: Array<Record<string, unknown>> = [
    { executable: "/opt/hosts/*" },
    { executable: "/opt/hosts/$NAME" },
    { executable: "`whoami`" },
    { args: ["$(whoami)"] },
    { args: ["--flag;rm"] },
    { envAllowlist: ["*"] },
    { envAllowlist: ["PATH", "PATH"] },
    { digest: { algorithm: "md5", hex: "a".repeat(64) } },
    { digest: { algorithm: "sha256", hex: "nothex" } },
    { workingDirectoryPolicy: "scan" },
    { timeoutMs: 10 },
    { maxStderrBytes: 999_999_999 },
    { schema: "agent-host-stdio-config.v0" },
    { discoveredFrom: "node_modules" },
  ]
  for (const variant of variants) {
    assert.throws(
      () => validateStdioAdapterConfig({ ...VALID_CONFIG, ...variant }),
      (error: unknown) => code(error) === "AGENT_HOST_STDIO_CONFIG_INVALID",
      JSON.stringify(variant),
    )
  }
})

test("only allowlisted environment variables are propagated", () => {
  const config = validateStdioAdapterConfig(VALID_CONFIG)
  const environment = stdioAdapterEnvironment(config, {
    PATH: "/usr/bin",
    HOME: "/home/operator",
    SECRET_TOKEN: "do-not-propagate",
    path: "lowercase-not-listed",
  })
  assert.deepEqual(environment, { PATH: "/usr/bin", HOME: "/home/operator" })
})
