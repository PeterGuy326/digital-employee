import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, writeFile, cp } from "node:fs/promises"
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
import { runEmployeePackage } from "../../apps/cli/agent-run.js"
import type { AgentHostRunRequest } from "../../packages/core/src/agent-host.js"
import {
  AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION,
  validateStdioAdapterConfig,
} from "../../packages/core/src/agent-host-stdio-config.js"
import type { StdioAdapterConfig } from "../../packages/core/src/agent-host-stdio-config.js"
import {
  MCP_CONFORMANCE_CODES,
  SYNTHETIC_DOC_SERVER,
  SYNTHETIC_MEM_SERVER,
} from "../../packages/core/src/mcp-conformance.js"

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
)
// Prefer the prebuilt host (plain node spawn) so the E2E fixtures do not pay
// the tsx loader cost for every spawned reference host under parallel load.
const distHostScript = path.join(
  packageRoot,
  "dist",
  "apps",
  "cli",
  "reference-stdio-host.js",
)
const useDistHost = existsSync(distHostScript)
const hostExecutable = useDistHost
  ? process.execPath
  : path.join(packageRoot, "node_modules", ".bin", "tsx")
const referenceHostScript = useDistHost
  ? distHostScript
  : path.join(packageRoot, "apps", "cli", "reference-stdio-host.ts")
const recipeDirectory = path.join(
  packageRoot,
  "recipes",
  "synthetic-mcp-context",
)
const employeePackageDirectory = path.join(recipeDirectory, "employee")
const grantPath = path.join(recipeDirectory, "grant.json")
const memFixturePath = path.join(recipeDirectory, "fixtures", "mem.json")
const docFixturePath = path.join(recipeDirectory, "fixtures", "doc.json")
const executableDigest = createHash("sha256")
  .update(readFileSync(hostExecutable))
  .digest("hex")

const SYNTHETIC_ENV = [
  "SYNTHETIC_MCP_GRANT",
  "SYNTHETIC_MCP_PRINCIPAL",
  "SYNTHETIC_MCP_WORKSPACE",
  "SYNTHETIC_MCP_MEM_FIXTURE",
  "SYNTHETIC_MCP_DOC_FIXTURE",
] as const

function syntheticConfig(): StdioAdapterConfig {
  return validateStdioAdapterConfig({
    schema: AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION,
    hostId: REFERENCE_STDIO_HOST_ID,
    displayName: "Reference Stdio Host",
    executable: hostExecutable,
    args: [referenceHostScript],
    digest: { algorithm: "sha256", hex: executableDigest },
    envAllowlist: ["PATH", ...SYNTHETIC_ENV],
    workingDirectoryPolicy: "request",
    timeoutMs: 30_000,
    maxStderrBytes: 16_384,
  })
}

function syntheticEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    SYNTHETIC_MCP_GRANT: grantPath,
    SYNTHETIC_MCP_PRINCIPAL: "alice",
    SYNTHETIC_MCP_WORKSPACE: "ws-alpha",
    SYNTHETIC_MCP_MEM_FIXTURE: memFixturePath,
    SYNTHETIC_MCP_DOC_FIXTURE: docFixturePath,
    ...overrides,
  }
}

async function withEnv(
  env: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await body()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function readOnlyPolicy() {
  return {
    tools: { default: "deny" as const, allow: [{ name: "noop", mode: "read" as const }] },
    filesystem: { read: ["."], write: [] },
    network: { mode: "deny" as const },
    approval: { mode: "never" as const },
    maxTurns: 4,
  }
}

test("AC-001: a granted same-scope run recalls only approved context with stable locators", async () => {
  await withEnv(syntheticEnv(), async () => {
    const registry = createBuiltInAgentHostRegistry().register(
      createExternalStdioHostRegistration(syntheticConfig()),
    )
    const result = await runEmployeePackage({
      directory: employeePackageDirectory,
      engine: REFERENCE_STDIO_HOST_ID,
      hostRegistry: registry,
      input: { message: "recall approved context" },
    })
    assert.equal(result.status, "completed", JSON.stringify(result))
    if (result.status !== "completed") return
    const output = result.output as {
      status: string
      citations: Array<{ label: string; uri: string }>
    }
    assert.equal(output.status, "answered")
    const uris = output.citations.map((citation) => citation.uri)
    assert.ok(
      uris.includes("mem://ws-alpha/onboarding-notes@3"),
      `expected the approved memory locator, got ${JSON.stringify(uris)}`,
    )
    // No locator leaks for unapproved/superseded/forgotten items.
    for (const denied of ["draft-ideas", "old-roadmap", "forgotten-note"]) {
      assert.ok(
        !uris.some((uri) => uri.includes(denied)),
        `denied memory ${denied} must not leak a locator`,
      )
    }
  })
})

test("AC-001: a cross-principal run is denied at the grant gate", async () => {
  await withEnv(syntheticEnv({ SYNTHETIC_MCP_PRINCIPAL: "mallory" }), async () => {
    const registry = createBuiltInAgentHostRegistry().register(
      createExternalStdioHostRegistration(syntheticConfig()),
    )
    const result = await runEmployeePackage({
      directory: employeePackageDirectory,
      engine: REFERENCE_STDIO_HOST_ID,
      hostRegistry: registry,
      input: { message: "recall approved context" },
    })
    assert.equal(result.status, "failed")
    if (result.status !== "failed") return
    assert.equal(result.error.code, MCP_CONFORMANCE_CODES.scopeDenied)
  })
})

test("AC-002: document reads pin the revision and deny revoked/unlisted/wrong-revision", async () => {
  await withEnv(syntheticEnv(), async () => {
    const adapter = new ExternalStdioAgentHostAdapter(syntheticConfig())
    try {
      const runDoc = async (
        documentId: string,
        revision: number,
      ): Promise<{ code?: string; uri?: string }> => {
        const request: AgentHostRunRequest = {
          runId: `doc-${documentId}-${revision}`,
          employeeId: "test-employee",
          workingDirectory: employeePackageDirectory,
          prompt: "read a pinned document",
          mcpServers: [
            { name: SYNTHETIC_DOC_SERVER, transport: "stdio", command: "synthetic-doc-server" },
          ],
          metadata: { principal: "alice", workspace: "ws-alpha", documentId, revision },
          policy: readOnlyPolicy(),
        }
        let terminalUri: string | undefined
        let terminalCode: string | undefined
        for await (const event of adapter.run(request)) {
          if (event.type === "run.completed") {
            const citations = (event.output as { citations?: Array<{ uri: string }> })
              .citations
            terminalUri = citations?.map((citation) => citation.uri).join(",")
          }
          if (event.type === "run.failed") terminalCode = event.error.code
        }
        return { code: terminalCode, uri: terminalUri }
      }

      assert.deepEqual(await runDoc("runbook", 4), {
        code: undefined,
        uri: "doc://ws-alpha/runbook@4",
      })
      assert.equal((await runDoc("runbook", 3)).code, MCP_CONFORMANCE_CODES.revisionMismatch)
      assert.equal((await runDoc("legacy-guide", 1)).code, MCP_CONFORMANCE_CODES.revoked)
      assert.equal((await runDoc("hidden-note", 1)).code, MCP_CONFORMANCE_CODES.itemUnavailable)
      assert.equal((await runDoc("missing-doc", 1)).code, MCP_CONFORMANCE_CODES.itemUnavailable)
    } finally {
      await adapter.dispose()
    }
  })
})

test("AC-003: an excessive write mode and an unavailable fixture degrade explicitly", async () => {
  // Excessive write mode requested against a read-only grant.
  await withEnv(syntheticEnv(), async () => {
    const adapter = new ExternalStdioAgentHostAdapter(syntheticConfig())
    try {
      const request: AgentHostRunRequest = {
        runId: "write-mode",
        employeeId: "test-employee",
        workingDirectory: employeePackageDirectory,
        prompt: "attempt a write",
        mcpServers: [
          { name: SYNTHETIC_MEM_SERVER, transport: "stdio", command: "synthetic-mem-server" },
        ],
        metadata: { principal: "alice", workspace: "ws-alpha" },
        policy: {
          tools: { default: "deny", allow: [{ name: "mem.recall", mode: "write" }] },
          filesystem: { read: ["."], write: [] },
          network: { mode: "deny" },
          approval: { mode: "never" },
          maxTurns: 4,
        },
      }
      let code = ""
      for await (const event of adapter.run(request)) {
        if (event.type === "run.failed") code = event.error.code
      }
      assert.equal(code, MCP_CONFORMANCE_CODES.modeExcessive)
    } finally {
      await adapter.dispose()
    }
  })

  // Unavailable fixture (env unset) degrades explicitly instead of hanging.
  await withEnv(
    syntheticEnv({ SYNTHETIC_MCP_MEM_FIXTURE: undefined }),
    async () => {
      const adapter = new ExternalStdioAgentHostAdapter(syntheticConfig())
      try {
        const request: AgentHostRunRequest = {
          runId: "unavailable-mem",
          employeeId: "test-employee",
          workingDirectory: employeePackageDirectory,
          prompt: "recall",
          mcpServers: [
            { name: SYNTHETIC_MEM_SERVER, transport: "stdio", command: "synthetic-mem-server" },
          ],
          metadata: { principal: "alice", workspace: "ws-alpha" },
          policy: readOnlyPolicy(),
        }
        let code = ""
        for await (const event of adapter.run(request)) {
          if (event.type === "run.failed") code = event.error.code
        }
        assert.equal(code, MCP_CONFORMANCE_CODES.serviceUnavailable)
      } finally {
        await adapter.dispose()
      }
    },
  )
})

test("AC-004: a grant copied into the employee package is rejected as a self-grant", async () => {
  const staging = await mkdtemp(path.join(os.tmpdir(), "self-grant-"))
  const packageCopy = path.join(staging, "employee")
  await cp(employeePackageDirectory, packageCopy, { recursive: true })
  const insideGrant = path.join(packageCopy, "grant.json")
  await writeFile(insideGrant, readFileSync(grantPath, "utf8"), "utf8")

  await withEnv(syntheticEnv({ SYNTHETIC_MCP_GRANT: insideGrant }), async () => {
    const adapter = new ExternalStdioAgentHostAdapter(syntheticConfig())
    try {
      const request: AgentHostRunRequest = {
        runId: "self-grant",
        employeeId: "test-employee",
        workingDirectory: packageCopy,
        prompt: "recall",
        mcpServers: [
          { name: SYNTHETIC_MEM_SERVER, transport: "stdio", command: "synthetic-mem-server" },
        ],
        metadata: { principal: "alice", workspace: "ws-alpha" },
        policy: readOnlyPolicy(),
      }
      let code = ""
      for await (const event of adapter.run(request)) {
        if (event.type === "run.failed") code = event.error.code
      }
      assert.equal(code, MCP_CONFORMANCE_CODES.selfGrantRejected)
    } finally {
      await adapter.dispose()
    }
  })
})
