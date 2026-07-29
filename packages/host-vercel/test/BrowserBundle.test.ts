import { build } from "esbuild"
import { describe, expect, it } from "vitest"

describe("Vercel edge bundle", () => {
  it("does not pull Node built-ins into the root entry point", async () => {
    const result = await build({
      entryPoints: ["src/index.ts"],
      absWorkingDir: new URL("..", import.meta.url).pathname,
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      external: ["effect", "@flows/host/*"]
    })
    const output = result.outputFiles[0]?.text ?? ""
    expect(output).not.toMatch(/node:(fs|path|child_process|module|crypto)/)
  })
})
