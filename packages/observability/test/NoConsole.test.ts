import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

describe("console guard", () => {
  it("finds no direct console calls in package source", () => {
    const result = spawnSync("rg", [
      "-n",
      "console\\.(log|info|warn|error|debug|trace)\\s*\\(",
      "../../packages",
      "--glob",
      "*/src/**"
    ], { encoding: "utf8" })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
  })
})
