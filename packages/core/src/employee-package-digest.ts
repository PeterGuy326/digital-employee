import { createHash } from "node:crypto"
import { types as utilTypes } from "node:util"

import { ValidationError } from "./contracts.js"

export const EMPLOYEE_PACKAGE_DIGEST_DOMAIN =
  "digital-employee.employee-package.v1" as const

const MAX_ENTRIES = 513
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 + 256 * 1024
const PORTABLE_FILE_PATTERN = /^\.\/(?!.*\\)[^\u0000-\u001f\u007f]+$/

export interface EmployeePackageDigestEntry {
  path: string
  bytes: Uint8Array
}

function uint32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32BE(value)
  return buffer
}

function uint64(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(8)
  buffer.writeBigUInt64BE(BigInt(value))
  return buffer
}

function invalidDigestInput(): never {
  throw new ValidationError("employee_package_digest_input_invalid")
}

function validatePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 1_024 ||
    !PORTABLE_FILE_PATTERN.test(value)
  ) {
    invalidDigestInput()
  }
  const segments = value.slice(2).split("/")
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => !segment || segment === "." || segment === "..",
    )
  ) {
    invalidDigestInput()
  }
  return value
}

/**
 * Hashes only portable paths and exact file bytes. Filesystem metadata,
 * directory order, locale, timestamps and permissions are deliberately absent.
 */
export function computeEmployeePackageDigest(
  entries: readonly EmployeePackageDigestEntry[],
): string {
  if (utilTypes.isProxy(entries) || !Array.isArray(entries)) {
    invalidDigestInput()
  }
  let capturedEntries: unknown[]
  try {
    if (Object.getPrototypeOf(entries) !== Array.prototype) invalidDigestInput()
    const descriptors = Object.getOwnPropertyDescriptors(entries) as Record<
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
      length < 1 ||
      length > MAX_ENTRIES ||
      keys.length !== length + 1
    ) {
      invalidDigestInput()
    }
    capturedEntries = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        invalidDigestInput()
      }
      capturedEntries.push(descriptor.value)
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error
    invalidDigestInput()
  }
  const captured: Array<{ path: string; pathBytes: Buffer; bytes: Buffer }> = []
  const seen = new Set<string>()
  let totalBytes = 0
  for (const entry of capturedEntries) {
    let descriptors: Record<string, PropertyDescriptor>
    try {
      if (
        !entry ||
        typeof entry !== "object" ||
        utilTypes.isProxy(entry) ||
        Object.getPrototypeOf(entry) !== Object.prototype
      ) {
        invalidDigestInput()
      }
      descriptors = Object.getOwnPropertyDescriptors(entry)
      if (
        Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
        Object.keys(descriptors).length !== 2 ||
        !("value" in (descriptors.path ?? {})) ||
        !(descriptors.path?.enumerable) ||
        !("value" in (descriptors.bytes ?? {})) ||
        !(descriptors.bytes?.enumerable)
      ) {
        invalidDigestInput()
      }
    } catch (error) {
      if (error instanceof ValidationError) throw error
      invalidDigestInput()
    }
    const path = validatePath(descriptors.path.value)
    if (seen.has(path)) invalidDigestInput()
    seen.add(path)
    const rawBytes = descriptors.bytes.value as unknown
    if (utilTypes.isProxy(rawBytes) || !(rawBytes instanceof Uint8Array)) {
      invalidDigestInput()
    }
    let bytes: Buffer
    try {
      bytes = Buffer.from(rawBytes)
    } catch {
      invalidDigestInput()
    }
    totalBytes += bytes.length
    if (totalBytes > MAX_TOTAL_BYTES) invalidDigestInput()
    captured.push({ path, pathBytes: Buffer.from(path, "utf8"), bytes })
  }
  captured.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes))

  const hash = createHash("sha256")
  hash.update(`${EMPLOYEE_PACKAGE_DIGEST_DOMAIN}\n`, "ascii")
  hash.update(uint32(captured.length))
  for (const entry of captured) {
    hash.update(uint32(entry.pathBytes.length))
    hash.update(entry.pathBytes)
    hash.update(uint64(entry.bytes.length))
    hash.update(entry.bytes)
  }
  return `sha256:${hash.digest("hex")}`
}
