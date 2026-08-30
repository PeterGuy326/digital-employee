import type { ContextBundleItem } from "../../core/src/context-port.js"

/**
 * Engine-side projection of a context bundle item with OPTIONAL freshness
 * metadata. The wire contract `ContextBundleItem` (#179 REQ-001) is not
 * modified; these fields are annotations layered on top of the read-only
 * ContextPort envelope inside the engine before the assembler consumes it.
 *
 * Prior art: HTTP ETag / Cache-Control (expiry + revalidation) and Docker
 * layer digests (content-address invalidation). Two orthogonal knobs:
 *  - Time-based: `ttl` (ms since `eventAt`) OR `expiresAt` (ISO); either
 *    may be provided. If both are present, `expiresAt` wins.
 *  - Content-based: `sourceDigest` compared against the caller-supplied
 *    `expectedDigests` map keyed by `artifactId`. A mismatch evicts.
 *
 * All fields are OPTIONAL — an entry with none behaves exactly as before.
 * `evictionReason` is a diagnostic slot for downstream evidence; the
 * filter always returns it on evicted entries and never on fresh ones.
 */
export type ContextEvictionReason = "expired" | "digest_mismatch"

export interface ContextEntry extends ContextBundleItem {
  /** Optional lifetime in milliseconds, measured from `eventAt`. */
  ttl?: number
  /** Optional absolute expiry (ISO 8601). Overrides `ttl` if both set. */
  expiresAt?: string
  /**
   * Optional diagnostic label populated by the filter when an entry is
   * evicted; never present on entries that stay in the `fresh` set.
   * (The wire `sourceDigest` field remains the content-address anchor.)
   */
  evictionReason?: ContextEvictionReason
}

export interface EvictedContextEntry {
  id: string
  reason: ContextEvictionReason
}

export interface FilterFreshContextResult {
  fresh: ContextEntry[]
  evicted: EvictedContextEntry[]
}

/**
 * Compute the effective expiry timestamp (ms since epoch) for an entry,
 * or `undefined` if the entry has no time-based freshness signal.
 * `expiresAt` (absolute) wins over `ttl` (relative to `eventAt`).
 */
function resolveExpiryMs(entry: ContextEntry): number | undefined {
  if (entry.expiresAt !== undefined) {
    const parsed = Date.parse(entry.expiresAt)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (entry.ttl !== undefined && Number.isFinite(entry.ttl) && entry.ttl >= 0) {
    const anchor = Date.parse(entry.eventAt)
    return Number.isFinite(anchor) ? anchor + entry.ttl : undefined
  }
  return undefined
}

/**
 * Stable identifier for eviction reporting. `artifactId` is content-addressed
 * and unique within a bundle, so it doubles as the eviction key.
 */
function entryId(entry: ContextEntry): string {
  return entry.artifactId
}

/**
 * Pure function: partition `entries` into `fresh` and `evicted` sets given
 * a monotonic `now` clock and an `expectedDigests` map from `artifactId`
 * to the expected `sourceDigest`. Entries without a corresponding entry
 * in the map are not digest-checked (missing expectation is not a mismatch);
 * this keeps rollout incremental and back-compatible with callers that do
 * not yet know a digest.
 *
 * Ordering: expiry is checked before digest, so an expired entry that also
 * has a stale digest is reported as `expired` (time-based invalidation is
 * cheaper and more intuitive to reason about first).
 */
export function filterFreshContext(
  entries: readonly ContextEntry[],
  now: Date,
  expectedDigests: Readonly<Record<string, string>> = {},
): FilterFreshContextResult {
  const nowMs = now.getTime()
  const fresh: ContextEntry[] = []
  const evicted: EvictedContextEntry[] = []

  for (const entry of entries) {
    const expiryMs = resolveExpiryMs(entry)
    if (expiryMs !== undefined && expiryMs <= nowMs) {
      evicted.push({ id: entryId(entry), reason: "expired" })
      continue
    }
    const expected = expectedDigests[entry.artifactId]
    if (expected !== undefined && expected !== entry.sourceDigest) {
      evicted.push({ id: entryId(entry), reason: "digest_mismatch" })
      continue
    }
    // Strip any lingering `evictionReason` so fresh entries never carry one.
    if (entry.evictionReason !== undefined) {
      const { evictionReason: _drop, ...clean } = entry
      fresh.push(clean)
    } else {
      fresh.push(entry)
    }
  }

  return { fresh, evicted }
}
