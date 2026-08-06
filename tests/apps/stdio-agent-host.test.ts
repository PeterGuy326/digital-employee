import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createBuiltInAgentHostRegistry } from "../../apps/cli/agent-host-registry.js"
import { REFERENCE_STDIO_HOST_ID } from "../../apps/cli/reference-stdio-host.js"
import {
  ExternalStdioAgentHostAdapter,
  createExternalStdioHostRegistration,
} from "../../apps/cli/stdio-agent-host.js"
import type { AgentHostRunRequest } from "../../packages/core/src/agent-host.js"
import { runQualificationSuite } from "../../packages/core/src/adapter-qualification.js"
import {
  AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION,
  validateStdioAdapterConfig,
} from "../../packages/core/src/agent-host-stdio-config.js"
import type { StdioAdapterConfig } from "../../packages/core/src/agent-host-stdio-config.js"

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
)
const tsxBinary = path.join(packageRoot, "node_modules", ".bin", "tsx")
const referenceHostScript = path.join(
  packageRoot,
  "apps",
  "cli",
  "reference-stdio-host.ts",
)

const ENV_FLAGS = [
  "REFERENCE_STDIO_HANG",
  "REFERENCE_STDIO_SPAWN_CHILD",
  "REFERENCE_STDIO_UNKNOWN_FIELD",
  "REFERENCE_STDIO_DUP_TERMINAL",
  "REFERENCE_STDIO_AFTER_TERMINAL",
  "REFERENCE_STDIO_MISSING_CAPABILITY",
  "REFERENCE_STDIO_DISALLOWED_TOOL",
  "REFERENCE_STDIO_REFUSE_CANCEL",
  "REFERENCE_STDIO_HOSTILE_WRITE_OK",
  "REFERENCE_STDIO_PROBE_ONLY",
  "REFERENCE_STDIO_NOT_READY",
]

function referenceConfig(overrides: {
  digest?: string
  timeoutMs?: number
} = {}): StdioAdapterConfig {
  const digest =
    overrides.digest ??
    createHash("sha256").update(readFileSync(tsxBinary)).digest("hex")
  return validateStdioAdapterConfig({
    schema: AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION,
    hostId: REFERENCE_STDIO_HOST_ID,
    displayName: "Reference Stdio Host",
    executable: tsxBinary,
    args: [referenceHostScript],
    digest: { algorithm: "sha256", hex: digest },
    envAllowlist: ["PATH", ...ENV_FLAGS],
    workingDirectoryPolicy: "request",
    timeoutMs: overrides.timeoutMs ?? 10_000,
    maxStderrBytes: 16_384,
  })
}

function readOnlyRequest(runId: string): AgentHostRunRequest {
  return {
    runId,
    employeeId: "test-employee",
    workingDirectory: process.cwd(),
    prompt: "answer the question",
    policy: {
      tools: { default: "deny", allow: [{ name: "noop", mode: "read" }] },
      filesystem: { read: ["."], write: [] },
      network: { mode: "deny" },
      approval: { mode: "never" },
      maxTurns: 4,
    },
  }
}

function code(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as { code: unknown }).code)
    : ""
}

async function withFlags(
  flags: readonly string[],
  body: () => Promise<void>,
): Promise<void> {
  for (const flag of flags) process.env[flag] = "1"
  try {
    await body()
  } finally {
    for (const flag of flags) delete process.env[flag]
  }
}

test("an explicit external adapter completes the full lifecycle through the registry", async () => {
  await withFlags([], async () => {
    const registration = createExternalStdioHostRegistration(referenceConfig())
    const registry = createBuiltInAgentHostRegistry().register(registration)
    assert.equal(registry.hasAdapter(REFERENCE_STDIO_HOST_ID), true)

    const probe = await registry.probe(REFERENCE_STDIO_HOST_ID)
    assert.equal(probe.status, "ready")
    assert.equal(probe.adapterStatus, "runnable")

    const adapter = (await registry.create(
      REFERENCE_STDIO_HOST_ID,
    )) as ExternalStdioAgentHostAdapter
    try {
      const preflight = await adapter.preflight(readOnlyRequest("preflight-1"))
      assert.equal(preflight.hostId, REFERENCE_STDIO_HOST_ID)

      await assert.rejects(
        () =>
          adapter.preflight({
            ...readOnlyRequest("preflight-2"),
            policy: {
              ...readOnlyRequest("preflight-2").policy,
              filesystem: { read: ["."], write: ["/etc"] },
            },
          }),
        (error: unknown) => code(error) === "agent_host_stdio_host_error",
      )

      const events = []
      for await (const event of adapter.run(readOnlyRequest("run-1"))) {
        events.push(event)
      }
      assert.deepEqual(
        events.map((event) => event.type),
        ["run.started", "run.completed"],
      )

      await adapter.cancel("run-cancel")
      const cancelled = []
      for await (const event of adapter.run(readOnlyRequest("run-cancel"))) {
        cancelled.push(event)
      }
      const terminal = cancelled[cancelled.length - 1]
      assert.equal(terminal.type, "run.failed")
      assert.equal(
        terminal.type === "run.failed" && terminal.error.code,
        "agent_host_cancelled",
      )
    } finally {
      await adapter.dispose()
    }
  })
})

test("violation fixtures fail closed with stable error codes", async () => {
  const probeFixture = async (flags: string[], expected: string) => {
    await withFlags(flags, async () => {
      const adapter = new ExternalStdioAgentHostAdapter(referenceConfig())
      try {
        await assert.rejects(
          () => adapter.probe(),
          (error: unknown) => code(error) === expected,
        )
      } finally {
        await adapter.dispose()
      }
    })
  }
  await probeFixture(["REFERENCE_STDIO_UNKNOWN_FIELD"], "AGENT_HOST_PROBE_INVALID")
  await probeFixture(
    ["REFERENCE_STDIO_MISSING_CAPABILITY"],
    "AGENT_HOST_PROBE_INVALID",
  )

  await withFlags(["REFERENCE_STDIO_DUP_TERMINAL"], async () => {
    const adapter = new ExternalStdioAgentHostAdapter(referenceConfig())
    try {
      const events = []
      await assert.rejects(async () => {
        for await (const event of adapter.run(readOnlyRequest("dup-1"))) {
          events.push(event)
        }
      }, (error: unknown) =>
        code(error) === "agent_host_terminal_contract_violated")
    } finally {
      await adapter.dispose()
    }
  })

  await withFlags(["REFERENCE_STDIO_AFTER_TERMINAL"], async () => {
    const adapter = new ExternalStdioAgentHostAdapter(referenceConfig())
    try {
      await assert.rejects(async () => {
        for await (const _event of adapter.run(readOnlyRequest("after-1"))) {
          // draining; the fixture must fail closed
        }
      }, (error: unknown) =>
        code(error) === "agent_host_terminal_contract_violated")
    } finally {
      await adapter.dispose()
    }
  })

  const poisoned = new ExternalStdioAgentHostAdapter(
    referenceConfig({ digest: "b".repeat(64) }),
  )
  await assert.rejects(
    () => poisoned.probe(),
    (error: unknown) => code(error) === "agent_host_stdio_digest_mismatch",
  )
  await poisoned.dispose()

  await withFlags(["REFERENCE_STDIO_HANG"], async () => {
    const adapter = new ExternalStdioAgentHostAdapter(
      referenceConfig({ timeoutMs: 1_000 }),
    )
    try {
      await assert.rejects(async () => {
        for await (const _event of adapter.run(readOnlyRequest("hang-1"))) {
          // draining; the fixture must time out
        }
      }, (error: unknown) => code(error) === "agent_host_stdio_timeout")
    } finally {
      await adapter.dispose()
    }
  })
})

test("dispose cleans the detached process tree completely", async () => {
  await withFlags(["REFERENCE_STDIO_SPAWN_CHILD"], async () => {
    const adapter = new ExternalStdioAgentHostAdapter(referenceConfig())
    try {
      await adapter.probe()
    } finally {
      await adapter.dispose()
    }
    const match = adapter
      .diagnosticsTail()
      .match(/spawned child pid (\d+)/)
    assert.ok(match, "expected the fixture to report its leaked child pid")
    const pid = Number(match[1])
    assert.throws(
      () => process.kill(pid, 0),
      (error: unknown) =>
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "ESRCH",
    )
  })
})

test("the qualification kit issues a fixture-conformant record for the reference adapter", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stdio-qualification-"))
  await withFlags([], async () => {
    const adapter = new ExternalStdioAgentHostAdapter(referenceConfig())
    try {
      const record = await runQualificationSuite(adapter, {
        workingDirectory: directory,
        generatedAt: "2026-08-06T04:00:00Z",
      })
      assert.equal(record.schema, "adapter-qualification-record.v1")
      assert.equal(record.hostId, REFERENCE_STDIO_HOST_ID)
      assert.deepEqual(record.axes, {
        implemented: true,
        fixtureConformant: true,
        liveQualified: false,
      })
      assert.equal(record.liveEvidence, undefined)
    } finally {
      await adapter.dispose()
    }
  })
})
