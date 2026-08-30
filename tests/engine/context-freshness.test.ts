import assert from "node:assert/strict"
import test from "node:test"

import {
  filterFreshContext,
  type ContextEntry,
} from "../../packages/engine/src/index.js"

const EVENT_AT = "2026-08-26T00:00:00.000Z"

function entry(index: number, extra: Partial<ContextEntry> = {}): ContextEntry {
  const suffix = String(index).padStart(2, "0")
  const occurrenceId = `sha256:${"aa".repeat(31)}${suffix}`
  const artifactId = `sha256:${"bb".repeat(31)}${suffix}`
  return {
    kind: "raw_excerpt",
    text: `text-${index}`,
    artifactId,
    locator: `context://occurrences/${occurrenceId}@1/artifacts/${artifactId}`,
    sourceDigest: `sha256:${"cc".repeat(31)}${suffix}`,
    artifactDigest: `sha256:${"dd".repeat(31)}${suffix}`,
    sourceRevision: 1,
    derivedRevision: 1,
    ruleVersion: "workbench-rules.v1",
    eventAt: EVENT_AT,
    derivedAt: EVENT_AT,
    trust: "untrusted-context-data",
    ...extra,
  }
}

test("no ttl or digest expectations: every entry stays fresh", () => {
  const entries = [entry(1), entry(2), entry(3)]
  const { fresh, evicted } = filterFreshContext(entries, new Date("2030-01-01T00:00:00.000Z"))
  assert.equal(fresh.length, 3)
  assert.equal(evicted.length, 0)
  assert.deepEqual(
    fresh.map((e) => e.artifactId),
    entries.map((e) => e.artifactId),
  )
})

test("ttl elapsed against eventAt: expired entry is evicted, others stay", () => {
  // eventAt = 2026-08-26T00:00:00Z. Ttl = 1 hour. Now is 2 hours later.
  const expiring = entry(1, { ttl: 60 * 60 * 1000 })
  const freshentry = entry(2)
  const { fresh, evicted } = filterFreshContext(
    [expiring, freshentry],
    new Date("2026-08-26T02:00:00.000Z"),
  )
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0]!.artifactId, freshentry.artifactId)
  assert.equal(evicted.length, 1)
  assert.equal(evicted[0]!.id, expiring.artifactId)
  assert.equal(evicted[0]!.reason, "expired")
})

test("ttl unexpired: entry stays fresh", () => {
  // eventAt + 2 hours ttl; now is only 30 min later.
  const living = entry(1, { ttl: 2 * 60 * 60 * 1000 })
  const { fresh, evicted } = filterFreshContext(
    [living],
    new Date("2026-08-26T00:30:00.000Z"),
  )
  assert.equal(fresh.length, 1)
  assert.equal(evicted.length, 0)
})

test("expiresAt wins over ttl when both are set", () => {
  // ttl would say fresh (far future), but expiresAt is in the past.
  const item = entry(1, {
    ttl: 10 * 365 * 24 * 60 * 60 * 1000,
    expiresAt: "2026-08-26T00:15:00.000Z",
  })
  const { fresh, evicted } = filterFreshContext(
    [item],
    new Date("2026-08-26T01:00:00.000Z"),
  )
  assert.equal(fresh.length, 0)
  assert.equal(evicted.length, 1)
  assert.equal(evicted[0]!.reason, "expired")
})

test("digest mismatch: evicted with reason 'digest_mismatch'", () => {
  const a = entry(1)
  const b = entry(2)
  const now = new Date("2030-01-01T00:00:00.000Z")
  const expected = {
    [a.artifactId]: a.sourceDigest, // matches -> fresh
    [b.artifactId]: `sha256:${"ff".repeat(32)}`, // mismatch -> evicted
  }
  const { fresh, evicted } = filterFreshContext([a, b], now, expected)
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0]!.artifactId, a.artifactId)
  assert.equal(evicted.length, 1)
  assert.equal(evicted[0]!.id, b.artifactId)
  assert.equal(evicted[0]!.reason, "digest_mismatch")
})

test("missing expected digest for an artifact is NOT a mismatch", () => {
  // Entry for artifactId b has no expectation => stays fresh.
  const a = entry(1)
  const b = entry(2)
  const now = new Date("2030-01-01T00:00:00.000Z")
  const expected = { [a.artifactId]: a.sourceDigest }
  const { fresh, evicted } = filterFreshContext([a, b], now, expected)
  assert.equal(fresh.length, 2)
  assert.equal(evicted.length, 0)
})

test("expiry takes priority over digest mismatch", () => {
  const item = entry(1, {
    ttl: 1000,
    // eventAt + 1 s expired.
  })
  const now = new Date("2026-08-26T01:00:00.000Z")
  const expected = { [item.artifactId]: "sha256:${'ff'.repeat(32)}" }
  const { fresh, evicted } = filterFreshContext([item], now, expected)
  assert.equal(fresh.length, 0)
  assert.equal(evicted.length, 1)
  assert.equal(evicted[0]!.reason, "expired")
})

test("fresh and evicted counts add up to the input size", () => {
  const expired1 = entry(1, { ttl: 1 })
  const expired2 = entry(2, { expiresAt: "2026-08-26T00:00:01.000Z" })
  const unexpected = entry(3)
  const kept = entry(4)
  const now = new Date("2026-08-26T01:00:00.000Z")
  const expected = {
    [unexpected.artifactId]: "sha256:${'ff'.repeat(32)}",
    [kept.artifactId]: kept.sourceDigest,
  }
  const { fresh, evicted } = filterFreshContext(
    [expired1, expired2, unexpected, kept],
    now,
    expected,
  )
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0]!.artifactId, kept.artifactId)
  assert.equal(evicted.length, 3)
  assert.equal(fresh.length + evicted.length, 4)
  assert.deepEqual(
    evicted.map((e) => e.reason).sort(),
    ["digest_mismatch", "expired", "expired"].sort(),
  )
})

test("fresh entries never carry an evictionReason", () => {
  const tainted = entry(1, { evictionReason: "expired" })
  const { fresh } = filterFreshContext(
    [tainted],
    new Date("2030-01-01T00:00:00.000Z"),
  )
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0]!.evictionReason, undefined)
})
