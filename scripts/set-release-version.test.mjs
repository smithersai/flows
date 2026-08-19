import assert from "node:assert/strict"
import test from "node:test"
import { mismatches, readManifests, retarget } from "./set-release-version.mjs"

const workspaceNames = new Set(["@smthrs/kernel", "@smthrs/flows"])

const example = {
  name: "@smthrs/flows",
  version: "0.1.0",
  dependencies: {
    "@smthrs/kernel": "0.1.0",
    effect: "4.0.0-rc.108"
  },
  devDependencies: {
    "@smthrs/kernel": "workspace:*",
    vitest: "4.1.9"
  }
}

test("retarget moves the version and the exact workspace ranges together", () => {
  assert.deepEqual(retarget(example, "0.1.0-next.0", workspaceNames), {
    name: "@smthrs/flows",
    version: "0.1.0-next.0",
    dependencies: {
      "@smthrs/kernel": "0.1.0-next.0",
      effect: "4.0.0-rc.108"
    },
    devDependencies: {
      // A protocol range carries no version, so it cannot drift.
      "@smthrs/kernel": "workspace:*",
      vitest: "4.1.9"
    }
  })
  assert.equal(example.version, "0.1.0")
})

test("retarget leaves third-party ranges alone", () => {
  const retargeted = retarget(example, "9.9.9", new Set())
  assert.equal(retargeted.dependencies["@smthrs/kernel"], "0.1.0")
  assert.equal(retargeted.version, "9.9.9")
})

test("mismatches names the version and every stale internal range", () => {
  const entries = [
    { directory: "flows", manifest: example },
    {
      directory: "kernel",
      manifest: { name: "@smthrs/kernel", version: "0.1.0-next.0" }
    }
  ]

  assert.deepEqual(mismatches(entries, "0.1.0-next.0"), [
    "packages/flows: version is 0.1.0, expected 0.1.0-next.0",
    "packages/flows: dependencies.@smthrs/kernel is 0.1.0, expected 0.1.0-next.0"
  ])
  assert.deepEqual(mismatches(entries.slice(1), "0.1.0-next.0"), [])
})

test("this workspace is internally coherent at its current version", () => {
  const entries = readManifests()
  const version = entries.find(({ directory }) => directory === "flows").manifest.version

  assert.deepEqual(mismatches(entries, version), [])
})
