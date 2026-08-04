import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from "node:crypto"
import type { KeyLike } from "node:crypto"
import { types as utilTypes } from "node:util"

import { CoreError } from "./contracts.js"

export const RUNNER_PROTOCOL_VERSION =
  "digital-employee.runner-protocol.v1" as const
export const RUNNER_SIGNATURE_ALGORITHM = "Ed25519" as const
export const RUNNER_TASK_DOMAIN = "digital-employee.runner-task.v1" as const
export const RUNNER_EVENT_DOMAIN = "digital-employee.runner-event.v1" as const
export const RUNNER_RECEIPT_DOMAIN =
  "digital-employee.runner-receipt.v1" as const
export const RUNNER_EVENT_GENESIS_DIGEST = `sha256:${"0".repeat(64)}` as const
export const MAX_RUNNER_CLOCK_SKEW_MS = 30_000
export const MAX_RUNNER_ATTEMPTS = 32
export const MIN_RUNNER_LEASE_MILLISECONDS = 10_000

const MAX_ENVELOPE_PAYLOAD_BYTES = 256 * 1024
const MAX_OPAQUE_DATA_BYTES = 128 * 1024
const MAX_ID_LENGTH = 200
const MAX_EVENTS = 1_024
const MAX_ACTIONS = 128
const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,199})$/
const MACHINE_CODE_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const MEDIA_TYPE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export type RunnerProtocolErrorCode =
  | "RUNNER_ENVELOPE_INVALID"
  | "RUNNER_SIGNATURE_INVALID"
  | "RUNNER_KEY_INVALID"
  | "RUNNER_TASK_INVALID"
  | "RUNNER_EVENT_INVALID"
  | "RUNNER_EVENT_CHAIN_INVALID"
  | "RUNNER_RECEIPT_INVALID"

export class RunnerProtocolError extends CoreError {
  constructor(code: RunnerProtocolErrorCode) {
    super(code, "Runner protocol data could not be accepted safely", {
      status: 400,
      retryable: false,
    })
    this.name = "RunnerProtocolError"
  }
}

export interface SignedEnvelope {
  protocolVersion: typeof RUNNER_PROTOCOL_VERSION
  keyId: string
  algorithm: typeof RUNNER_SIGNATURE_ALGORITHM
  payload: string
  signature: string
}

export interface OpaqueData {
  mediaType: string
  encoding: "base64url"
  data: string
}

export interface RunnerTaskPayload {
  protocolVersion: typeof RUNNER_PROTOCOL_VERSION
  kind: "runner.task"
  taskId: string
  runId: string
  attempt: number
  fencingToken: number
  leaseId: string
  quoteId: string
  reservationId: string
  sellerId: string
  runnerId: string
  employee: {
    id: string
    version: string
    packageDigest: string
  }
  engine: string
  input: OpaqueData
  issuedAt: string
  expiresAt: string
  leaseExpiresAt: string
  nonce: string
}

export interface RunnerEvent {
  protocolVersion: typeof RUNNER_PROTOCOL_VERSION
  kind: "runner.event"
  taskId: string
  runId: string
  attempt: number
  fencingToken: number
  leaseId: string
  quoteId: string
  runnerId: string
  employeeId: string
  packageDigest: string
  sequence: number
  timestamp: string
  type: string
  data: OpaqueData
  previousDigest: string
  digest: string
}

export interface RunnerUsageSummary {
  inputTokens: number
  outputTokens: number
  durationMilliseconds: number
  actions: Array<{ name: string; count: number }>
}

export type RunnerOutcome =
  | { status: "completed"; output?: OpaqueData }
  | { status: "failed"; errorCode: string }
  | { status: "cancelled_by_runner"; reasonCode: string }

export interface RunnerReceiptPayload {
  protocolVersion: typeof RUNNER_PROTOCOL_VERSION
  kind: "runner.receipt"
  taskId: string
  runId: string
  attempt: number
  fencingToken: number
  leaseId: string
  quoteId: string
  reservationId: string
  sellerId: string
  runnerId: string
  employee: {
    id: string
    version: string
    packageDigest: string
  }
  engine: string
  startedAt: string
  completedAt: string
  eventCount: number
  finalEventDigest: string
  usage: RunnerUsageSummary
  outcome: RunnerOutcome
  providerEvidence?: OpaqueData
}

export interface VerifiedRunnerExecutionBundle {
  task: RunnerTaskPayload
  events: RunnerEvent[]
  receipt: RunnerReceiptPayload
}

type RunnerDomain =
  | typeof RUNNER_TASK_DOMAIN
  | typeof RUNNER_RECEIPT_DOMAIN

type PlainRecord = Record<string, unknown>

function protocolError(code: RunnerProtocolErrorCode): never {
  throw new RunnerProtocolError(code)
}

function dataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  code: RunnerProtocolErrorCode,
): PlainRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    protocolError(code)
  }
  let descriptors: Record<string, PropertyDescriptor>
  let prototype: object | null
  let descriptorKeys: Array<string | symbol>
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
    descriptorKeys = Reflect.ownKeys(descriptors)
  } catch {
    protocolError(code)
  }
  const keys = descriptorKeys.filter(
    (key): key is string => typeof key === "string",
  )
  if (
    prototype !== Object.prototype ||
    descriptorKeys.some((key) => typeof key !== "string") ||
    keys.length !== allowedKeys.length ||
    keys.some((key) => !allowedKeys.includes(key))
  ) {
    protocolError(code)
  }
  const captured = Object.create(null) as PlainRecord
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      protocolError(code)
    }
    captured[key] = descriptor.value
  }
  return captured
}

function optionalDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  code: RunnerProtocolErrorCode,
): PlainRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    protocolError(code)
  }
  let descriptors: Record<string, PropertyDescriptor>
  let prototype: object | null
  let descriptorKeys: Array<string | symbol>
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
    descriptorKeys = Reflect.ownKeys(descriptors)
  } catch {
    protocolError(code)
  }
  const keys = descriptorKeys.filter(
    (key): key is string => typeof key === "string",
  )
  if (
    prototype !== Object.prototype ||
    descriptorKeys.some((key) => typeof key !== "string") ||
    requiredKeys.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some(
      (key) => !requiredKeys.includes(key) && !optionalKeys.includes(key),
    )
  ) {
    protocolError(code)
  }
  const captured = Object.create(null) as PlainRecord
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      protocolError(code)
    }
    captured[key] = descriptor.value
  }
  return captured
}

function dataArray(
  value: unknown,
  maximumLength: number,
  code: RunnerProtocolErrorCode,
): unknown[] {
  if (utilTypes.isProxy(value) || !Array.isArray(value)) protocolError(code)
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) protocolError(code)
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >
    const keys = Reflect.ownKeys(descriptors)
    const lengthDescriptor = descriptors.length
    const length =
      lengthDescriptor &&
      "value" in lengthDescriptor &&
      typeof lengthDescriptor.value === "number"
        ? lengthDescriptor.value
        : Number.NaN
    if (
      keys.some((key) => typeof key !== "string") ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximumLength ||
      keys.length !== length + 1
    ) {
      protocolError(code)
    }
    const captured: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        protocolError(code)
      }
      captured.push(descriptor.value)
    }
    return captured
  } catch (error) {
    if (error instanceof RunnerProtocolError) throw error
    protocolError(code)
  }
}

function stringField(
  value: unknown,
  pattern: RegExp,
  code: RunnerProtocolErrorCode,
  maxLength = MAX_ID_LENGTH,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    !pattern.test(value)
  ) {
    protocolError(code)
  }
  return value
}

function safeInteger(
  value: unknown,
  code: RunnerProtocolErrorCode,
  { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {},
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    protocolError(code)
  }
  return value
}

function timestamp(
  value: unknown,
  code: RunnerProtocolErrorCode,
): { value: string; milliseconds: number } {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    protocolError(code)
  }
  const milliseconds = Date.parse(value)
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    protocolError(code)
  }
  return { value, milliseconds }
}

function decodeBase64Url(
  value: unknown,
  code: RunnerProtocolErrorCode,
  maxBytes: number,
): Buffer {
  if (
    typeof value !== "string" ||
    !BASE64URL_PATTERN.test(value) ||
    value.length > Math.ceil((maxBytes * 4) / 3)
  ) {
    protocolError(code)
  }
  let decoded: Buffer
  try {
    decoded = Buffer.from(value, "base64url")
  } catch {
    protocolError(code)
  }
  if (decoded.length > maxBytes || decoded.toString("base64url") !== value) {
    protocolError(code)
  }
  return decoded
}

function opaqueData(
  value: unknown,
  code: RunnerProtocolErrorCode,
): OpaqueData {
  const record = dataRecord(
    value,
    ["mediaType", "encoding", "data"],
    code,
  )
  const mediaType = stringField(
    record.mediaType,
    MEDIA_TYPE_PATTERN,
    code,
    255,
  )
  if (record.encoding !== "base64url") protocolError(code)
  const data = decodeBase64Url(record.data, code, MAX_OPAQUE_DATA_BYTES).toString(
    "base64url",
  )
  return Object.freeze({ mediaType, encoding: "base64url", data })
}

function digestField(
  value: unknown,
  code: RunnerProtocolErrorCode,
): string {
  return stringField(value, SHA256_PATTERN, code, 71)
}

function idField(value: unknown, code: RunnerProtocolErrorCode): string {
  return stringField(value, ID_PATTERN, code)
}

function machineCodeField(
  value: unknown,
  code: RunnerProtocolErrorCode,
): string {
  return stringField(value, MACHINE_CODE_PATTERN, code, 128)
}

function semverField(value: unknown, code: RunnerProtocolErrorCode): string {
  return stringField(value, SEMVER_PATTERN, code, 128)
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value
  }
  for (const child of Object.values(value as PlainRecord)) deepFreeze(child)
  return Object.freeze(value)
}

/**
 * Deterministic JSON for hashes and locally-created payloads. Objects are
 * recursively sorted by key; accessors, exotic prototypes, cycles, undefined,
 * non-finite values and negative zero are rejected.
 */
function canonicalJson(value: unknown, integersOnly: boolean): string {
  const active = new Set<object>()
  const encode = (entry: unknown): string => {
    if (entry === null) return "null"
    if (typeof entry === "string" || typeof entry === "boolean") {
      return JSON.stringify(entry)
    }
    if (typeof entry === "number") {
      if (
        !Number.isFinite(entry) ||
        (integersOnly && !Number.isSafeInteger(entry)) ||
        Object.is(entry, -0)
      ) {
        protocolError("RUNNER_ENVELOPE_INVALID")
      }
      return JSON.stringify(entry)
    }
    if (typeof entry !== "object") protocolError("RUNNER_ENVELOPE_INVALID")
    // Proxy reflection can run attacker-controlled traps. Reject before any
    // Array/prototype/descriptor operation so parsing remains side-effect free.
    if (utilTypes.isProxy(entry)) protocolError("RUNNER_ENVELOPE_INVALID")
    if (active.has(entry)) protocolError("RUNNER_ENVELOPE_INVALID")
    active.add(entry)
    try {
      if (Array.isArray(entry)) {
        let descriptors: Record<string, PropertyDescriptor>
        let keys: Array<string | symbol>
        try {
          if (Object.getPrototypeOf(entry) !== Array.prototype) {
            protocolError("RUNNER_ENVELOPE_INVALID")
          }
          descriptors = Object.getOwnPropertyDescriptors(entry)
          keys = Reflect.ownKeys(descriptors)
        } catch (error) {
          if (error instanceof RunnerProtocolError) throw error
          protocolError("RUNNER_ENVELOPE_INVALID")
        }
        if (
          keys.some(
            (key) =>
              typeof key !== "string" ||
              (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)),
          )
        ) {
          protocolError("RUNNER_ENVELOPE_INVALID")
        }
        const lengthDescriptor = descriptors.length
        if (
          !lengthDescriptor ||
          !("value" in lengthDescriptor) ||
          typeof lengthDescriptor.value !== "number"
        ) {
          protocolError("RUNNER_ENVELOPE_INVALID")
        }
        if (
          keys.length !== lengthDescriptor.value + 1 ||
          keys.some(
            (key) =>
              key !== "length" &&
              (typeof key !== "string" ||
                Number(key) < 0 ||
                Number(key) >= lengthDescriptor.value),
          )
        ) {
          protocolError("RUNNER_ENVELOPE_INVALID")
        }
        const values: string[] = []
        for (let index = 0; index < lengthDescriptor.value; index += 1) {
          const descriptor = descriptors[String(index)]
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            protocolError("RUNNER_ENVELOPE_INVALID")
          }
          values.push(encode(descriptor.value))
        }
        return `[${values.join(",")}]`
      }
      let descriptors: Record<string, PropertyDescriptor>
      let keys: Array<string | symbol>
      try {
        if (Object.getPrototypeOf(entry) !== Object.prototype) {
          protocolError("RUNNER_ENVELOPE_INVALID")
        }
        descriptors = Object.getOwnPropertyDescriptors(entry)
        keys = Reflect.ownKeys(descriptors)
      } catch (error) {
        if (error instanceof RunnerProtocolError) throw error
        protocolError("RUNNER_ENVELOPE_INVALID")
      }
      if (keys.some((key) => typeof key !== "string")) {
        protocolError("RUNNER_ENVELOPE_INVALID")
      }
      const fields: string[] = []
      for (const key of (keys as string[]).sort()) {
        const descriptor = descriptors[key]
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          protocolError("RUNNER_ENVELOPE_INVALID")
        }
        fields.push(`${JSON.stringify(key)}:${encode(descriptor.value)}`)
      }
      return `{${fields.join(",")}}`
    } finally {
      active.delete(entry)
    }
  }
  return encode(value)
}

export function canonicalRunnerJson(value: unknown): string {
  return canonicalJson(value, true)
}

export function encodeOpaqueJson(value: unknown): OpaqueData {
  const bytes = Buffer.from(canonicalJson(value, false), "utf8")
  if (bytes.length > MAX_OPAQUE_DATA_BYTES) {
    protocolError("RUNNER_ENVELOPE_INVALID")
  }
  return Object.freeze({
    mediaType: "application/json",
    encoding: "base64url",
    data: bytes.toString("base64url"),
  })
}

export function decodeOpaqueJson(data: OpaqueData): unknown {
  const validated = opaqueData(data, "RUNNER_TASK_INVALID")
  if (validated.mediaType !== "application/json") {
    protocolError("RUNNER_TASK_INVALID")
  }
  try {
    const bytes = Buffer.from(validated.data, "base64url")
    const text = bytes.toString("utf8")
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      protocolError("RUNNER_TASK_INVALID")
    }
    return JSON.parse(text)
  } catch {
    protocolError("RUNNER_TASK_INVALID")
  }
}

function envelopeSigningBytes(domain: RunnerDomain, payload: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${domain}\n`, "ascii"), payload])
}

export function runnerPrivateKey(key: KeyLike): KeyObject {
  try {
    const keyObject = key instanceof KeyObject ? key : createPrivateKey(key)
    if (
      keyObject.type !== "private" ||
      keyObject.asymmetricKeyType !== "ed25519"
    ) {
      protocolError("RUNNER_KEY_INVALID")
    }
    return keyObject
  } catch (error) {
    if (error instanceof RunnerProtocolError) throw error
    protocolError("RUNNER_KEY_INVALID")
  }
}

export function runnerPublicKey(key: KeyLike): KeyObject {
  try {
    const keyObject = key instanceof KeyObject ? key : createPublicKey(key)
    if (
      keyObject.type !== "public" ||
      keyObject.asymmetricKeyType !== "ed25519"
    ) {
      protocolError("RUNNER_KEY_INVALID")
    }
    return keyObject
  } catch (error) {
    if (error instanceof RunnerProtocolError) throw error
    protocolError("RUNNER_KEY_INVALID")
  }
}

export function validateSignedEnvelope(input: unknown): SignedEnvelope {
  const record = dataRecord(
    input,
    ["protocolVersion", "keyId", "algorithm", "payload", "signature"],
    "RUNNER_ENVELOPE_INVALID",
  )
  if (
    record.protocolVersion !== RUNNER_PROTOCOL_VERSION ||
    record.algorithm !== RUNNER_SIGNATURE_ALGORITHM
  ) {
    protocolError("RUNNER_ENVELOPE_INVALID")
  }
  const payloadBytes = decodeBase64Url(
    record.payload,
    "RUNNER_ENVELOPE_INVALID",
    MAX_ENVELOPE_PAYLOAD_BYTES,
  )
  if (payloadBytes.length === 0) protocolError("RUNNER_ENVELOPE_INVALID")
  const payload = payloadBytes.toString("base64url")
  const signature = decodeBase64Url(
    record.signature,
    "RUNNER_ENVELOPE_INVALID",
    64,
  )
  if (signature.length !== 64) protocolError("RUNNER_ENVELOPE_INVALID")
  return Object.freeze({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    keyId: idField(record.keyId, "RUNNER_ENVELOPE_INVALID"),
    algorithm: RUNNER_SIGNATURE_ALGORITHM,
    payload,
    signature: signature.toString("base64url"),
  })
}

export function signRunnerEnvelope(options: {
  domain: RunnerDomain
  keyId: string
  privateKey: KeyLike
  payload: Uint8Array
}): SignedEnvelope {
  const domain = options.domain
  const keyIdValue = options.keyId
  const privateKeyValue = options.privateKey
  const payloadValue = options.payload
  if (domain !== RUNNER_TASK_DOMAIN && domain !== RUNNER_RECEIPT_DOMAIN) {
    protocolError("RUNNER_ENVELOPE_INVALID")
  }
  const keyId = idField(keyIdValue, "RUNNER_ENVELOPE_INVALID")
  const payload = Buffer.from(payloadValue)
  if (payload.length === 0 || payload.length > MAX_ENVELOPE_PAYLOAD_BYTES) {
    protocolError("RUNNER_ENVELOPE_INVALID")
  }
  const privateKey = runnerPrivateKey(privateKeyValue)
  let signature: Buffer
  try {
    signature = ed25519Sign(
      null,
      envelopeSigningBytes(domain, payload),
      privateKey,
    )
  } catch {
    protocolError("RUNNER_KEY_INVALID")
  }
  return Object.freeze({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    keyId,
    algorithm: RUNNER_SIGNATURE_ALGORITHM,
    payload: payload.toString("base64url"),
    signature: signature.toString("base64url"),
  })
}

export function verifyRunnerEnvelope(options: {
  domain: RunnerDomain
  envelope: unknown
  publicKey: KeyLike
}): Buffer {
  const domain = options.domain
  const envelopeValue = options.envelope
  const publicKeyValue = options.publicKey
  if (domain !== RUNNER_TASK_DOMAIN && domain !== RUNNER_RECEIPT_DOMAIN) {
    protocolError("RUNNER_ENVELOPE_INVALID")
  }
  const envelope = validateSignedEnvelope(envelopeValue)
  const payload = Buffer.from(envelope.payload, "base64url")
  const signature = Buffer.from(envelope.signature, "base64url")
  const publicKey = runnerPublicKey(publicKeyValue)
  let valid = false
  try {
    valid = ed25519Verify(
      null,
      envelopeSigningBytes(domain, payload),
      publicKey,
      signature,
    )
  } catch {
    protocolError("RUNNER_KEY_INVALID")
  }
  if (!valid) protocolError("RUNNER_SIGNATURE_INVALID")
  return payload
}

function parsePayload(bytes: Uint8Array, code: RunnerProtocolErrorCode): unknown {
  let parsed: unknown
  try {
    const text = Buffer.from(bytes).toString("utf8")
    if (Buffer.from(text, "utf8").compare(Buffer.from(bytes)) !== 0) {
      protocolError(code)
    }
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof RunnerProtocolError) throw error
    protocolError(code)
  }
  return parsed
}

export function validateRunnerTask(input: unknown): RunnerTaskPayload {
  const code = "RUNNER_TASK_INVALID" as const
  const record = dataRecord(
    input,
    [
      "protocolVersion",
      "kind",
      "taskId",
      "runId",
      "attempt",
      "fencingToken",
      "leaseId",
      "quoteId",
      "reservationId",
      "sellerId",
      "runnerId",
      "employee",
      "engine",
      "input",
      "issuedAt",
      "expiresAt",
      "leaseExpiresAt",
      "nonce",
    ],
    code,
  )
  if (
    record.protocolVersion !== RUNNER_PROTOCOL_VERSION ||
    record.kind !== "runner.task"
  ) {
    protocolError(code)
  }
  const employee = dataRecord(
    record.employee,
    ["id", "version", "packageDigest"],
    code,
  )
  const issuedAt = timestamp(record.issuedAt, code)
  const expiresAt = timestamp(record.expiresAt, code)
  const leaseExpiresAt = timestamp(record.leaseExpiresAt, code)
  if (
    expiresAt.milliseconds <= issuedAt.milliseconds ||
    leaseExpiresAt.milliseconds - issuedAt.milliseconds <
      MIN_RUNNER_LEASE_MILLISECONDS ||
    leaseExpiresAt.milliseconds > expiresAt.milliseconds
  ) {
    protocolError(code)
  }
  const nonce = decodeBase64Url(record.nonce, code, 64)
  if (nonce.length < 16) protocolError(code)
  return deepFreeze({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.task",
    taskId: idField(record.taskId, code),
    runId: idField(record.runId, code),
    attempt: safeInteger(record.attempt, code, {
      minimum: 1,
      maximum: MAX_RUNNER_ATTEMPTS,
    }),
    fencingToken: safeInteger(record.fencingToken, code, { minimum: 1 }),
    leaseId: idField(record.leaseId, code),
    quoteId: idField(record.quoteId, code),
    reservationId: idField(record.reservationId, code),
    sellerId: idField(record.sellerId, code),
    runnerId: idField(record.runnerId, code),
    employee: {
      id: idField(employee.id, code),
      version: semverField(employee.version, code),
      packageDigest: digestField(employee.packageDigest, code),
    },
    engine: idField(record.engine, code),
    input: opaqueData(record.input, code),
    issuedAt: issuedAt.value,
    expiresAt: expiresAt.value,
    leaseExpiresAt: leaseExpiresAt.value,
    nonce: nonce.toString("base64url"),
  })
}

export function signRunnerTask(options: {
  task: unknown
  keyId: string
  privateKey: KeyLike
}): SignedEnvelope {
  const task = validateRunnerTask(options.task)
  return signRunnerEnvelope({
    domain: RUNNER_TASK_DOMAIN,
    keyId: options.keyId,
    privateKey: options.privateKey,
    payload: Buffer.from(canonicalRunnerJson(task), "utf8"),
  })
}

export function verifyRunnerTask(options: {
  envelope: unknown
  publicKey: KeyLike
}): RunnerTaskPayload {
  const payload = verifyRunnerEnvelope({
    domain: RUNNER_TASK_DOMAIN,
    envelope: options.envelope,
    publicKey: options.publicKey,
  })
  const task = validateRunnerTask(
    parsePayload(payload, "RUNNER_TASK_INVALID"),
  )
  if (payload.compare(Buffer.from(canonicalRunnerJson(task), "utf8")) !== 0) {
    protocolError("RUNNER_TASK_INVALID")
  }
  return task
}

function runnerEventWithoutDigest(input: unknown): Omit<RunnerEvent, "digest"> {
  const code = "RUNNER_EVENT_INVALID" as const
  const record = dataRecord(
    input,
    [
      "protocolVersion",
      "kind",
      "taskId",
      "runId",
      "attempt",
      "fencingToken",
      "leaseId",
      "quoteId",
      "runnerId",
      "employeeId",
      "packageDigest",
      "sequence",
      "timestamp",
      "type",
      "data",
      "previousDigest",
    ],
    code,
  )
  if (
    record.protocolVersion !== RUNNER_PROTOCOL_VERSION ||
    record.kind !== "runner.event"
  ) {
    protocolError(code)
  }
  return deepFreeze({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.event",
    taskId: idField(record.taskId, code),
    runId: idField(record.runId, code),
    attempt: safeInteger(record.attempt, code, {
      minimum: 1,
      maximum: MAX_RUNNER_ATTEMPTS,
    }),
    fencingToken: safeInteger(record.fencingToken, code, { minimum: 1 }),
    leaseId: idField(record.leaseId, code),
    quoteId: idField(record.quoteId, code),
    runnerId: idField(record.runnerId, code),
    employeeId: idField(record.employeeId, code),
    packageDigest: digestField(record.packageDigest, code),
    sequence: safeInteger(record.sequence, code, {
      minimum: 1,
      maximum: MAX_EVENTS,
    }),
    timestamp: timestamp(record.timestamp, code).value,
    type: machineCodeField(record.type, code),
    data: opaqueData(record.data, code),
    previousDigest: digestField(record.previousDigest, code),
  })
}

export function hashRunnerEvent(
  event: Omit<RunnerEvent, "digest">,
): string {
  const normalized = runnerEventWithoutDigest(event)
  return `sha256:${createHash("sha256")
    .update(`${RUNNER_EVENT_DOMAIN}\n`, "ascii")
    .update(canonicalRunnerJson(normalized), "utf8")
    .digest("hex")}`
}

export function createRunnerEvent(
  event: Omit<RunnerEvent, "digest">,
): RunnerEvent {
  const normalized = runnerEventWithoutDigest(event)
  return deepFreeze({ ...normalized, digest: hashRunnerEvent(normalized) })
}

export function validateRunnerEvent(input: unknown): RunnerEvent {
  const code = "RUNNER_EVENT_INVALID" as const
  const record = dataRecord(
    input,
    [
      "protocolVersion",
      "kind",
      "taskId",
      "runId",
      "attempt",
      "fencingToken",
      "leaseId",
      "quoteId",
      "runnerId",
      "employeeId",
      "packageDigest",
      "sequence",
      "timestamp",
      "type",
      "data",
      "previousDigest",
      "digest",
    ],
    code,
  )
  const digest = digestField(record.digest, code)
  const normalized = runnerEventWithoutDigest({
    protocolVersion: record.protocolVersion,
    kind: record.kind,
    taskId: record.taskId,
    runId: record.runId,
    attempt: record.attempt,
    fencingToken: record.fencingToken,
    leaseId: record.leaseId,
    quoteId: record.quoteId,
    runnerId: record.runnerId,
    employeeId: record.employeeId,
    packageDigest: record.packageDigest,
    sequence: record.sequence,
    timestamp: record.timestamp,
    type: record.type,
    data: record.data,
    previousDigest: record.previousDigest,
  })
  if (hashRunnerEvent(normalized) !== digest) protocolError(code)
  return deepFreeze({ ...normalized, digest })
}

export interface RunnerEventChainIdentity {
  taskId: string
  runId: string
  attempt: number
  fencingToken: number
  leaseId: string
  quoteId: string
  runnerId: string
  employeeId: string
  packageDigest: string
}

export function verifyRunnerEventChain(
  events: readonly unknown[],
  expected?: RunnerEventChainIdentity,
): { events: RunnerEvent[]; finalDigest: string } {
  const capturedEvents = dataArray(
    events,
    MAX_EVENTS,
    "RUNNER_EVENT_CHAIN_INVALID",
  )
  const validated: RunnerEvent[] = []
  let previousDigest: string = RUNNER_EVENT_GENESIS_DIGEST
  for (let index = 0; index < capturedEvents.length; index += 1) {
    let event: RunnerEvent
    try {
      event = validateRunnerEvent(capturedEvents[index])
    } catch {
      protocolError("RUNNER_EVENT_CHAIN_INVALID")
    }
    if (
      event.sequence !== index + 1 ||
      event.previousDigest !== previousDigest ||
      (expected &&
        (event.taskId !== expected.taskId ||
          event.runId !== expected.runId ||
          event.attempt !== expected.attempt ||
          event.fencingToken !== expected.fencingToken ||
          event.leaseId !== expected.leaseId ||
          event.quoteId !== expected.quoteId ||
          event.runnerId !== expected.runnerId ||
          event.employeeId !== expected.employeeId ||
          event.packageDigest !== expected.packageDigest))
    ) {
      protocolError("RUNNER_EVENT_CHAIN_INVALID")
    }
    validated.push(event)
    previousDigest = event.digest
  }
  return {
    events: Object.freeze(validated) as unknown as RunnerEvent[],
    finalDigest: previousDigest,
  }
}

function usageSummary(
  value: unknown,
  code: RunnerProtocolErrorCode,
): RunnerUsageSummary {
  const record = dataRecord(
    value,
    ["inputTokens", "outputTokens", "durationMilliseconds", "actions"],
    code,
  )
  const rawActions = dataArray(record.actions, MAX_ACTIONS, code)
  const actions: Array<{ name: string; count: number }> = []
  let previousName: string | undefined
  for (const value of rawActions) {
    const action = dataRecord(value, ["name", "count"], code)
    const name = machineCodeField(action.name, code)
    if (previousName !== undefined && name <= previousName) protocolError(code)
    previousName = name
    actions.push({
      name,
      count: safeInteger(action.count, code),
    })
  }
  return deepFreeze({
    inputTokens: safeInteger(record.inputTokens, code),
    outputTokens: safeInteger(record.outputTokens, code),
    durationMilliseconds: safeInteger(record.durationMilliseconds, code),
    actions,
  })
}

function runnerOutcome(
  value: unknown,
  code: RunnerProtocolErrorCode,
): RunnerOutcome {
  let status: unknown
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      utilTypes.isProxy(value) ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      protocolError(code)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "status")
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      protocolError(code)
    }
    status = descriptor.value
  } catch (error) {
    if (error instanceof RunnerProtocolError) throw error
    protocolError(code)
  }
  if (status === "completed") {
    const record = optionalDataRecord(value, ["status"], ["output"], code)
    return deepFreeze({
      status,
      ...(record.output === undefined
        ? {}
        : { output: opaqueData(record.output, code) }),
    })
  }
  if (status === "failed") {
    const record = dataRecord(value, ["status", "errorCode"], code)
    return Object.freeze({
      status,
      errorCode: machineCodeField(record.errorCode, code),
    })
  }
  if (status === "cancelled_by_runner") {
    const record = dataRecord(value, ["status", "reasonCode"], code)
    return Object.freeze({
      status,
      reasonCode: machineCodeField(record.reasonCode, code),
    })
  }
  protocolError(code)
}

export function validateRunnerReceipt(input: unknown): RunnerReceiptPayload {
  const code = "RUNNER_RECEIPT_INVALID" as const
  const record = optionalDataRecord(
    input,
    [
      "protocolVersion",
      "kind",
      "taskId",
      "runId",
      "attempt",
      "fencingToken",
      "leaseId",
      "quoteId",
      "reservationId",
      "sellerId",
      "runnerId",
      "employee",
      "engine",
      "startedAt",
      "completedAt",
      "eventCount",
      "finalEventDigest",
      "usage",
      "outcome",
    ],
    ["providerEvidence"],
    code,
  )
  if (
    record.protocolVersion !== RUNNER_PROTOCOL_VERSION ||
    record.kind !== "runner.receipt"
  ) {
    protocolError(code)
  }
  const employee = dataRecord(
    record.employee,
    ["id", "version", "packageDigest"],
    code,
  )
  const startedAt = timestamp(record.startedAt, code)
  const completedAt = timestamp(record.completedAt, code)
  if (completedAt.milliseconds < startedAt.milliseconds) protocolError(code)
  const eventCount = safeInteger(record.eventCount, code, {
    maximum: MAX_EVENTS,
  })
  const finalEventDigest = digestField(record.finalEventDigest, code)
  if (
    (eventCount === 0 && finalEventDigest !== RUNNER_EVENT_GENESIS_DIGEST) ||
    (eventCount > 0 && finalEventDigest === RUNNER_EVENT_GENESIS_DIGEST)
  ) {
    protocolError(code)
  }
  return deepFreeze({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.receipt",
    taskId: idField(record.taskId, code),
    runId: idField(record.runId, code),
    attempt: safeInteger(record.attempt, code, {
      minimum: 1,
      maximum: MAX_RUNNER_ATTEMPTS,
    }),
    fencingToken: safeInteger(record.fencingToken, code, { minimum: 1 }),
    leaseId: idField(record.leaseId, code),
    quoteId: idField(record.quoteId, code),
    reservationId: idField(record.reservationId, code),
    sellerId: idField(record.sellerId, code),
    runnerId: idField(record.runnerId, code),
    employee: {
      id: idField(employee.id, code),
      version: semverField(employee.version, code),
      packageDigest: digestField(employee.packageDigest, code),
    },
    engine: idField(record.engine, code),
    startedAt: startedAt.value,
    completedAt: completedAt.value,
    eventCount,
    finalEventDigest,
    usage: usageSummary(record.usage, code),
    outcome: runnerOutcome(record.outcome, code),
    ...(record.providerEvidence === undefined
      ? {}
      : { providerEvidence: opaqueData(record.providerEvidence, code) }),
  })
}

export function signRunnerReceipt(options: {
  receipt: unknown
  keyId: string
  privateKey: KeyLike
}): SignedEnvelope {
  const receipt = validateRunnerReceipt(options.receipt)
  return signRunnerEnvelope({
    domain: RUNNER_RECEIPT_DOMAIN,
    keyId: options.keyId,
    privateKey: options.privateKey,
    payload: Buffer.from(canonicalRunnerJson(receipt), "utf8"),
  })
}

export function verifyRunnerReceipt(options: {
  envelope: unknown
  publicKey: KeyLike
}): RunnerReceiptPayload {
  const payload = verifyRunnerEnvelope({
    domain: RUNNER_RECEIPT_DOMAIN,
    envelope: options.envelope,
    publicKey: options.publicKey,
  })
  const receipt = validateRunnerReceipt(
    parsePayload(payload, "RUNNER_RECEIPT_INVALID"),
  )
  if (
    payload.compare(Buffer.from(canonicalRunnerJson(receipt), "utf8")) !== 0
  ) {
    protocolError("RUNNER_RECEIPT_INVALID")
  }
  return receipt
}

function bindRunnerExecutionBundle(options: {
  task: RunnerTaskPayload
  events: readonly unknown[]
  receipt: RunnerReceiptPayload
  observedAt: string
}): VerifiedRunnerExecutionBundle {
  const task = options.task
  const receipt = options.receipt
  const observedAt = timestamp(
    options.observedAt,
    "RUNNER_RECEIPT_INVALID",
  ).milliseconds
  if (
    receipt.taskId !== task.taskId ||
    receipt.runId !== task.runId ||
    receipt.attempt !== task.attempt ||
    receipt.fencingToken !== task.fencingToken ||
    receipt.leaseId !== task.leaseId ||
    receipt.quoteId !== task.quoteId ||
    receipt.reservationId !== task.reservationId ||
    receipt.sellerId !== task.sellerId ||
    receipt.runnerId !== task.runnerId ||
    receipt.employee.id !== task.employee.id ||
    receipt.employee.version !== task.employee.version ||
    receipt.employee.packageDigest !== task.employee.packageDigest ||
    receipt.engine !== task.engine
  ) {
    protocolError("RUNNER_RECEIPT_INVALID")
  }
  const chain = verifyRunnerEventChain(options.events, {
    taskId: task.taskId,
    runId: task.runId,
    attempt: task.attempt,
    fencingToken: task.fencingToken,
    leaseId: task.leaseId,
    quoteId: task.quoteId,
    runnerId: task.runnerId,
    employeeId: task.employee.id,
    packageDigest: task.employee.packageDigest,
  })
  if (
    receipt.eventCount !== chain.events.length ||
    receipt.finalEventDigest !== chain.finalDigest
  ) {
    protocolError("RUNNER_RECEIPT_INVALID")
  }
  const issuedAt = Date.parse(task.issuedAt)
  const hardExpiry = Math.min(
    Date.parse(task.expiresAt),
    Date.parse(task.leaseExpiresAt),
  )
  const startedAt = Date.parse(receipt.startedAt)
  const completedAt = Date.parse(receipt.completedAt)
  if (
    startedAt < issuedAt - MAX_RUNNER_CLOCK_SKEW_MS ||
    completedAt >= hardExpiry ||
    completedAt > observedAt + MAX_RUNNER_CLOCK_SKEW_MS
  ) {
    protocolError("RUNNER_RECEIPT_INVALID")
  }
  let previousTimestamp = startedAt
  for (const event of chain.events) {
    const eventTimestamp = Date.parse(event.timestamp)
    if (
      eventTimestamp < previousTimestamp ||
      eventTimestamp > completedAt ||
      eventTimestamp >= hardExpiry ||
      eventTimestamp > observedAt + MAX_RUNNER_CLOCK_SKEW_MS
    ) {
      protocolError("RUNNER_EVENT_CHAIN_INVALID")
    }
    previousTimestamp = eventTimestamp
  }
  return Object.freeze({ task, events: chain.events, receipt })
}

/**
 * Verifies both signed envelopes, then recomputes the independent event chain
 * and binds it to the verified task and receipt. Public keys must come from
 * trusted platform and Runner registries, never from the submitted bundle.
 * Signatures prove origin/integrity only; billing trust remains a separate
 * platform UsageVerifier decision.
 */
export function verifyRunnerExecutionBundle(options: {
  taskEnvelope: unknown
  platformPublicKey: KeyLike
  events: readonly unknown[]
  receiptEnvelope: unknown
  runnerPublicKey: KeyLike
  observedAt: string
}): VerifiedRunnerExecutionBundle {
  const task = verifyRunnerTask({
    envelope: options.taskEnvelope,
    publicKey: options.platformPublicKey,
  })
  const receipt = verifyRunnerReceipt({
    envelope: options.receiptEnvelope,
    publicKey: options.runnerPublicKey,
  })
  return bindRunnerExecutionBundle({
    task,
    events: options.events,
    receipt,
    observedAt: options.observedAt,
  })
}
