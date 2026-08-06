import { readFileSync, realpathSync } from "node:fs"
import path from "node:path"

import { CoreError, assertPlainObject } from "./contracts.js"

export const CAPABILITY_GRANT_SCHEMA_VERSION = "capability-grant.v1"

export const SYNTHETIC_MEM_SERVER = "synthetic-mem"
export const SYNTHETIC_DOC_SERVER = "synthetic-doc"

/**
 * Frozen machine codes for read-only MCP conformance decisions. Synthetic
 * evidence carries these codes; they are never reused for real services.
 */
export const MCP_CONFORMANCE_CODES = {
  grantInvalid: "mcp_grant_invalid",
  selfGrantRejected: "mcp_self_grant_rejected",
  grantMissing: "mcp_grant_missing",
  revoked: "mcp_revoked",
  scopeDenied: "mcp_scope_denied",
  modeExcessive: "mcp_mode_excessive",
  itemUnavailable: "mcp_item_unavailable",
  revisionMismatch: "mcp_revision_mismatch",
  serviceUnavailable: "mcp_service_unavailable",
} as const

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/

export interface CapabilityScope {
  principal: string
  workspace: string
}

export interface CapabilityGrantEntry {
  server: string
  mode: "read"
  scopes: CapabilityScope[]
  revoked: boolean
}

export interface CapabilityGrantSet {
  schemaVersion: typeof CAPABILITY_GRANT_SCHEMA_VERSION
  grantedBy: string
  grants: CapabilityGrantEntry[]
}

export interface SyntheticMemory {
  id: string
  revision: number
  state: "active" | "superseded" | "forgotten"
  approved: boolean
  text: string
}

export interface SyntheticMemoryFixture {
  workspace: string
  principal: string
  memories: SyntheticMemory[]
}

export interface SyntheticDocument {
  id: string
  revision: number
  title: string
  body: string
  listed: boolean
  revoked: boolean
}

export interface SyntheticDocumentFixture {
  workspace: string
  documents: SyntheticDocument[]
}

export interface MemoryRecallItem {
  locator: string
  text: string
}

export interface DocumentReadItem {
  locator: string
  title: string
  body: string
  revision: number
}

function conformanceError(
  code: string,
  details?: unknown,
): CoreError {
  return new CoreError(code, `synthetic mcp conformance decision: ${code}`, {
    status: 400,
    retryable: false,
    details,
  })
}

function grantError(label: string): CoreError {
  return new CoreError(
    MCP_CONFORMANCE_CODES.grantInvalid,
    "capability grant record is invalid",
    { status: 400, retryable: false, details: { label } },
  )
}

function requirePatternString(
  value: unknown,
  pattern: RegExp,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !pattern.test(value)
  ) {
    throw grantError(label)
  }
  return value
}

function validateScope(value: unknown, label: string): CapabilityScope {
  assertPlainObject(value, label)
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes("principal") || !keys.includes("workspace")) {
    throw grantError(label)
  }
  return {
    principal: requirePatternString(value.principal, SCOPE_PATTERN, `${label}.principal`),
    workspace: requirePatternString(value.workspace, SCOPE_PATTERN, `${label}.workspace`),
  }
}

function validateGrantEntry(
  value: unknown,
  label: string,
): CapabilityGrantEntry {
  assertPlainObject(value, label)
  const keys = Object.keys(value)
  for (const key of keys) {
    if (!["server", "mode", "scopes", "revoked"].includes(key)) {
      throw grantError(`${label}.${key}`)
    }
  }
  const server = requirePatternString(value.server, IDENTIFIER_PATTERN, `${label}.server`)
  if (value.mode !== "read") throw grantError(`${label}.mode`)
  if (!Array.isArray(value.scopes) || value.scopes.length === 0 || value.scopes.length > 256) {
    throw grantError(`${label}.scopes`)
  }
  const scopes = value.scopes.map((scope, index) =>
    validateScope(scope, `${label}.scopes[${index}]`),
  )
  const scopeKeys = scopes.map((scope) => `${scope.principal}@${scope.workspace}`)
  if (new Set(scopeKeys).size !== scopeKeys.length) {
    throw grantError(`${label}.scopes`)
  }
  if (value.revoked !== undefined && typeof value.revoked !== "boolean") {
    throw grantError(`${label}.revoked`)
  }
  return { server, mode: "read", scopes, revoked: value.revoked === true }
}

/**
 * Strictly validates an operator-owned capability-grant.v1 record. Grants are
 * read-only: any write mode, unknown field, or malformed scope fails closed.
 */
export function validateCapabilityGrants(value: unknown): CapabilityGrantSet {
  assertPlainObject(value, "capability-grant")
  const keys = Object.keys(value)
  for (const key of keys) {
    if (!["schemaVersion", "grantedBy", "grants"].includes(key)) {
      throw grantError(key)
    }
  }
  if (value.schemaVersion !== CAPABILITY_GRANT_SCHEMA_VERSION) {
    throw grantError("schemaVersion")
  }
  const grantedBy = requirePatternString(
    value.grantedBy,
    SCOPE_PATTERN,
    "grantedBy",
  )
  if (!Array.isArray(value.grants) || value.grants.length === 0 || value.grants.length > 64) {
    throw grantError("grants")
  }
  const grants = value.grants.map((entry, index) =>
    validateGrantEntry(entry, `grants[${index}]`),
  )
  const servers = grants.map((entry) => entry.server)
  if (new Set(servers).size !== servers.length) {
    throw grantError("grants")
  }
  return { schemaVersion: CAPABILITY_GRANT_SCHEMA_VERSION, grantedBy, grants }
}

/**
 * Loads and validates a grant file. An employee package can never grant
 * itself access: a grant file located inside the employee package directory
 * is rejected outright.
 */
export function loadCapabilityGrants(
  grantPath: string,
  employeePackageDirectory?: string,
): CapabilityGrantSet {
  let raw: string
  try {
    raw = readFileSync(grantPath, "utf8")
  } catch {
    throw conformanceError(MCP_CONFORMANCE_CODES.grantMissing, {
      reason: "unreadable_grant_file",
    })
  }
  if (employeePackageDirectory) {
    try {
      const resolvedGrant = realpathSync(path.resolve(grantPath))
      const resolvedPackage = realpathSync(path.resolve(employeePackageDirectory))
      const relative = path.relative(resolvedPackage, resolvedGrant)
      if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        throw conformanceError(MCP_CONFORMANCE_CODES.selfGrantRejected)
      }
    } catch (error) {
      if (error instanceof CoreError) throw error
      throw conformanceError(MCP_CONFORMANCE_CODES.grantMissing, {
        reason: "unresolvable_grant_path",
      })
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw conformanceError(MCP_CONFORMANCE_CODES.grantInvalid, {
      reason: "grant_not_json",
    })
  }
  return validateCapabilityGrants(parsed)
}

function requireFixtureString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 4_096 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw conformanceError(MCP_CONFORMANCE_CODES.serviceUnavailable, {
      reason: `fixture_invalid:${label}`,
    })
  }
  return value
}

export function validateSyntheticMemoryFixture(
  value: unknown,
): SyntheticMemoryFixture {
  assertPlainObject(value, "synthetic-mem-fixture")
  const keys = Object.keys(value)
  for (const key of keys) {
    if (!["workspace", "principal", "memories"].includes(key)) {
      throw conformanceError(MCP_CONFORMANCE_CODES.serviceUnavailable, {
        reason: `fixture_unknown_field:${key}`,
      })
    }
  }
  const workspace = requirePatternString(value.workspace, SCOPE_PATTERN, "workspace")
  const principal = requirePatternString(value.principal, SCOPE_PATTERN, "principal")
  if (!Array.isArray(value.memories) || value.memories.length > 1024) {
    throw conformanceError(MCP_CONFORMANCE_CODES.serviceUnavailable, {
      reason: "fixture_invalid:memories",
    })
  }
  const memories = value.memories.map((entry, index) => {
    assertPlainObject(entry, `memories[${index}]`)
    const entryKeys = Object.keys(entry)
    for (const key of entryKeys) {
      if (!["id", "revision", "state", "approved", "text"].includes(key)) {
        throw conformanceError(MCP_CONFORMANCE_CODES.serviceUnavailable, {
          reason: `fixture_unknown_field:memories.${key}`,
        })
      }
    }
    const id = requirePatternString(entry.id, IDENTIFIER_PATTERN, `memories[${index}].id`)
    if (
      typeof entry.revision !== "number" ||
      !Number.isInteger(entry.revision) ||
      entry.revision < 1
    ) {
      throw conformanceError(MCP_CONFORMANCE_CODES.serviceUnavailable, {
        reason: `fixture_invalid:memories[${index}].revision`,
      })
    }
    if (
      entry.state !== "active" &&
      entry.state !== "superseded" &&
      entry.state !== "forgotten"
    ) {
      throw conformanceError(MCP_CONFORMANCE_CODES.serviceUnavailable, {
        reason: `fixture_invalid:memories[${index}].state`,
      })
    }
    const state: SyntheticMemory["state"] = entry.state
    if (typeof entry.approved !== "boolean") {
      throw conformanceError(MCP_CONFORMANCE_CODES.serviceUnavailable, {
        reason: `fixture_invalid:memories[${index}].approved`,
      })
    }
    return {
      id,
      revision: entry.revision,
      state,
      approved: entry.approved,
      text: requireFixtureString(entry.text, `memories[${index}].text`),
    }
  })
  return { workspace, principal, memories }
}

export function validateSyntheticDocumentFixture(
  value: unknown,
): SyntheticDocumentFixture {
  assertPlainObject(value, "synthetic-doc-fixture")
  const keys = Object.keys(value)
  for (const key of keys) {
    if (!["workspace", "documents"].includes(key)) {
      throw conformanceError(MCP_CONFORMANCE_CODES.serviceUnavailable, {
        reason: `fixture_unknown_field:${key}`,
      })
    }
  }
  const workspace = requirePatternString(value.workspace, SCOPE_PATTERN, "workspace")
  if (!Array.isArray(value.documents) || value.documents.length > 1024) {
    throw conformanceError(MCP_CONFORMANCE_CODES.serviceUnavailable, {
      reason: "fixture_invalid:documents",
    })
  }
  const documents = value.documents.map((entry, index) => {
    assertPlainObject(entry, `documents[${index}]`)
    const entryKeys = Object.keys(entry)
    for (const key of entryKeys) {
      if (!["id", "revision", "title", "body", "listed", "revoked"].includes(key)) {
        throw conformanceError(MCP_CONFORMANCE_CODES.serviceUnavailable, {
          reason: `fixture_unknown_field:documents.${key}`,
        })
      }
    }
    const id = requirePatternString(entry.id, IDENTIFIER_PATTERN, `documents[${index}].id`)
    if (
      typeof entry.revision !== "number" ||
      !Number.isInteger(entry.revision) ||
      entry.revision < 1
    ) {
      throw conformanceError(MCP_CONFORMANCE_CODES.serviceUnavailable, {
        reason: `fixture_invalid:documents[${index}].revision`,
      })
    }
    if (typeof entry.listed !== "boolean" || typeof entry.revoked !== "boolean") {
      throw conformanceError(MCP_CONFORMANCE_CODES.serviceUnavailable, {
        reason: `fixture_invalid:documents[${index}]`,
      })
    }
    return {
      id,
      revision: entry.revision,
      title: requireFixtureString(entry.title, `documents[${index}].title`),
      body: requireFixtureString(entry.body, `documents[${index}].body`),
      listed: entry.listed,
      revoked: entry.revoked,
    }
  })
  return { workspace, documents }
}

/**
 * Shared grant gate: the server must be granted, unrevoked, read-only for the
 * caller's mode, and cover the principal/workspace scope. Fails closed with
 * the frozen decision codes.
 */
export function checkCapabilityGrant(options: {
  grants: CapabilityGrantSet | undefined
  server: string
  principal: string
  workspace: string
  requestedMode?: "read" | "write"
}): void {
  const { grants, server, principal, workspace, requestedMode } = options
  if (!grants) {
    throw conformanceError(MCP_CONFORMANCE_CODES.grantMissing)
  }
  const entry = grants.grants.find((candidate) => candidate.server === server)
  if (!entry) {
    throw conformanceError(MCP_CONFORMANCE_CODES.grantMissing, { server })
  }
  if (entry.revoked) {
    throw conformanceError(MCP_CONFORMANCE_CODES.revoked, { server })
  }
  if (requestedMode === "write") {
    throw conformanceError(MCP_CONFORMANCE_CODES.modeExcessive, { server })
  }
  const scoped = entry.scopes.some(
    (scope) => scope.principal === principal && scope.workspace === workspace,
  )
  if (!scoped) {
    throw conformanceError(MCP_CONFORMANCE_CODES.scopeDenied, { server })
  }
}

/**
 * Recalls only approved, workspace-scoped, active memories. Superseded,
 * forgotten and unapproved memories are absent — no locator leaks.
 */
export function recallSyntheticMemory(options: {
  fixture: SyntheticMemoryFixture | undefined
  grants: CapabilityGrantSet | undefined
  principal: string
  workspace: string
  requestedMode?: "read" | "write"
}): MemoryRecallItem[] {
  const { fixture, grants, principal, workspace, requestedMode } = options
  if (!fixture) {
    throw conformanceError(MCP_CONFORMANCE_CODES.serviceUnavailable, {
      server: SYNTHETIC_MEM_SERVER,
    })
  }
  checkCapabilityGrant({
    grants,
    server: SYNTHETIC_MEM_SERVER,
    principal,
    workspace,
    requestedMode,
  })
  return fixture.memories
    .filter(
      (memory) =>
        memory.state === "active" &&
        memory.approved &&
        fixture.workspace === workspace &&
        fixture.principal === principal,
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((memory) => ({
      locator: `mem://${workspace}/${memory.id}@${memory.revision}`,
      text: memory.text,
    }))
}

/**
 * Reads a granted document at an exact pinned revision. Wrong revisions,
 * revoked and unlisted documents fail closed with distinct codes.
 */
export function readSyntheticDocument(options: {
  fixture: SyntheticDocumentFixture | undefined
  grants: CapabilityGrantSet | undefined
  principal: string
  workspace: string
  documentId: string
  revision: number
  requestedMode?: "read" | "write"
}): DocumentReadItem {
  const { fixture, grants, principal, workspace, documentId, revision, requestedMode } =
    options
  if (!fixture) {
    throw conformanceError(MCP_CONFORMANCE_CODES.serviceUnavailable, {
      server: SYNTHETIC_DOC_SERVER,
    })
  }
  checkCapabilityGrant({
    grants,
    server: SYNTHETIC_DOC_SERVER,
    principal,
    workspace,
    requestedMode,
  })
  if (fixture.workspace !== workspace) {
    throw conformanceError(MCP_CONFORMANCE_CODES.scopeDenied, {
      server: SYNTHETIC_DOC_SERVER,
    })
  }
  const document = fixture.documents.find((candidate) => candidate.id === documentId)
  if (!document || !document.listed) {
    throw conformanceError(MCP_CONFORMANCE_CODES.itemUnavailable, { documentId })
  }
  if (document.revoked) {
    throw conformanceError(MCP_CONFORMANCE_CODES.revoked, { documentId })
  }
  if (document.revision !== revision) {
    throw conformanceError(MCP_CONFORMANCE_CODES.revisionMismatch, {
      documentId,
      requested: revision,
      pinned: document.revision,
    })
  }
  return {
    locator: `doc://${workspace}/${document.id}@${document.revision}`,
    title: document.title,
    body: document.body,
    revision: document.revision,
  }
}
