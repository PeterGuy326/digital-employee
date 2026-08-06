import readline from "node:readline"
import { spawn } from "node:child_process"

import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/src/agent-host.js"
import type { AgentHostProbeResult } from "../../packages/core/src/agent-host.js"
import {
  AGENT_HOST_STDIO_PROTOCOL_VERSION,
  encodeAgentHostStdioLine,
  parseAgentHostStdioRequest,
} from "../../packages/core/src/agent-host-stdio.js"
import type { AgentHostStdioRequest } from "../../packages/core/src/agent-host-stdio.js"

export const REFERENCE_STDIO_HOST_ID = "reference-stdio-host"

/**
 * Builds the reference Adapter's probe result. Conformance fixtures vary it
 * only through explicit overrides, never through runtime branching.
 */
export function referenceStdioProbe(
  overrides: {
    hostId?: string
    status?: AgentHostProbeResult["status"]
    adapterStatus?: AgentHostProbeResult["adapterStatus"]
    capabilitySource?: AgentHostProbeResult["capabilitySource"]
    missingCapability?: string
  } = {},
): AgentHostProbeResult {
  const capabilities = createUnknownAgentHostCapabilities()
  capabilities.non_interactive_run = "supported"
  capabilities.event_stream = "supported"
  capabilities.tool_allowlist = "supported"
  capabilities.filesystem_scope = "supported"
  capabilities.network_policy = "supported"
  if (overrides.missingCapability) {
    delete (capabilities as Record<string, unknown>)[overrides.missingCapability]
  }
  return {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    hostId: overrides.hostId ?? REFERENCE_STDIO_HOST_ID,
    displayName: "Reference Stdio Host",
    status: overrides.status ?? "ready",
    available: true,
    adapterStatus: overrides.adapterStatus ?? "runnable",
    version: "1.0.0",
    capabilities,
    capabilitySource: overrides.capabilitySource ?? "conformance_test",
    issues: [],
  }
}

function envFlag(name: string): boolean {
  return process.env[name] === "1"
}

function write(message: unknown): void {
  process.stdout.write(`${encodeAgentHostStdioLine(message)}\n`)
}

function diagnostics(text: string): void {
  // stderr is diagnostics-only and bounded; stdout carries protocol only.
  process.stderr.write(`[reference-stdio-host] ${text}\n`.slice(0, 512))
}

function successResponse(id: string, result?: unknown): void {
  write({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id,
    kind: "response",
    ok: true,
    ...(result === undefined ? {} : { result }),
  })
}

function errorResponse(id: string, code: string): void {
  write({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id,
    kind: "response",
    ok: false,
    error: { code, message: "reference host refused the request", retryable: false },
  })
}

function event(id: string, runId: string, body: Record<string, unknown>): void {
  write({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id,
    kind: "event",
    event: { runId, timestamp: new Date().toISOString(), ...body },
  })
}

/**
 * Serves agent-host-stdio.v1 on this process's stdio. Violation fixtures are
 * selected through REFERENCE_STDIO_* environment flags so each AC-002 path is
 * deterministic and reviewable.
 */
export function serveReferenceStdioHost(): void {
  const lineReader = readline.createInterface({ input: process.stdin })
  let cancelledRunId: string | null = null
  let activeRun: { id: string; runId: string } | null = null

  if (envFlag("REFERENCE_STDIO_SPAWN_CHILD")) {
    // Same process group, unref'd and detached from stdio: it survives the
    // host's own exit, so only a real process-tree cleanup can stop it.
    const leaked = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    )
    leaked.unref()
    diagnostics(`spawned child pid ${leaked.pid ?? 0}`)
  }

  lineReader.on("line", (line) => {
    let request: AgentHostStdioRequest
    try {
      request = parseAgentHostStdioRequest(line)
    } catch (error) {
      diagnostics("rejecting malformed request line")
      errorResponse("unparsed", "agent_host_stdio_bad_framing")
      void error
      return
    }
    switch (request.kind) {
      case "probe": {
        const probe = referenceStdioProbe({
          status: envFlag("REFERENCE_STDIO_NOT_READY")
            ? "not_ready"
            : "ready",
          adapterStatus: envFlag("REFERENCE_STDIO_PROBE_ONLY")
            ? "probe_only"
            : "runnable",
          missingCapability: envFlag("REFERENCE_STDIO_MISSING_CAPABILITY")
            ? "tool_allowlist"
            : undefined,
        })
        if (envFlag("REFERENCE_STDIO_UNKNOWN_FIELD")) {
          write({
            protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
            id: request.id,
            kind: "response",
            ok: true,
            result: { ...probe, extraField: true },
          })
        } else {
          successResponse(request.id, probe)
        }
        return
      }
      case "preflight": {
        const payload = request.payload as { policy?: { filesystem?: { write?: string[] } } }
        const writes = payload.policy?.filesystem?.write ?? []
        if (writes.length > 0 && !envFlag("REFERENCE_STDIO_HOSTILE_WRITE_OK")) {
          errorResponse(request.id, "agent_host_preflight_invalid")
          return
        }
        successResponse(request.id, referenceStdioProbe())
        return
      }
      case "cancel": {
        const payload = request.payload as { runId: string }
        if (!envFlag("REFERENCE_STDIO_REFUSE_CANCEL")) {
          cancelledRunId = payload.runId
          diagnostics(`cancel requested for ${payload.runId}`)
          if (activeRun && activeRun.runId === payload.runId) {
            event(activeRun.id, payload.runId, {
              type: "run.failed",
              error: {
                code: "agent_host_cancelled",
                message: "run cancelled",
                retryable: false,
              },
            })
            successResponse(activeRun.id)
            activeRun = null
          }
        }
        return
      }
      case "run": {
        const payload = request.payload as {
          runId: string
          outputSchema?: unknown
        }
        activeRun = { id: request.id, runId: payload.runId }
        diagnostics(`run started for ${payload.runId}`)
        event(request.id, payload.runId, { type: "run.started" })
        if (envFlag("REFERENCE_STDIO_DISALLOWED_TOOL")) {
          event(request.id, payload.runId, {
            type: "tool.started",
            toolCallId: "call-1",
            toolName: "shell",
          })
        }
        if (envFlag("REFERENCE_STDIO_HANG")) {
          return
        }
        if (cancelledRunId === payload.runId) {
          event(request.id, payload.runId, {
            type: "run.failed",
            error: {
              code: "agent_host_cancelled",
              message: "run cancelled",
              retryable: false,
            },
          })
          successResponse(request.id)
          activeRun = null
          return
        }
        const output =
          payload.outputSchema !== undefined
            ? { answer: "reference" }
            : { status: "answered", answer: "reference host", citations: [] }
        event(request.id, payload.runId, {
          type: "run.completed",
          output,
        })
        if (envFlag("REFERENCE_STDIO_DUP_TERMINAL")) {
          event(request.id, payload.runId, {
            type: "run.completed",
            output,
          })
        }
        if (envFlag("REFERENCE_STDIO_AFTER_TERMINAL")) {
          event(request.id, payload.runId, {
            type: "usage",
            totalTokens: 1,
          })
        }
        if (!envFlag("REFERENCE_STDIO_NO_CLOSE")) {
          successResponse(request.id)
        }
        activeRun = null
        if (envFlag("REFERENCE_STDIO_EXIT_AFTER_RUN")) {
          process.exit(0)
        }
        return
      }
      default:
        errorResponse(request.id, "agent_host_stdio_unknown_message")
    }
  })
  lineReader.on("close", () => {
    process.exit(0)
  })
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  process.argv[1].includes("reference-stdio-host")
if (invokedDirectly) {
  serveReferenceStdioHost()
}
