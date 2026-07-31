import { CoreError, ValidationError } from "./contracts.js"

const DEFAULTS = {
  maxConcurrent: 2,
  maxQueueSize: 50,
  queueTimeoutMs: 30_000,
  cooldownMs: 0,
  dedupeWindowMs: 5 * 60_000,
  maxSeenJobs: 1_000,
  maxTrackedActors: 1_000,
}

function positiveInteger(value, name, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1
  if (!Number.isInteger(value) || value < minimum) {
    throw new ValidationError(
      `${name} must be an integer greater than or equal to ${minimum}`,
    )
  }
  return value
}

export class JobRunner {
  #maxConcurrent
  #maxQueueSize
  #queueTimeoutMs
  #cooldownMs
  #dedupeWindowMs
  #maxSeenJobs
  #maxTrackedActors
  #clock
  #setTimer
  #clearTimer
  #running = 0
  #runningActors = new Set()
  #queuedActors = new Set()
  #queue = []
  #seenJobs = new Map()
  #lastStartedByActor = new Map()
  #closed = false

  constructor(options = {}) {
    this.#maxConcurrent = positiveInteger(
      options.maxConcurrent ?? DEFAULTS.maxConcurrent,
      "maxConcurrent",
    )
    this.#maxQueueSize = positiveInteger(
      options.maxQueueSize ?? DEFAULTS.maxQueueSize,
      "maxQueueSize",
      { allowZero: true },
    )
    this.#queueTimeoutMs = positiveInteger(
      options.queueTimeoutMs ?? DEFAULTS.queueTimeoutMs,
      "queueTimeoutMs",
    )
    this.#cooldownMs = positiveInteger(
      options.cooldownMs ?? DEFAULTS.cooldownMs,
      "cooldownMs",
      { allowZero: true },
    )
    this.#dedupeWindowMs = positiveInteger(
      options.dedupeWindowMs ?? DEFAULTS.dedupeWindowMs,
      "dedupeWindowMs",
      { allowZero: true },
    )
    this.#maxSeenJobs = positiveInteger(
      options.maxSeenJobs ?? DEFAULTS.maxSeenJobs,
      "maxSeenJobs",
    )
    this.#maxTrackedActors = positiveInteger(
      options.maxTrackedActors ?? DEFAULTS.maxTrackedActors,
      "maxTrackedActors",
    )
    this.#clock = options.clock ?? (() => Date.now())
    this.#setTimer = options.setTimer ?? setTimeout
    this.#clearTimer = options.clearTimer ?? clearTimeout
  }

  run(identity, task) {
    if (this.#closed) {
      return Promise.reject(
        new CoreError("RUNNER_CLOSED", "The job runner is closed.", {
          status: 503,
        }),
      )
    }
    if (typeof task !== "function") {
      return Promise.reject(
        new ValidationError("task must be a function", { field: "task" }),
      )
    }

    let normalized
    try {
      normalized = this.#validateIdentity(identity)
      this.#prune()
      this.#assertAccepted(normalized)
    } catch (error) {
      return Promise.reject(error)
    }

    if (this.#running < this.#maxConcurrent) {
      this.#recordJob(normalized.jobId)
      return this.#start(normalized, task)
    }
    if (this.#queue.length >= this.#maxQueueSize) {
      return Promise.reject(
        new CoreError("QUEUE_FULL", "The request queue is full.", {
          status: 503,
          retryable: true,
          details: { maxQueueSize: this.#maxQueueSize },
        }),
      )
    }
    this.#recordJob(normalized.jobId)
    return this.#enqueue(normalized, task)
  }

  snapshot() {
    return {
      running: this.#running,
      queued: this.#queue.length,
      maxConcurrent: this.#maxConcurrent,
      maxQueueSize: this.#maxQueueSize,
      closed: this.#closed,
    }
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const entry of this.#queue.splice(0)) {
      this.#clearTimer(entry.timer)
      this.#queuedActors.delete(entry.identity.actorId)
      entry.reject(
        new CoreError("RUNNER_CLOSED", "The job runner is closed.", {
          status: 503,
          retryable: false,
        }),
      )
    }
  }

  #validateIdentity(identity) {
    if (
      identity === null ||
      typeof identity !== "object" ||
      Array.isArray(identity)
    ) {
      throw new ValidationError("job identity must be an object")
    }
    const actorId =
      typeof identity.actorId === "string" && identity.actorId.trim()
        ? identity.actorId.trim()
        : "anonymous"
    const jobId =
      typeof identity.jobId === "string" && identity.jobId.trim()
        ? identity.jobId.trim()
        : undefined
    return { actorId, jobId }
  }

  #assertAccepted({ actorId, jobId }) {
    const now = this.#clock()
    if (
      jobId &&
      this.#dedupeWindowMs > 0 &&
      this.#seenJobs.has(jobId) &&
      now - this.#seenJobs.get(jobId) < this.#dedupeWindowMs
    ) {
      throw new CoreError("DUPLICATE_REQUEST", "Duplicate request ignored.", {
        status: 409,
        retryable: false,
      })
    }
    if (
      this.#runningActors.has(actorId) ||
      this.#queuedActors.has(actorId)
    ) {
      throw new CoreError(
        "ACTOR_BUSY",
        "This actor already has a request in progress.",
        { status: 409, retryable: true },
      )
    }
    const lastStarted = this.#lastStartedByActor.get(actorId)
    if (
      this.#cooldownMs > 0 &&
      lastStarted !== undefined &&
      now - lastStarted < this.#cooldownMs
    ) {
      const retryAfterMs = this.#cooldownMs - (now - lastStarted)
      throw new CoreError(
        "RATE_LIMITED",
        "The actor is in a cooldown period.",
        {
          status: 429,
          retryable: true,
          details: { retryAfterMs },
        },
      )
    }
  }

  #enqueue(identity, task) {
    return new Promise((resolve, reject) => {
      const entry = { identity, task, resolve, reject, timer: null }
      entry.timer = this.#setTimer(() => {
        const index = this.#queue.indexOf(entry)
        if (index < 0) return
        this.#queue.splice(index, 1)
        this.#queuedActors.delete(identity.actorId)
        reject(
          new CoreError("QUEUE_TIMEOUT", "The queued request timed out.", {
            status: 503,
            retryable: true,
            details: { timeoutMs: this.#queueTimeoutMs },
          }),
        )
      }, this.#queueTimeoutMs)
      this.#queuedActors.add(identity.actorId)
      this.#queue.push(entry)
    })
  }

  async #start(identity, task) {
    this.#running += 1
    this.#runningActors.add(identity.actorId)
    if (this.#cooldownMs > 0) {
      this.#setBounded(
        this.#lastStartedByActor,
        identity.actorId,
        this.#clock(),
        this.#maxTrackedActors,
      )
    }
    try {
      return await task()
    } finally {
      this.#running -= 1
      this.#runningActors.delete(identity.actorId)
      this.#drain()
    }
  }

  #drain() {
    while (
      !this.#closed &&
      this.#running < this.#maxConcurrent &&
      this.#queue.length > 0
    ) {
      const entry = this.#queue.shift()
      this.#clearTimer(entry.timer)
      this.#queuedActors.delete(entry.identity.actorId)
      this.#start(entry.identity, entry.task).then(
        entry.resolve,
        entry.reject,
      )
    }
  }

  #prune() {
    const now = this.#clock()
    for (const [jobId, seenAt] of this.#seenJobs) {
      if (now - seenAt >= this.#dedupeWindowMs) {
        this.#seenJobs.delete(jobId)
      }
    }
    for (const [actorId, startedAt] of this.#lastStartedByActor) {
      if (now - startedAt >= this.#cooldownMs) {
        this.#lastStartedByActor.delete(actorId)
      }
    }
  }

  #recordJob(jobId) {
    if (jobId && this.#dedupeWindowMs > 0) {
      this.#setBounded(
        this.#seenJobs,
        jobId,
        this.#clock(),
        this.#maxSeenJobs,
      )
    }
  }

  #setBounded(map, key, value, maximum) {
    map.delete(key)
    map.set(key, value)
    while (map.size > maximum) {
      map.delete(map.keys().next().value)
    }
  }
}
