import assert from "node:assert/strict"
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto"
import test from "node:test"

import {
  RUNNER_EVENT_GENESIS_DIGEST,
  MAX_RUNNER_ATTEMPTS,
  MIN_RUNNER_LEASE_MILLISECONDS,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_RECEIPT_DOMAIN,
  RUNNER_TASK_DOMAIN,
  canonicalRunnerJson,
  createRunnerEvent,
  decodeOpaqueJson,
  encodeOpaqueJson,
  signRunnerEnvelope,
  signRunnerReceipt,
  signRunnerTask,
  validateRunnerTask,
  verifyRunnerEnvelope,
  verifyRunnerExecutionBundle,
  verifyRunnerEventChain,
  verifyRunnerReceipt,
  verifyRunnerTask,
} from "../../packages/core/src/runner-protocol.js"
import type {
  RunnerReceiptPayload,
  RunnerTaskPayload,
} from "../../packages/core/src/runner-protocol.js"

const RFC8032_SEED =
  "9d61b19deffd5a60ba844af492ec2cc4" +
  "4449c5697b326919703bac031cae7f60"
const RFC8032_PUBLIC =
  "d75a980182b10ab7d54bfed3c964073a" +
  "0ee172f3daa62325af021a68f707511a"
const RFC8032_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(`302e020100300506032b657004220420${RFC8032_SEED}`, "hex"),
  format: "der",
  type: "pkcs8",
})
const RFC8032_PUBLIC_KEY = createPublicKey({
  key: Buffer.from(`302a300506032b6570032100${RFC8032_PUBLIC}`, "hex"),
  format: "der",
  type: "spki",
})

const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`

function task(overrides: Partial<RunnerTaskPayload> = {}): RunnerTaskPayload {
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.task",
    taskId: "task-golden",
    runId: "run-golden",
    attempt: 1,
    fencingToken: 1,
    leaseId: "lease-golden",
    quoteId: "quote-golden",
    reservationId: "reservation-golden",
    sellerId: "seller-golden",
    runnerId: "runner-golden",
    employee: {
      id: "employee-golden",
      version: "1.2.3",
      packageDigest: PACKAGE_DIGEST,
    },
    engine: "claude-code",
    input: encodeOpaqueJson({ question: "hello" }),
    issuedAt: "2026-08-04T00:00:00.000Z",
    expiresAt: "2026-08-04T00:05:00.000Z",
    leaseExpiresAt: "2026-08-04T00:00:30.000Z",
    nonce: Buffer.alloc(16, 7).toString("base64url"),
    ...overrides,
  }
}

function receipt(
  overrides: Partial<RunnerReceiptPayload> = {},
): RunnerReceiptPayload {
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.receipt",
    taskId: "task-001",
    runId: "run-001",
    attempt: 1,
    fencingToken: 1,
    leaseId: "lease-001",
    quoteId: "quote-001",
    reservationId: "reservation-001",
    sellerId: "seller-001",
    runnerId: "runner-001",
    employee: {
      id: "answer-agent",
      version: "1.2.3",
      packageDigest: PACKAGE_DIGEST,
    },
    engine: "claude-code",
    startedAt: "2026-08-04T06:00:01.000Z",
    completedAt: "2026-08-04T06:00:02.000Z",
    eventCount: 0,
    finalEventDigest: RUNNER_EVENT_GENESIS_DIGEST,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      durationMilliseconds: 1_000,
      actions: [{ name: "knowledge.search", count: 1 }],
    },
    outcome: { status: "completed", output: encodeOpaqueJson({ ok: true }) },
    ...overrides,
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined
}

test("task envelopes sign the exact raw bytes with domain separation", () => {
  const envelope = signRunnerTask({
    task: task(),
    keyId: "platform-rfc8032-1",
    privateKey: RFC8032_PRIVATE_KEY,
  })
  assert.equal(
    Buffer.from(envelope.payload, "base64url").toString("utf8"),
    canonicalRunnerJson(task()),
  )
  assert.equal(
    envelope.signature,
    "5GqPE97cGFn6l3rlcHDTqY1pzc6Gazx41D14_kuC9Etr7SiZ5eE4KZ4sxlhzaMwj-i4S8NagUlQjxX8FhwaWCA",
  )
  assert.deepEqual(
    verifyRunnerTask({ envelope, publicKey: RFC8032_PUBLIC_KEY }),
    task(),
  )
  const event = createRunnerEvent({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.event",
    taskId: "task-golden",
    runId: "run-golden",
    attempt: 1,
    fencingToken: 1,
    leaseId: "lease-golden",
    quoteId: "quote-golden",
    runnerId: "runner-golden",
    employeeId: "employee-golden",
    packageDigest: PACKAGE_DIGEST,
    sequence: 1,
    timestamp: "2026-08-04T00:00:01.000Z",
    type: "run.started",
    data: { mediaType: "application/json", encoding: "base64url", data: "" },
    previousDigest: RUNNER_EVENT_GENESIS_DIGEST,
  })
  assert.equal(
    event.digest,
    "sha256:5ded5f44a88c80f68205e10d67d082cfa387e979bada69ea8632c2da1e7f3ef3",
  )
  const goldenReceipt: RunnerReceiptPayload = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.receipt",
    taskId: "task-golden",
    runId: "run-golden",
    attempt: 1,
    fencingToken: 1,
    leaseId: "lease-golden",
    quoteId: "quote-golden",
    reservationId: "reservation-golden",
    sellerId: "seller-golden",
    runnerId: "runner-golden",
    employee: {
      id: "employee-golden",
      version: "1.2.3",
      packageDigest: PACKAGE_DIGEST,
    },
    engine: "claude-code",
    startedAt: "2026-08-04T00:00:01.000Z",
    completedAt: "2026-08-04T00:00:02.000Z",
    eventCount: 1,
    finalEventDigest:
      "sha256:5ded5f44a88c80f68205e10d67d082cfa387e979bada69ea8632c2da1e7f3ef3",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      durationMilliseconds: 1_000,
      actions: [{ name: "knowledge.search", count: 1 }],
    },
    outcome: {
      status: "completed",
      output: encodeOpaqueJson({ answer: "ok" }),
    },
    providerEvidence: encodeOpaqueJson({ provider: "fixture" }),
  }
  const goldenReceiptEnvelope = signRunnerReceipt({
    receipt: goldenReceipt,
    keyId: "runner-key-1",
    privateKey: RFC8032_PRIVATE_KEY,
  })
  assert.equal(
    goldenReceiptEnvelope.signature,
    "40WM6M_D9JCqSxZwNNWKSPp6iYBz2qyl3OgkFN7tcgI65Hz2VEKwP3AIezZiwHc25q-aGnw96hOTK3cVANa_Dg",
  )
  assert.deepEqual(
    verifyRunnerReceipt({
      envelope: goldenReceiptEnvelope,
      publicKey: RFC8032_PUBLIC_KEY,
    }),
    goldenReceipt,
  )
})

test("non-canonical signed task bytes are rejected after signature verification", () => {
  const raw = Buffer.from(JSON.stringify(task(), null, 2), "utf8")
  const envelope = signRunnerEnvelope({
    domain: RUNNER_TASK_DOMAIN,
    keyId: "platform-key-1",
    privateKey: RFC8032_PRIVATE_KEY,
    payload: raw,
  })
  assert.equal(
    verifyRunnerEnvelope({
      domain: RUNNER_TASK_DOMAIN,
      envelope,
      publicKey: RFC8032_PUBLIC_KEY,
    }).compare(raw),
    0,
  )
  assert.throws(
    () => verifyRunnerTask({ envelope, publicKey: RFC8032_PUBLIC_KEY }),
    (error) => errorCode(error) === "RUNNER_TASK_INVALID",
  )
})

test("forged payloads, wrong keys, and wrong domains fail closed", () => {
  const envelope = signRunnerTask({
    task: task(),
    keyId: "platform-key-1",
    privateKey: RFC8032_PRIVATE_KEY,
  })
  const forged = {
    ...envelope,
    payload: Buffer.from(
      Buffer.from(envelope.payload, "base64url")
        .toString("utf8")
        .replace("task-golden", "task-forged"),
    ).toString("base64url"),
  }
  assert.throws(
    () => verifyRunnerTask({ envelope: forged, publicKey: RFC8032_PUBLIC_KEY }),
    (error) => errorCode(error) === "RUNNER_SIGNATURE_INVALID",
  )

  const other = generateKeyPairSync("ed25519")
  assert.throws(
    () => verifyRunnerTask({ envelope, publicKey: other.publicKey }),
    (error) => errorCode(error) === "RUNNER_SIGNATURE_INVALID",
  )
  assert.throws(
    () =>
      verifyRunnerEnvelope({
        domain: RUNNER_RECEIPT_DOMAIN,
        envelope,
        publicKey: RFC8032_PUBLIC_KEY,
      }),
    (error) => errorCode(error) === "RUNNER_SIGNATURE_INVALID",
  )
})

test("task validation enforces strict schema, canonical UTC, nonce, and SemVer", () => {
  for (const invalid of [
    { ...task(), surprise: true },
    task({ nonce: "short" }),
    task({ issuedAt: "2026-08-04T06:00:00Z" }),
    task({ leaseExpiresAt: "2026-08-04T06:11:00.000Z" }),
    task({ expiresAt: "2026-08-04T00:00:00.000Z" }),
    task({ attempt: MAX_RUNNER_ATTEMPTS + 1 }),
    task({ leaseExpiresAt: "2026-08-04T00:00:09.999Z" }),
    task({ employee: { ...task().employee, version: "1.0.0-01" } }),
    task({
      employee: {
        ...task().employee,
        version: `1.0.0+${"a".repeat(123)}`,
      },
    }),
  ]) {
    assert.throws(
      () => validateRunnerTask(invalid),
      (error) => errorCode(error) === "RUNNER_TASK_INVALID",
    )
  }
  assert.equal(MIN_RUNNER_LEASE_MILLISECONDS, 10_000)
})

test("wire validation rejects accessors without invoking them", () => {
  let reads = 0
  const accessorEnvelope = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    keyId: "key-1",
    algorithm: "Ed25519",
    payload: "e30",
    get signature() {
      reads += 1
      return "x"
    },
  }
  assert.throws(
    () =>
      verifyRunnerEnvelope({
        domain: RUNNER_TASK_DOMAIN,
        envelope: accessorEnvelope,
        publicKey: RFC8032_PUBLIC_KEY,
      }),
    (error) => errorCode(error) === "RUNNER_ENVELOPE_INVALID",
  )
  assert.equal(reads, 0)

  const employee = task().employee
  Object.defineProperty(employee, "id", {
    enumerable: true,
    get() {
      reads += 1
      return "answer-agent"
    },
  })
  assert.throws(
    () => validateRunnerTask({ ...task(), employee }),
    (error) => errorCode(error) === "RUNNER_TASK_INVALID",
  )
  assert.equal(reads, 0)
})

test("runner events are identity-bound and form a tamper-evident chain", () => {
  const first = createRunnerEvent({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.event",
    taskId: "task-001",
    runId: "run-001",
    attempt: 1,
    fencingToken: 1,
    leaseId: "lease-001",
    quoteId: "quote-001",
    runnerId: "runner-001",
    employeeId: "answer-agent",
    packageDigest: PACKAGE_DIGEST,
    sequence: 1,
    timestamp: "2026-08-04T06:00:01.000Z",
    type: "run.started",
    data: encodeOpaqueJson({}),
    previousDigest: RUNNER_EVENT_GENESIS_DIGEST,
  })
  const { digest: _firstDigest, ...firstWithoutDigest } = first
  const second = createRunnerEvent({
    ...firstWithoutDigest,
    sequence: 2,
    timestamp: "2026-08-04T06:00:02.000Z",
    type: "usage",
    data: encodeOpaqueJson({ inputTokens: 10, outputTokens: 5 }),
    previousDigest: first.digest,
  })
  const chain = verifyRunnerEventChain([first, second], {
    taskId: "task-001",
    runId: "run-001",
    attempt: 1,
    fencingToken: 1,
    leaseId: "lease-001",
    quoteId: "quote-001",
    runnerId: "runner-001",
    employeeId: "answer-agent",
    packageDigest: PACKAGE_DIGEST,
  })
  assert.equal(chain.finalDigest, second.digest)

  assert.throws(
    () =>
      verifyRunnerEventChain([
        first,
        { ...second, type: "run.completed" },
      ]),
    (error) => errorCode(error) === "RUNNER_EVENT_CHAIN_INVALID",
  )
  assert.throws(
    () => verifyRunnerEventChain([second, first]),
    (error) => errorCode(error) === "RUNNER_EVENT_CHAIN_INVALID",
  )
  assert.throws(() =>
    createRunnerEvent({
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      kind: "runner.event",
      taskId: "task-001",
      runId: "run-001",
      attempt: 1,
      fencingToken: 1,
      leaseId: "lease-001",
      quoteId: "quote-001",
      runnerId: "runner-001",
      employeeId: "answer-agent",
      packageDigest: PACKAGE_DIGEST,
      sequence: 1,
      timestamp: "2026-08-04T06:00:01.000Z",
      type: "Run.Started",
      data: encodeOpaqueJson({}),
      previousDigest: RUNNER_EVENT_GENESIS_DIGEST,
    }),
  )
  assert.throws(() =>
    createRunnerEvent({
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      kind: "runner.event",
      taskId: "task-001",
      runId: "run-001",
      attempt: MAX_RUNNER_ATTEMPTS + 1,
      fencingToken: 1,
      leaseId: "lease-001",
      quoteId: "quote-001",
      runnerId: "runner-001",
      employeeId: "answer-agent",
      packageDigest: PACKAGE_DIGEST,
      sequence: 1,
      timestamp: "2026-08-04T06:00:01.000Z",
      type: "run.started",
      data: encodeOpaqueJson({}),
      previousDigest: RUNNER_EVENT_GENESIS_DIGEST,
    }),
  )
})

test("execution bundles bind task, chain, receipt, lease, and clock skew", () => {
  const bundleTask = task({ leaseExpiresAt: "2026-08-04T00:04:00.000Z" })
  const event = createRunnerEvent({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.event",
    taskId: bundleTask.taskId,
    runId: bundleTask.runId,
    attempt: bundleTask.attempt,
    fencingToken: bundleTask.fencingToken,
    leaseId: bundleTask.leaseId,
    quoteId: bundleTask.quoteId,
    runnerId: bundleTask.runnerId,
    employeeId: bundleTask.employee.id,
    packageDigest: bundleTask.employee.packageDigest,
    sequence: 1,
    timestamp: "2026-08-04T00:00:01.000Z",
    type: "run.started",
    data: encodeOpaqueJson({}),
    previousDigest: RUNNER_EVENT_GENESIS_DIGEST,
  })
  const bundleReceipt: RunnerReceiptPayload = {
    ...receipt(),
    taskId: bundleTask.taskId,
    runId: bundleTask.runId,
    attempt: bundleTask.attempt,
    fencingToken: bundleTask.fencingToken,
    leaseId: bundleTask.leaseId,
    quoteId: bundleTask.quoteId,
    reservationId: bundleTask.reservationId,
    sellerId: bundleTask.sellerId,
    runnerId: bundleTask.runnerId,
    employee: bundleTask.employee,
    engine: bundleTask.engine,
    startedAt: "2026-08-04T00:00:01.000Z",
    completedAt: "2026-08-04T00:00:02.000Z",
    eventCount: 1,
    finalEventDigest: event.digest,
  }
  const verified = verifyRunnerExecutionBundle({
    task: bundleTask,
    events: [event],
    receipt: bundleReceipt,
    observedAt: "2026-08-04T00:00:03.000Z",
  })
  assert.equal(verified.events[0]?.digest, event.digest)
  assert.throws(() =>
    verifyRunnerExecutionBundle({
      task: bundleTask,
      events: [event],
      receipt: { ...bundleReceipt, runnerId: "foreign-runner" },
      observedAt: "2026-08-04T00:00:03.000Z",
    }),
  )
  assert.throws(() =>
    verifyRunnerExecutionBundle({
      task: bundleTask,
      events: [event],
      receipt: {
        ...bundleReceipt,
        completedAt: bundleTask.leaseExpiresAt,
      },
      observedAt: bundleTask.leaseExpiresAt,
    }),
  )
  const { digest: _digest, ...eventCore } = event
  const skewAcceptedEvent = createRunnerEvent({
    ...eventCore,
    timestamp: "2026-08-04T00:00:33.000Z",
  })
  assert.doesNotThrow(() =>
    verifyRunnerExecutionBundle({
      task: bundleTask,
      events: [skewAcceptedEvent],
      receipt: {
        ...bundleReceipt,
        completedAt: "2026-08-04T00:00:33.000Z",
        finalEventDigest: skewAcceptedEvent.digest,
      },
      observedAt: "2026-08-04T00:00:04.000Z",
    }),
  )
  const futureEvent = createRunnerEvent({
    ...eventCore,
    timestamp: "2026-08-04T00:00:34.001Z",
  })
  assert.throws(() =>
    verifyRunnerExecutionBundle({
      task: bundleTask,
      events: [futureEvent],
      receipt: {
        ...bundleReceipt,
        completedAt: "2026-08-04T00:00:34.001Z",
        finalEventDigest: futureEvent.digest,
      },
      observedAt: "2026-08-04T00:00:04.000Z",
    }),
  )
})

test("receipts are strict, signed, and never accept a platform user-cancel outcome", () => {
  const envelope = signRunnerReceipt({
    receipt: receipt(),
    keyId: "runner-rfc8032-1",
    privateKey: RFC8032_PRIVATE_KEY,
  })
  assert.deepEqual(
    verifyRunnerReceipt({ envelope, publicKey: RFC8032_PUBLIC_KEY }),
    receipt(),
  )
  assert.throws(
    () =>
      signRunnerReceipt({
        receipt: receipt({
          outcome: { status: "user_cancelled" } as never,
        }),
        keyId: "runner-rfc8032-1",
        privateKey: RFC8032_PRIVATE_KEY,
      }),
    (error) => errorCode(error) === "RUNNER_RECEIPT_INVALID",
  )
  assert.throws(
    () =>
      signRunnerReceipt({
        receipt: receipt({
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            durationMilliseconds: 0,
            actions: [
              { name: "z.action", count: 1 },
              { name: "a.action", count: 1 },
            ],
          },
        }),
        keyId: "runner-rfc8032-1",
        privateKey: RFC8032_PRIVATE_KEY,
      }),
    (error) => errorCode(error) === "RUNNER_RECEIPT_INVALID",
  )
  assert.throws(() =>
    signRunnerReceipt({
      receipt: receipt({
        eventCount: 1,
        finalEventDigest: RUNNER_EVENT_GENESIS_DIGEST,
      }),
      keyId: "runner-rfc8032-1",
      privateKey: RFC8032_PRIVATE_KEY,
    }),
  )
  assert.throws(() =>
    signRunnerReceipt({
      receipt: receipt({
        eventCount: 0,
        finalEventDigest: `sha256:${"b".repeat(64)}`,
      }),
      keyId: "runner-rfc8032-1",
      privateKey: RFC8032_PRIVATE_KEY,
    }),
  )
  assert.throws(() =>
    signRunnerReceipt({
      receipt: receipt({
        outcome: { status: "failed", errorCode: "Bad:Code" },
      }),
      keyId: "runner-rfc8032-1",
      privateKey: RFC8032_PRIVATE_KEY,
    }),
  )
  assert.throws(() =>
    signRunnerReceipt({
      receipt: receipt({ attempt: MAX_RUNNER_ATTEMPTS + 1 }),
      keyId: "runner-rfc8032-1",
      privateKey: RFC8032_PRIVATE_KEY,
    }),
  )
})

test("canonical JSON rejects accessors, sparse arrays, and unsafe numbers", () => {
  let reads = 0
  const accessor = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      reads += 1
      return "not-read"
    },
  })
  assert.throws(() => canonicalRunnerJson(accessor))
  assert.equal(reads, 0)
  assert.throws(() => canonicalRunnerJson(new Array(1)))
  const extraIndex: unknown[] = []
  Object.defineProperty(extraIndex, "4294967295", {
    enumerable: true,
    value: "hidden-from-length",
  })
  assert.throws(() => canonicalRunnerJson(extraIndex))
  assert.throws(() => canonicalRunnerJson({ value: undefined }))
  assert.throws(() =>
    canonicalRunnerJson(
      Object.defineProperty({}, "hidden", { value: true, enumerable: false }),
    ),
  )
  assert.throws(() => canonicalRunnerJson({ [Symbol("hidden")]: true }))
  assert.throws(() => canonicalRunnerJson(Number.POSITIVE_INFINITY))
  assert.throws(() => canonicalRunnerJson(1.5))
  assert.throws(() => canonicalRunnerJson(-0))
  const cycle: { self?: unknown } = {}
  cycle.self = cycle
  assert.throws(() => canonicalRunnerJson(cycle))
  assert.throws(() =>
    canonicalRunnerJson(
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("proxy trap")
          },
        },
      ),
    ),
  )
})

test("wire parsing rejects proxies without invoking any proxy trap", () => {
  let traps = 0
  const trapHandler: ProxyHandler<object> = {
    get() {
      traps += 1
      throw new Error("get trap must not run")
    },
    getPrototypeOf() {
      traps += 1
      throw new Error("getPrototypeOf trap must not run")
    },
    getOwnPropertyDescriptor() {
      traps += 1
      throw new Error("getOwnPropertyDescriptor trap must not run")
    },
    ownKeys() {
      traps += 1
      throw new Error("ownKeys trap must not run")
    },
  }

  assert.throws(
    () => validateRunnerTask(new Proxy(task(), trapHandler)),
    (error) => errorCode(error) === "RUNNER_TASK_INVALID",
  )

  const proxiedOutcome = new Proxy(
    { status: "completed" },
    trapHandler,
  )
  assert.throws(
    () => signRunnerReceipt({
      receipt: receipt({ outcome: proxiedOutcome as never }),
      keyId: "runner-rfc8032-1",
      privateKey: RFC8032_PRIVATE_KEY,
    }),
    (error) => errorCode(error) === "RUNNER_RECEIPT_INVALID",
  )

  const proxiedActions = new Proxy(
    [{ name: "knowledge.search", count: 1 }],
    trapHandler as ProxyHandler<Array<{ name: string; count: number }>>,
  )
  assert.throws(
    () => signRunnerReceipt({
      receipt: receipt({
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          durationMilliseconds: 1_000,
          actions: proxiedActions,
        },
      }),
      keyId: "runner-rfc8032-1",
      privateKey: RFC8032_PRIVATE_KEY,
    }),
    (error) => errorCode(error) === "RUNNER_RECEIPT_INVALID",
  )

  assert.throws(() => canonicalRunnerJson(new Proxy({}, trapHandler)))
  assert.throws(() =>
    canonicalRunnerJson(
      new Proxy(
        [],
        trapHandler as ProxyHandler<unknown[]>,
      ),
    ),
  )
  assert.equal(traps, 0)
})

test("opaque JSON preserves finite fractional values without weakening wire integers", () => {
  const value = { confidence: 0.75, coordinates: [1.25, -2.5] }
  assert.deepEqual(decodeOpaqueJson(encodeOpaqueJson(value)), value)
  assert.throws(() => encodeOpaqueJson({ invalid: Number.NaN }))
  assert.throws(() => encodeOpaqueJson({ invalid: Number.POSITIVE_INFINITY }))
  assert.throws(() => encodeOpaqueJson({ invalid: -0 }))
  assert.throws(() => encodeOpaqueJson({ invalid: undefined }))
  assert.throws(() => encodeOpaqueJson({ tooLarge: "x".repeat(129 * 1_024) }))
  assert.throws(() =>
    decodeOpaqueJson({
      mediaType: "application/json",
      encoding: "base64url",
      data: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]).toString(
        "base64url",
      ),
    }),
  )
})
