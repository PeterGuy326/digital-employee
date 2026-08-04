import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import test from "node:test"

import { RunnerLeaseState } from "../../packages/core/src/runner-lease.js"
import {
  RUNNER_PROTOCOL_VERSION,
  encodeOpaqueJson,
  signRunnerTask,
} from "../../packages/core/src/runner-protocol.js"
import type { RunnerTaskPayload } from "../../packages/core/src/runner-protocol.js"

const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`

function task(overrides: Partial<RunnerTaskPayload> = {}): RunnerTaskPayload {
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.task",
    taskId: "task-lease",
    runId: "run-lease",
    attempt: 1,
    fencingToken: 1,
    leaseId: "lease-1",
    quoteId: "quote-1",
    reservationId: "reservation-1",
    sellerId: "seller-1",
    runnerId: "runner-1",
    employee: {
      id: "answer-agent",
      version: "1.0.0",
      packageDigest: PACKAGE_DIGEST,
    },
    engine: "claude-code",
    input: encodeOpaqueJson({ message: "hello" }),
    issuedAt: "2026-08-04T00:00:00.000Z",
    expiresAt: "2026-08-04T00:05:00.000Z",
    leaseExpiresAt: "2026-08-04T00:00:30.000Z",
    nonce: Buffer.alloc(16, 9).toString("base64url"),
    ...overrides,
  }
}

function code(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined
}

test("lease state accepts only a canonical platform-signed monotonic renewal", async () => {
  const keys = generateKeyPairSync("ed25519")
  let now = new Date("2026-08-04T00:00:01.000Z")
  const signed = (value: RunnerTaskPayload) =>
    signRunnerTask({
      task: value,
      keyId: "platform-key-1",
      privateKey: keys.privateKey,
    })
  const initial = task()
  const state = await RunnerLeaseState.create({
    initialEnvelope: signed(initial),
    resolvePlatformPublicKey: () => keys.publicKey,
    clock: () => now,
  })
  try {
    state.assertActive()
    const renewalEnvelope = signed(
      task({ leaseExpiresAt: "2026-08-04T00:01:00.000Z" }),
    )
    const renewed = await state.acceptRenewal(renewalEnvelope)
    assert.equal(renewed.leaseExpiresAt, "2026-08-04T00:01:00.000Z")
    assert.equal(state.leaseExpiresAt, renewed.leaseExpiresAt)

    assert.equal(
      await state.acceptRenewal(renewalEnvelope),
      renewed,
    )
    await assert.rejects(
      () =>
        state.acceptRenewal(
          signRunnerTask({
            task: renewed,
            keyId: "platform-key-alias",
            privateKey: keys.privateKey,
          }),
        ),
      (error) => code(error) === "RUNNER_LEASE_NOT_EXTENDED",
    )
    await assert.rejects(
      () =>
        state.acceptRenewal(
          signed(task({ leaseExpiresAt: "2026-08-04T00:00:45.000Z" })),
        ),
      (error) => code(error) === "RUNNER_LEASE_NOT_EXTENDED",
    )
    await assert.rejects(
      () =>
        state.acceptRenewal(
          signed({
            ...task({ leaseExpiresAt: "2026-08-04T00:02:00.000Z" }),
            fencingToken: 2,
          }),
        ),
      (error) => code(error) === "RUNNER_LEASE_IDENTITY_MISMATCH",
    )
    await assert.rejects(
      () => state.acceptRenewal({ leaseExpiresAt: "2026-08-04T00:03:00.000Z" }),
    )

    now = new Date("2026-08-04T00:01:00.000Z")
    assert.throws(
      () => state.assertActive(),
      (error) => code(error) === "RUNNER_LEASE_EXPIRED",
    )
    assert.equal(state.signal.aborted, true)
    await assert.rejects(
      () =>
        state.acceptRenewal(
          signed(task({ leaseExpiresAt: "2026-08-04T00:04:00.000Z" })),
        ),
      (error) => code(error) === "RUNNER_LEASE_EXPIRED",
    )
  } finally {
    state.close()
  }
})

test("lease state refuses to start inside the signed upload safety margin", async () => {
  const keys = generateKeyPairSync("ed25519")
  const initialEnvelope = signRunnerTask({
    task: task(),
    keyId: "platform-key-1",
    privateKey: keys.privateKey,
  })
  await assert.rejects(
    () =>
      RunnerLeaseState.create({
        initialEnvelope,
        resolvePlatformPublicKey: () => keys.publicKey,
        clock: () => new Date("2026-08-04T00:00:25.000Z"),
      }),
    (error) => code(error) === "RUNNER_LEASE_EXPIRED",
  )
})

test("lease state options accessors are rejected without invocation", async () => {
  let reads = 0
  const options = {
    get initialEnvelope() {
      reads += 1
      return {}
    },
    resolvePlatformPublicKey() {
      throw new Error("not called")
    },
  }
  await assert.rejects(
    () => RunnerLeaseState.create(options),
    (error) => code(error) === "RUNNER_LEASE_IDENTITY_MISMATCH",
  )
  assert.equal(reads, 0)

  let traps = 0
  const proxy = new Proxy(options, {
    get() {
      traps += 1
      throw new Error("proxy get trap must not run")
    },
    getPrototypeOf() {
      traps += 1
      throw new Error("proxy prototype trap must not run")
    },
    ownKeys() {
      traps += 1
      throw new Error("proxy ownKeys trap must not run")
    },
  })
  await assert.rejects(
    () => RunnerLeaseState.create(proxy),
    (error) => code(error) === "RUNNER_LEASE_IDENTITY_MISMATCH",
  )
  assert.equal(traps, 0)
})

test("lease renewal rejects wrong signatures and every foreign identity field", async () => {
  const keys = generateKeyPairSync("ed25519")
  const other = generateKeyPairSync("ed25519")
  const signed = (value: RunnerTaskPayload, wrong = false) =>
    signRunnerTask({
      task: value,
      keyId: "platform-key-1",
      privateKey: wrong ? other.privateKey : keys.privateKey,
    })
  const state = await RunnerLeaseState.create({
    initialEnvelope: signed(task()),
    resolvePlatformPublicKey: () => keys.publicKey,
    clock: () => new Date("2026-08-04T00:00:01.000Z"),
  })
  try {
    await assert.rejects(() =>
      state.acceptRenewal(
        signed(
          task({ leaseExpiresAt: "2026-08-04T00:01:00.000Z" }),
          true,
        ),
      ),
    )
    for (const foreign of [
      task({ taskId: "task-foreign", leaseExpiresAt: "2026-08-04T00:01:00.000Z" }),
      task({ runId: "run-foreign", leaseExpiresAt: "2026-08-04T00:01:00.000Z" }),
      task({ attempt: 2, leaseExpiresAt: "2026-08-04T00:01:00.000Z" }),
      task({ leaseId: "lease-foreign", leaseExpiresAt: "2026-08-04T00:01:00.000Z" }),
      task({ runnerId: "runner-foreign", leaseExpiresAt: "2026-08-04T00:01:00.000Z" }),
      task({ nonce: Buffer.alloc(16, 8).toString("base64url"), leaseExpiresAt: "2026-08-04T00:01:00.000Z" }),
      task({
        employee: { ...task().employee, packageDigest: `sha256:${"b".repeat(64)}` },
        leaseExpiresAt: "2026-08-04T00:01:00.000Z",
      }),
    ]) {
      await assert.rejects(
        () => state.acceptRenewal(signed(foreign)),
        (error) => code(error) === "RUNNER_LEASE_IDENTITY_MISMATCH",
      )
    }
  } finally {
    state.close()
  }
})
