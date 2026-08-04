import type { KeyLike } from "node:crypto"
import { types as utilTypes } from "node:util"

import { CoreError } from "./contracts.js"
import {
  MAX_RUNNER_CLOCK_SKEW_MS,
  canonicalRunnerJson,
  validateSignedEnvelope,
  validateRunnerTask,
  verifyRunnerTask,
} from "./runner-protocol.js"
import type {
  RunnerTaskPayload,
  SignedEnvelope,
} from "./runner-protocol.js"

const MAX_TIMER_DELAY_MS = 2_147_483_647
export const RUNNER_LEASE_SAFETY_MARGIN_MS = 5_000

export type RunnerLeaseErrorCode =
  | "RUNNER_LEASE_CLOCK_INVALID"
  | "RUNNER_LEASE_KEY_UNAVAILABLE"
  | "RUNNER_LEASE_IDENTITY_MISMATCH"
  | "RUNNER_LEASE_NOT_YET_VALID"
  | "RUNNER_LEASE_EXPIRED"
  | "RUNNER_LEASE_NOT_EXTENDED"

export class RunnerLeaseError extends CoreError {
  constructor(code: RunnerLeaseErrorCode) {
    super(code, "Runner lease could not be accepted safely", {
      status: 400,
      retryable: false,
    })
    this.name = "RunnerLeaseError"
  }
}

export interface CreateRunnerLeaseStateOptions {
  initialEnvelope: unknown
  resolvePlatformPublicKey(keyId: string): KeyLike | Promise<KeyLike>
  clock?: () => Date
}

function leaseError(code: RunnerLeaseErrorCode): never {
  throw new RunnerLeaseError(code)
}

function taskWithoutLeaseExpiry(task: RunnerTaskPayload): unknown {
  const { leaseExpiresAt: _leaseExpiresAt, ...identity } = task
  return identity
}

function sameSignedEnvelope(left: SignedEnvelope, right: SignedEnvelope): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.keyId === right.keyId &&
    left.algorithm === right.algorithm &&
    left.payload === right.payload &&
    left.signature === right.signature
  )
}

function capturedClock(clock: (() => Date) | undefined): () => Date {
  const source = clock ?? (() => new Date())
  let previous = Number.NEGATIVE_INFINITY
  return () => {
    let value: unknown
    try {
      value = source()
    } catch {
      leaseError("RUNNER_LEASE_CLOCK_INVALID")
    }
    if (!(value instanceof Date)) leaseError("RUNNER_LEASE_CLOCK_INVALID")
    const milliseconds = value.getTime()
    if (!Number.isFinite(milliseconds) || milliseconds < previous) {
      leaseError("RUNNER_LEASE_CLOCK_INVALID")
    }
    previous = milliseconds
    return new Date(milliseconds)
  }
}

async function verifiedTask(
  envelopeValue: unknown,
  resolvePlatformPublicKey: (keyId: string) => KeyLike | Promise<KeyLike>,
): Promise<{ envelope: SignedEnvelope; task: RunnerTaskPayload }> {
  const envelope = validateSignedEnvelope(envelopeValue)
  let key: KeyLike
  try {
    key = await resolvePlatformPublicKey(envelope.keyId)
  } catch {
    leaseError("RUNNER_LEASE_KEY_UNAVAILABLE")
  }
  return { envelope, task: verifyRunnerTask({ envelope, publicKey: key }) }
}

/**
 * Verified lease state for an outbound Runner heartbeat loop. It has no
 * transport and never accepts an unsigned timestamp or partial renewal.
 */
export class RunnerLeaseState {
  readonly #resolvePlatformPublicKey: (
    keyId: string,
  ) => KeyLike | Promise<KeyLike>
  readonly #now: () => Date
  readonly #controller = new AbortController()
  #task: RunnerTaskPayload
  #envelope: SignedEnvelope
  #timer: ReturnType<typeof setTimeout> | undefined
  #closed = false

  private constructor(
    task: RunnerTaskPayload,
    envelope: SignedEnvelope,
    resolvePlatformPublicKey: (
      keyId: string,
    ) => KeyLike | Promise<KeyLike>,
    now: () => Date,
  ) {
    this.#task = task
    this.#envelope = envelope
    this.#resolvePlatformPublicKey = resolvePlatformPublicKey
    this.#now = now
    this.#scheduleExpiry()
  }

  static async create(
    options: CreateRunnerLeaseStateOptions,
  ): Promise<RunnerLeaseState> {
    let initialEnvelope: unknown
    let resolvePlatformPublicKey: (
      keyId: string,
    ) => KeyLike | Promise<KeyLike>
    let clock: (() => Date) | undefined
    try {
      if (
        !options ||
        typeof options !== "object" ||
        utilTypes.isProxy(options) ||
        Object.getPrototypeOf(options) !== Object.prototype
      ) {
        leaseError("RUNNER_LEASE_IDENTITY_MISMATCH")
      }
      const descriptors = Object.getOwnPropertyDescriptors(options)
      const keys = Reflect.ownKeys(descriptors)
      if (
        keys.some((key) => typeof key !== "string") ||
        !Object.hasOwn(descriptors, "initialEnvelope") ||
        !Object.hasOwn(descriptors, "resolvePlatformPublicKey") ||
        keys.some(
          (key) =>
            typeof key !== "string" ||
            !["initialEnvelope", "resolvePlatformPublicKey", "clock"].includes(
              key,
            ),
        ) ||
        keys.some((key) => {
          const descriptor = descriptors[key as string]
          return !descriptor || !descriptor.enumerable || !("value" in descriptor)
        })
      ) {
        leaseError("RUNNER_LEASE_IDENTITY_MISMATCH")
      }
      initialEnvelope = descriptors.initialEnvelope.value
      const resolver = descriptors.resolvePlatformPublicKey.value as unknown
      const clockValue = descriptors.clock?.value as unknown
      if (
        typeof resolver !== "function" ||
        (clockValue !== undefined && typeof clockValue !== "function")
      ) {
        leaseError("RUNNER_LEASE_IDENTITY_MISMATCH")
      }
      resolvePlatformPublicKey = resolver as (
        keyId: string,
      ) => KeyLike | Promise<KeyLike>
      clock = clockValue as (() => Date) | undefined
    } catch (error) {
      if (error instanceof RunnerLeaseError) throw error
      leaseError("RUNNER_LEASE_IDENTITY_MISMATCH")
    }
    const now = capturedClock(clock)
    const verified = await verifiedTask(
      initialEnvelope,
      resolvePlatformPublicKey,
    )
    const current = now().getTime()
    if (
      Date.parse(verified.task.issuedAt) >
      current + MAX_RUNNER_CLOCK_SKEW_MS
    ) {
      leaseError("RUNNER_LEASE_NOT_YET_VALID")
    }
    if (
      current >=
        Date.parse(verified.task.leaseExpiresAt) -
          RUNNER_LEASE_SAFETY_MARGIN_MS ||
      current >= Date.parse(verified.task.expiresAt)
    ) {
      leaseError("RUNNER_LEASE_EXPIRED")
    }
    return new RunnerLeaseState(
      verified.task,
      verified.envelope,
      resolvePlatformPublicKey,
      now,
    )
  }

  get task(): RunnerTaskPayload {
    return this.#task
  }

  get envelope(): SignedEnvelope {
    return this.#envelope
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  get leaseExpiresAt(): string {
    return this.#task.leaseExpiresAt
  }

  matchesTask(task: RunnerTaskPayload): boolean {
    try {
      const normalized = validateRunnerTask(task)
      return (
        canonicalRunnerJson(taskWithoutLeaseExpiry(normalized)) ===
        canonicalRunnerJson(taskWithoutLeaseExpiry(this.#task))
      )
    } catch {
      return false
    }
  }

  assertActive(): void {
    if (this.#closed || this.#controller.signal.aborted) {
      leaseError("RUNNER_LEASE_EXPIRED")
    }
    const current = this.#now().getTime()
    if (
      current >=
        Date.parse(this.#task.leaseExpiresAt) -
          RUNNER_LEASE_SAFETY_MARGIN_MS ||
      current >= Date.parse(this.#task.expiresAt)
    ) {
      this.#expire()
      leaseError("RUNNER_LEASE_EXPIRED")
    }
  }

  async acceptRenewal(envelopeValue: unknown): Promise<RunnerTaskPayload> {
    this.assertActive()
    const verified = await verifiedTask(
      envelopeValue,
      this.#resolvePlatformPublicKey,
    )
    // Recheck after asynchronous key lookup/verification. An expired grant can
    // never be resurrected by a delayed heartbeat response.
    this.assertActive()
    if (!this.matchesTask(verified.task)) {
      leaseError("RUNNER_LEASE_IDENTITY_MISMATCH")
    }
    const nextExpiry = Date.parse(verified.task.leaseExpiresAt)
    const currentExpiry = Date.parse(this.#task.leaseExpiresAt)
    if (
      nextExpiry === currentExpiry &&
      sameSignedEnvelope(verified.envelope, this.#envelope)
    ) {
      // The platform may replay the exact response for the same heartbeat
      // idempotency key. This cannot extend or resurrect a lease because both
      // active checks above already passed and state remains unchanged.
      return this.#task
    }
    if (nextExpiry <= currentExpiry) {
      leaseError("RUNNER_LEASE_NOT_EXTENDED")
    }
    if (nextExpiry <= this.#now().getTime() + RUNNER_LEASE_SAFETY_MARGIN_MS) {
      leaseError("RUNNER_LEASE_EXPIRED")
    }
    this.#task = verified.task
    this.#envelope = verified.envelope
    this.#scheduleExpiry()
    return this.#task
  }

  close(): void {
    this.#closed = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(new Error("runner_lease_state_closed"))
    }
  }

  #expire(): void {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(new Error("runner_signed_lease_expired"))
    }
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #scheduleExpiry(): void {
    if (this.#closed || this.#controller.signal.aborted) return
    if (this.#timer) clearTimeout(this.#timer)
    const remaining =
      Date.parse(this.#task.leaseExpiresAt) -
      RUNNER_LEASE_SAFETY_MARGIN_MS -
      this.#now().getTime()
    if (remaining <= 0) {
      this.#expire()
      return
    }
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined
        try {
          if (
            this.#now().getTime() >=
            Date.parse(this.#task.leaseExpiresAt) -
              RUNNER_LEASE_SAFETY_MARGIN_MS
          ) {
            this.#expire()
          } else {
            this.#scheduleExpiry()
          }
        } catch {
          this.#expire()
        }
      },
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    )
    this.#timer.unref()
  }
}
