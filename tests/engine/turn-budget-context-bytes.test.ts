import assert from "node:assert/strict"
import test from "node:test"

import {
  CONTEXT_BUDGET_EXCEEDED_CODE,
  createDeterministicModelPort,
  executeTurn,
  isTerminalEngineEvent,
} from "../../packages/engine/src/index.js"
import type {
  EngineEvent,
  EngineTurnRequest,
  TurnBudget,
} from "../../packages/engine/src/index.js"

const FIXED_NOW = () => new Date("2026-08-23T00:00:00.000Z")

function baseRequest(
  overrides: Partial<EngineTurnRequest> = {},
): EngineTurnRequest {
  return {
    workspaceRef: "ws-1",
    positionId: "repo-owner",
    turnId: "turn-1",
    runId: "run-1",
    input: "Summarize the open issues.",
    budget: { maxIterations: 3 },
    position: {
      instructions: "You are the repo owner.",
      spec: "mode=read_only",
    },
    ...overrides,
  }
}

async function collect(
  request: EngineTurnRequest,
  model: ReturnType<typeof createDeterministicModelPort>,
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  for await (const event of executeTurn(request, { model, now: FIXED_NOW })) {
    events.push(event)
  }
  return events
}

// -- (a) Optional field absent -> behavior unchanged ------------------------

test("maxContextBytes omitted preserves the v0.6.0 completion path", async () => {
  const model = createDeterministicModelPort(["plain answer"])
  const events = await collect(baseRequest(), model)
  const terminals = events.filter(isTerminalEngineEvent)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.completed")
  if (terminals[0]!.type === "run.completed") {
    assert.equal(terminals[0]!.output, "plain answer")
    assert.equal(terminals[0]!.terminalReason, "goal_met")
  }
})

test("maxContextBytes large enough to fit the envelope is transparent", async () => {
  const model = createDeterministicModelPort(["ok"])
  const budget: TurnBudget = { maxIterations: 3, maxContextBytes: 1_000_000 }
  const events = await collect(baseRequest({ budget }), model)
  const terminals = events.filter(isTerminalEngineEvent)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.completed")
})

// -- (a) Contract validation -----------------------------------------------

test("maxContextBytes below one is rejected as engine.input_invalid before any model call", async () => {
  let calls = 0
  const model = {
    async complete() {
      calls += 1
      return { text: "never" }
    },
  }
  const budget = { maxIterations: 3, maxContextBytes: 0 } as unknown as TurnBudget
  const events: EngineEvent[] = []
  for await (const event of executeTurn(baseRequest({ budget }), {
    model,
    now: FIXED_NOW,
  })) {
    events.push(event)
  }
  assert.equal(calls, 0)
  const terminal = events.filter(isTerminalEngineEvent)
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0]!.type, "run.failed")
  if (terminal[0]!.type === "run.failed") {
    assert.equal(terminal[0]!.error.code, "engine.input_invalid")
  }
})

test("maxContextBytes non-integer is rejected as engine.input_invalid", async () => {
  let calls = 0
  const model = {
    async complete() {
      calls += 1
      return { text: "never" }
    },
  }
  const budget = {
    maxIterations: 3,
    maxContextBytes: 1.5,
  } as unknown as TurnBudget
  const events: EngineEvent[] = []
  for await (const event of executeTurn(baseRequest({ budget }), {
    model,
    now: FIXED_NOW,
  })) {
    events.push(event)
  }
  assert.equal(calls, 0)
  const terminal = events.filter(isTerminalEngineEvent)
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0]!.type, "run.failed")
  if (terminal[0]!.type === "run.failed") {
    assert.equal(terminal[0]!.error.code, "engine.input_invalid")
  }
})

// -- (a) Small value -> fail closed BEFORE any model call ------------------

test("maxContextBytes below the assembled envelope fails closed pre-model with a structured error", async () => {
  let calls = 0
  const model = {
    async complete() {
      calls += 1
      return { text: "never" }
    },
  }
  // The default baseRequest envelope holds four fixed slots totalling far
  // more than 8 bytes; the cap fires before any model consumption.
  const budget: TurnBudget = { maxIterations: 3, maxContextBytes: 8 }
  const events: EngineEvent[] = []
  for await (const event of executeTurn(baseRequest({ budget }), {
    model,
    now: FIXED_NOW,
  })) {
    events.push(event)
  }
  assert.equal(calls, 0, "no model.complete call should occur")
  const terminals = events.filter(isTerminalEngineEvent)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.failed")
  if (terminals[0]!.type === "run.failed") {
    // Reuses the stable v0.6.0 TerminalReason enumeration; the refined
    // error code identifies the pre-model context-byte stop.
    assert.equal(terminals[0]!.error.terminalReason, "turn_budget_exceeded")
    assert.equal(terminals[0]!.error.code, CONTEXT_BUDGET_EXCEEDED_CODE)
    assert.equal(terminals[0]!.error.code, "engine.context_budget_exceeded")
    // Retryable follows the shared RETRYABLE_REASONS mapping for
    // turn_budget_exceeded (i.e. not retryable).
    assert.equal(terminals[0]!.error.retryable, false)
  }
})

// -- (b) Early stop on iteration=1 when the model produces a valid output --

test("first-iteration completion never enters a second iteration (no-schema branch)", async () => {
  let calls = 0
  const model = {
    async complete() {
      calls += 1
      return { text: "answered on the first pass" }
    },
  }
  const budget: TurnBudget = { maxIterations: 5 }
  const events: EngineEvent[] = []
  for await (const event of executeTurn(baseRequest({ budget }), {
    model,
    now: FIXED_NOW,
  })) {
    events.push(event)
  }
  const terminals = events.filter(isTerminalEngineEvent)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.completed")
  // Early stop assertion: even though maxIterations budgeted 5 iterations,
  // the executor consumes exactly one model call once the turn is answered.
  assert.equal(calls, 1)
})

test("first-iteration completion never enters a second iteration (schema branch)", async () => {
  let calls = 0
  const model = {
    async complete() {
      calls += 1
      return { text: '{"answer":"one shot"}' }
    },
  }
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  }
  const budget: TurnBudget = { maxIterations: 5 }
  const events: EngineEvent[] = []
  for await (const event of executeTurn(
    baseRequest({ budget, outputSchema: schema }),
    { model, now: FIXED_NOW },
  )) {
    events.push(event)
  }
  const terminals = events.filter(isTerminalEngineEvent)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.completed")
  if (terminals[0]!.type === "run.completed") {
    assert.deepEqual(terminals[0]!.output, { answer: "one shot" })
  }
  // Early stop assertion: one call, no repair loop consumption.
  assert.equal(calls, 1)
})
