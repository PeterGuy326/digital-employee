import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { AGENT_HOST_PROTOCOL_VERSION } from "../../packages/core/src/agent-host.js"
import {
  AGENT_HOST_VECTOR_FAMILIES,
  AGENT_HOST_VECTOR_SCHEMA_VERSION,
  parseAgentHostVectorFile,
  parseAgentHostVectorManifest,
  runAgentHostVectorCorpus,
} from "../../packages/core/src/agent-host-vectors.js"

const corpusRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/agent-host-vectors/v1",
)

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(corpusRoot, name), "utf8"))
}

test("corpus manifest parses and pins every family", () => {
  const manifest = parseAgentHostVectorManifest(readJson("manifest.json"))
  assert.equal(manifest.schemaVersion, AGENT_HOST_VECTOR_SCHEMA_VERSION)
  assert.equal(manifest.protocolVersion, AGENT_HOST_PROTOCOL_VERSION)
  assert.deepEqual([...manifest.families], [...AGENT_HOST_VECTOR_FAMILIES])
  assert.equal(manifest.files.length, AGENT_HOST_VECTOR_FAMILIES.length)
})

test("corpus manifest digests match the shipped fixture files", () => {
  const manifest = parseAgentHostVectorManifest(readJson("manifest.json"))
  for (const entry of manifest.files) {
    const raw = readFileSync(path.join(corpusRoot, entry.file))
    const digest = createHash("sha256").update(raw).digest("hex")
    assert.equal(digest, entry.sha256, `digest mismatch for ${entry.file}`)
  }
})

test("corpus files parse with matching family and vector counts", () => {
  const manifest = parseAgentHostVectorManifest(readJson("manifest.json"))
  for (const entry of manifest.files) {
    const raw = readJson(entry.file) as { family: unknown }
    assert.ok(
      AGENT_HOST_VECTOR_FAMILIES.includes(
        raw.family as (typeof AGENT_HOST_VECTOR_FAMILIES)[number],
      ),
      `unknown family in ${entry.file}`,
    )
    const family = raw.family as (typeof AGENT_HOST_VECTOR_FAMILIES)[number]
    const file = parseAgentHostVectorFile(raw, family)
    assert.equal(file.vectors.length, entry.vectorCount, entry.file)
  }
})

test("corpus rejects malformed files fail-closed", () => {
  assert.throws(() => parseAgentHostVectorFile({}, "probe"))
  assert.throws(() =>
    parseAgentHostVectorFile(
      {
        schemaVersion: AGENT_HOST_VECTOR_SCHEMA_VERSION,
        family: "probe",
        vectors: [
          {
            id: "a",
            family: "probe",
            input: {},
            expect: { kind: "accept" },
          },
          {
            id: "a",
            family: "probe",
            input: {},
            expect: { kind: "accept" },
          },
        ],
      },
      "probe",
    ),
  )
  assert.throws(() => parseAgentHostVectorManifest({}))
})

test("shipped golden vector corpus classifies to PASS", () => {
  const manifest = parseAgentHostVectorManifest(readJson("manifest.json"))
  const files = manifest.files.map((entry) => {
    const raw = readJson(entry.file) as { family: unknown }
    return parseAgentHostVectorFile(
      raw,
      raw.family as (typeof AGENT_HOST_VECTOR_FAMILIES)[number],
    )
  })
  const result = runAgentHostVectorCorpus(files)
  assert.deepEqual(
    result.failed,
    [],
    JSON.stringify(result.failed, null, 2),
  )
  assert.equal(result.result, "PASS")
  assert.equal(result.total, result.passed)
  assert.equal(result.protocolVersion, AGENT_HOST_PROTOCOL_VERSION)
})
