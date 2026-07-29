import { build } from "esbuild"
import { describe, expect, it } from "vitest"

describe("browser bundle", () => {
  it("does not resolve Node built-ins from the root entry", async () => {
    const result = await build({
      entryPoints: ["src/index.ts"],
      absWorkingDir: new URL("..", import.meta.url).pathname,
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      logLevel: "silent"
    })
    const output = result.outputFiles[0]?.text ?? ""
    expect(output).not.toMatch(/node:(?:fs|path|child_process|module|crypto)/)
    expect(output).not.toMatch(/require\(["']node:/)
  })
})
