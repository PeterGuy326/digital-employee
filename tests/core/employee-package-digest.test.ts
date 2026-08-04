import assert from "node:assert/strict"
import test from "node:test"

import { computeEmployeePackageDigest } from "../../packages/core/src/employee-package-digest.js"

test("employee package digests are byte-exact and independent of entry order", () => {
  const entries = [
    { path: "./employee.json", bytes: Buffer.from("{\"version\":1}\n") },
    { path: "./SKILL.md", bytes: Buffer.from("# Employee\n") },
  ]
  const digest = computeEmployeePackageDigest(entries)
  assert.equal(
    digest,
    "sha256:944ce8ec7857478db635a6447c2108e068c6fdf24bca91f21d7bcee04369a016",
  )
  assert.equal(computeEmployeePackageDigest([...entries].reverse()), digest)
  assert.notEqual(
    computeEmployeePackageDigest([
      entries[0],
      { path: "./SKILL.md", bytes: Buffer.from("# Employee\r\n") },
    ]),
    digest,
  )
})

test("employee package digests reject duplicate, unsafe, and accessor entries", () => {
  const entry = { path: "./employee.json", bytes: Buffer.from("{}") }
  assert.throws(() => computeEmployeePackageDigest([entry, entry]))
  assert.throws(() =>
    computeEmployeePackageDigest([
      { path: "./../employee.json", bytes: Buffer.from("{}") },
    ]),
  )
  let reads = 0
  const accessor = Object.defineProperties({}, {
    path: {
      enumerable: true,
      get() {
        reads += 1
        return "./employee.json"
      },
    },
    bytes: { enumerable: true, value: Buffer.from("{}") },
  }) as { path: string; bytes: Uint8Array }
  assert.throws(() => computeEmployeePackageDigest([accessor]))
  assert.equal(reads, 0)

  let traps = 0
  const proxy = new Proxy([entry], {
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
  assert.throws(() => computeEmployeePackageDigest(proxy))
  assert.equal(traps, 0)
})
