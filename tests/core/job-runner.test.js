import assert from "node:assert/strict"
import test from "node:test"

import { JobRunner } from "../../packages/core/index.js"

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test("JobRunner enforces concurrency and drains its FIFO queue", async () => {
  const runner = new JobRunner({
    maxConcurrent: 1,
    maxQueueSize: 2,
    queueTimeoutMs: 1_000,
  })
  const gate = deferred()
  const order = []

  const first = runner.run(
    { actorId: "actor-1", jobId: "job-1" },
    async () => {
      order.push("first:start")
      await gate.promise
      order.push("first:end")
      return "first-result"
    },
  )
  const second = runner.run(
    { actorId: "actor-2", jobId: "job-2" },
    async () => {
      order.push("second:start")
      return "second-result"
    },
  )

  assert.deepEqual(runner.snapshot(), {
    running: 1,
    queued: 1,
    maxConcurrent: 1,
    maxQueueSize: 2,
    closed: false,
  })
  gate.resolve()

  assert.equal(await first, "first-result")
  assert.equal(await second, "second-result")
  assert.deepEqual(order, ["first:start", "first:end", "second:start"])
})

test("JobRunner rejects duplicate jobs and concurrent jobs from the same actor", async () => {
  const runner = new JobRunner({ maxConcurrent: 2 })
  const gate = deferred()
  const first = runner.run(
    { actorId: "actor-1", jobId: "job-1" },
    () => gate.promise,
  )

  await assert.rejects(
    runner.run(
      { actorId: "actor-2", jobId: "job-1" },
      async () => "duplicate",
    ),
    (error) => error.code === "DUPLICATE_REQUEST",
  )
  await assert.rejects(
    runner.run(
      { actorId: "actor-1", jobId: "job-2" },
      async () => "busy",
    ),
    (error) => error.code === "ACTOR_BUSY",
  )

  gate.resolve("done")
  assert.equal(await first, "done")
})

test("JobRunner returns a retry interval while an actor is cooling down", async () => {
  let now = 1_000
  const runner = new JobRunner({
    cooldownMs: 100,
    clock: () => now,
  })

  assert.equal(
    await runner.run(
      { actorId: "actor-1", jobId: "job-1" },
      async () => "first",
    ),
    "first",
  )
  now += 40
  await assert.rejects(
    runner.run(
      { actorId: "actor-1", jobId: "job-2" },
      async () => "too-soon",
    ),
    (error) =>
      error.code === "RATE_LIMITED" &&
      error.details.retryAfterMs === 60 &&
      error.retryable,
  )
  now += 60
  assert.equal(
    await runner.run(
      { actorId: "actor-1", jobId: "job-3" },
      async () => "allowed",
    ),
    "allowed",
  )
})

test("JobRunner reports queue timeout without running the expired task", async () => {
  let timeoutCallback
  const runner = new JobRunner({
    maxConcurrent: 1,
    maxQueueSize: 1,
    queueTimeoutMs: 100,
    setTimer(callback) {
      timeoutCallback = callback
      return 1
    },
    clearTimer() {},
  })
  const gate = deferred()
  const first = runner.run(
    { actorId: "actor-1", jobId: "job-1" },
    () => gate.promise,
  )
  let ran = false
  const queued = runner.run(
    { actorId: "actor-2", jobId: "job-2" },
    async () => {
      ran = true
    },
  )
  const assertion = assert.rejects(
    queued,
    (error) => error.code === "QUEUE_TIMEOUT" && error.retryable,
  )

  timeoutCallback()
  await assertion
  assert.equal(ran, false)
  gate.resolve("done")
  await first
})
