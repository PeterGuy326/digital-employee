import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  CAPABILITY_GRANT_SCHEMA_VERSION,
  MCP_CONFORMANCE_CODES,
  SYNTHETIC_DOC_SERVER,
  SYNTHETIC_MEM_SERVER,
  checkCapabilityGrant,
  loadCapabilityGrants,
  readSyntheticDocument,
  recallSyntheticMemory,
  validateCapabilityGrants,
  validateSyntheticDocumentFixture,
  validateSyntheticMemoryFixture,
} from "../../packages/core/src/mcp-conformance.js"
import type {
  CapabilityGrantSet,
  SyntheticDocumentFixture,
  SyntheticMemoryFixture,
} from "../../packages/core/src/mcp-conformance.js"

function code(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as { code: unknown }).code)
    : ""
}

function grantSet(overrides: Partial<CapabilityGrantSet> = {}): CapabilityGrantSet {
  return {
    schemaVersion: CAPABILITY_GRANT_SCHEMA_VERSION,
    grantedBy: "operator",
    grants: [
      {
        server: SYNTHETIC_MEM_SERVER,
        mode: "read",
        scopes: [{ principal: "alice", workspace: "ws-alpha" }],
        revoked: false,
      },
      {
        server: SYNTHETIC_DOC_SERVER,
        mode: "read",
        scopes: [{ principal: "alice", workspace: "ws-alpha" }],
        revoked: false,
      },
    ],
    ...overrides,
  }
}

function memoryFixture(): SyntheticMemoryFixture {
  return {
    workspace: "ws-alpha",
    principal: "alice",
    memories: [
      { id: "active-approved", revision: 3, state: "active", approved: true, text: "kept" },
      { id: "active-unapproved", revision: 1, state: "active", approved: false, text: "no" },
      { id: "superseded", revision: 2, state: "superseded", approved: true, text: "no" },
      { id: "forgotten", revision: 1, state: "forgotten", approved: true, text: "no" },
    ],
  }
}

function documentFixture(): SyntheticDocumentFixture {
  return {
    workspace: "ws-alpha",
    documents: [
      {
        id: "runbook",
        revision: 4,
        title: "Runbook",
        body: "body",
        listed: true,
        revoked: false,
      },
      {
        id: "revoked-doc",
        revision: 1,
        title: "Revoked",
        body: "no",
        listed: true,
        revoked: true,
      },
      {
        id: "unlisted-doc",
        revision: 1,
        title: "Unlisted",
        body: "no",
        listed: false,
        revoked: false,
      },
    ],
  }
}

test("grant record validation accepts read-only scoped grants and rejects hostile shapes", () => {
  const valid = validateCapabilityGrants({
    schemaVersion: CAPABILITY_GRANT_SCHEMA_VERSION,
    grantedBy: "operator",
    grants: [
      {
        server: SYNTHETIC_MEM_SERVER,
        mode: "read",
        scopes: [{ principal: "alice", workspace: "ws-alpha" }],
      },
    ],
  })
  assert.equal(valid.grants[0].revoked, false)

  const hostile = [
    // write mode is never grantable
    {
      schemaVersion: CAPABILITY_GRANT_SCHEMA_VERSION,
      grantedBy: "operator",
      grants: [
        { server: SYNTHETIC_MEM_SERVER, mode: "write", scopes: [{ principal: "a", workspace: "w" }] },
      ],
    },
    // unknown field
    {
      schemaVersion: CAPABILITY_GRANT_SCHEMA_VERSION,
      grantedBy: "operator",
      grants: [{ server: SYNTHETIC_MEM_SERVER, mode: "read", scopes: [{ principal: "a", workspace: "w" }], wildcard: true }],
    },
    // duplicate server
    {
      schemaVersion: CAPABILITY_GRANT_SCHEMA_VERSION,
      grantedBy: "operator",
      grants: [
        { server: SYNTHETIC_MEM_SERVER, mode: "read", scopes: [{ principal: "a", workspace: "w" }] },
        { server: SYNTHETIC_MEM_SERVER, mode: "read", scopes: [{ principal: "b", workspace: "w" }] },
      ],
    },
    // empty scopes
    {
      schemaVersion: CAPABILITY_GRANT_SCHEMA_VERSION,
      grantedBy: "operator",
      grants: [{ server: SYNTHETIC_MEM_SERVER, mode: "read", scopes: [] }],
    },
    // wrong schema
    {
      schemaVersion: "capability-grant.v2",
      grantedBy: "operator",
      grants: [{ server: SYNTHETIC_MEM_SERVER, mode: "read", scopes: [{ principal: "a", workspace: "w" }] }],
    },
  ]
  for (const candidate of hostile) {
    assert.throws(
      () => validateCapabilityGrants(candidate),
      (error: unknown) => code(error) === MCP_CONFORMANCE_CODES.grantInvalid,
    )
  }
})

test("loadCapabilityGrants rejects self-grants located inside the employee package", async () => {
  const packageDirectory = await mkdtemp(path.join(os.tmpdir(), "mcp-self-grant-"))
  const grantPath = path.join(packageDirectory, "grant.json")
  await writeFile(
    grantPath,
    JSON.stringify({
      schemaVersion: CAPABILITY_GRANT_SCHEMA_VERSION,
      grantedBy: "the-employee-itself",
      grants: [
        { server: SYNTHETIC_MEM_SERVER, mode: "read", scopes: [{ principal: "a", workspace: "w" }] },
      ],
    }),
    "utf8",
  )
  assert.throws(
    () => loadCapabilityGrants(grantPath, packageDirectory),
    (error: unknown) => code(error) === MCP_CONFORMANCE_CODES.selfGrantRejected,
  )

  // A grant outside the package directory loads cleanly.
  const operatorDirectory = await mkdtemp(path.join(os.tmpdir(), "mcp-operator-grant-"))
  const operatorGrantPath = path.join(operatorDirectory, "grant.json")
  await writeFile(
    operatorGrantPath,
    JSON.stringify({
      schemaVersion: CAPABILITY_GRANT_SCHEMA_VERSION,
      grantedBy: "operator",
      grants: [
        { server: SYNTHETIC_MEM_SERVER, mode: "read", scopes: [{ principal: "a", workspace: "w" }] },
      ],
    }),
    "utf8",
  )
  const grants = loadCapabilityGrants(operatorGrantPath, packageDirectory)
  assert.equal(grants.grantedBy, "operator")
})

test("the shared grant gate enforces revocation, excessive mode, and scope", () => {
  const base = { grants: grantSet(), server: SYNTHETIC_MEM_SERVER, principal: "alice", workspace: "ws-alpha" }
  assert.doesNotThrow(() => checkCapabilityGrant(base))

  assert.throws(
    () => checkCapabilityGrant({ ...base, requestedMode: "write" }),
    (error: unknown) => code(error) === MCP_CONFORMANCE_CODES.modeExcessive,
  )
  assert.throws(
    () => checkCapabilityGrant({ ...base, principal: "mallory" }),
    (error: unknown) => code(error) === MCP_CONFORMANCE_CODES.scopeDenied,
  )
  assert.throws(
    () => checkCapabilityGrant({ ...base, workspace: "ws-other" }),
    (error: unknown) => code(error) === MCP_CONFORMANCE_CODES.scopeDenied,
  )
  assert.throws(
    () => checkCapabilityGrant({ ...base, grants: undefined }),
    (error: unknown) => code(error) === MCP_CONFORMANCE_CODES.grantMissing,
  )
  const revoked = grantSet({
    grants: [
      {
        server: SYNTHETIC_MEM_SERVER,
        mode: "read",
        scopes: [{ principal: "alice", workspace: "ws-alpha" }],
        revoked: true,
      },
    ],
  })
  assert.throws(
    () => checkCapabilityGrant({ ...base, grants: revoked }),
    (error: unknown) => code(error) === MCP_CONFORMANCE_CODES.revoked,
  )
})

test("recall returns only active approved memories for the granted scope, without locator leaks", () => {
  const grants = grantSet()
  const items = recallSyntheticMemory({
    fixture: memoryFixture(),
    grants,
    principal: "alice",
    workspace: "ws-alpha",
  })
  assert.deepEqual(items, [
    { locator: "mem://ws-alpha/active-approved@3", text: "kept" },
  ])

  // Cross-scope recall is denied before any fixture is touched.
  assert.throws(
    () =>
      recallSyntheticMemory({
        fixture: memoryFixture(),
        grants,
        principal: "mallory",
        workspace: "ws-alpha",
      }),
    (error: unknown) => code(error) === MCP_CONFORMANCE_CODES.scopeDenied,
  )

  // Unavailable fixture degrades explicitly.
  assert.throws(
    () =>
      recallSyntheticMemory({
        fixture: undefined,
        grants,
        principal: "alice",
        workspace: "ws-alpha",
      }),
    (error: unknown) => code(error) === MCP_CONFORMANCE_CODES.serviceUnavailable,
  )
})

test("document reads pin the exact revision and deny revoked/unlisted/wrong-revision", () => {
  const grants = grantSet()
  const ok = readSyntheticDocument({
    fixture: documentFixture(),
    grants,
    principal: "alice",
    workspace: "ws-alpha",
    documentId: "runbook",
    revision: 4,
  })
  assert.equal(ok.locator, "doc://ws-alpha/runbook@4")
  assert.equal(ok.revision, 4)

  assert.throws(
    () =>
      readSyntheticDocument({
        fixture: documentFixture(),
        grants,
        principal: "alice",
        workspace: "ws-alpha",
        documentId: "runbook",
        revision: 3,
      }),
    (error: unknown) => code(error) === MCP_CONFORMANCE_CODES.revisionMismatch,
  )
  assert.throws(
    () =>
      readSyntheticDocument({
        fixture: documentFixture(),
        grants,
        principal: "alice",
        workspace: "ws-alpha",
        documentId: "revoked-doc",
        revision: 1,
      }),
    (error: unknown) => code(error) === MCP_CONFORMANCE_CODES.revoked,
  )
  assert.throws(
    () =>
      readSyntheticDocument({
        fixture: documentFixture(),
        grants,
        principal: "alice",
        workspace: "ws-alpha",
        documentId: "unlisted-doc",
        revision: 1,
      }),
    (error: unknown) => code(error) === MCP_CONFORMANCE_CODES.itemUnavailable,
  )
})

test("fixture validators reject unknown fields and malformed entries", () => {
  assert.throws(
    () => validateSyntheticMemoryFixture({ ...memoryFixture(), extra: 1 }),
    (error: unknown) => code(error) === MCP_CONFORMANCE_CODES.serviceUnavailable,
  )
  assert.throws(
    () =>
      validateSyntheticDocumentFixture({
        workspace: "ws-alpha",
        documents: [{ id: "x", revision: 0, title: "t", body: "b", listed: true, revoked: false }],
      }),
    (error: unknown) => code(error) === MCP_CONFORMANCE_CODES.serviceUnavailable,
  )
})
