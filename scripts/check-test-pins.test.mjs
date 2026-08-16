import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { findPins, guardedGroups, guardedPackages, notesPath, undocumentedPins } from "./check-test-pins.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

test("finds every outright pin form, whatever the runner prefix", () => {
  const source = [
    `it.fails("a", () => {})`,
    `test.skip("b", () => {})`,
    `it.effect.skip("c", () => {})`,
    `it.live.todo("d")`,
    `describe.skip("e", () => {})`
  ].join("\n")

  assert.deepEqual(findPins(source).map((pin) => [pin.form, pin.title, pin.line]), [
    ["fails", "a", 1],
    ["skip", "b", 2],
    ["skip", "c", 3],
    ["todo", "d", 4],
    ["skip", "e", 5]
  ])
})

test("a capability gate is not a pin", () => {
  const source = [
    `describe.skipIf(process.platform === "win32")("windows", () => {})`,
    `describe.skipIf(!jjInstalled)("needs jj", () => {})`,
    `describe.skipIf(wasmBytes === undefined)("needs wasm", () => {})`,
    `describe.runIf(Boolean(process.env.CI))("ci only", () => {})`
  ].join("\n")

  assert.deepEqual(findPins(source), [])
})

test("an environment-variable gate is a pin, inline or through a const", () => {
  const inline = `it.live.runIf(process.env.FLOWS_SLOW_TESTS === "1")("slow one", () => {})`
  assert.deepEqual(findPins(inline).map((pin) => pin.title), ["slow one"])

  const aliased = [
    `const slowTests = process.env.FLOWS_SLOW_TESTS === "1"`,
    `it.live.runIf(slowTests)("slow two", () => {})`,
    `it.effect.skipIf(!slowTests)("slow three", () => {})`
  ].join("\n")
  assert.deepEqual(findPins(aliased).map((pin) => pin.title), ["slow two", "slow three"])
})

test("a pin counts as documented only when the notes quote its title", () => {
  const packages = [resolve(repoRoot, "packages", "database")]
  assert.deepEqual(undocumentedPins(readFileSync(notesPath, "utf8"), packages), [])

  const unexplained = undocumentedPins("# Alpha notes\n\nNothing here.\n", packages)
  assert.equal(unexplained.length, 1)
  assert.match(unexplained[0].title, /open-retry budget is exhausted/)
  assert.equal(unexplained[0].file, "packages/database/test/NodeDatabaseConcurrentOpen.test.ts")
})

test("the guarded set is the engine and tooling groups, read from the manifests", () => {
  assert.deepEqual([...guardedGroups].sort(), ["engine", "tooling"])

  const guarded = new Set(guardedPackages().map((directory) => directory.split("/").pop()))
  assert.ok(guarded.has("database"), "database is an engine package")
  assert.ok(guarded.has("tsflows-cli"), "tsflows-cli is a tooling package")
  assert.ok(!guarded.has("harness"), "harness is an agent package and out of scope")
})

test("the register exists and every pin in the tree appears in it", () => {
  assert.ok(existsSync(notesPath), "docs/alpha-notes.md is the register the guard reads")
  assert.match(readFileSync(notesPath, "utf8"), /## Known test pins/)
  assert.deepEqual(undocumentedPins(), [])
})
