import { tsImport } from "tsx/esm/api"
import { installEffectResolution } from "./src/effect-resolution.js"
installEffectResolution()
const root = process.argv[2]
const SI = await import("effect/SchemaIssue")
const W = await tsImport(new URL("./src/Workspace.ts", import.meta.url).href, { parentURL: import.meta.url, tsconfig: false })
try {
  const cfg = await W.resolveConfig(root)
  const ws = await W.Workspace.make(root, root, { cacheDirectory: cfg.cacheDirectory })
  const targets = await ws.targets("//...")
  console.log("OK targets:", targets.length)
} catch (e) {
  console.log(e?.stack?.split("\n").slice(0,6).join("\n"))
  const issue = e?.cause
  if (issue) {
    const f = SI.makeFormatterDefault()
    console.log("ISSUE:", JSON.stringify((typeof f === "function" ? f(issue) : f.format ? f.format(issue) : String(f)), null, 2).slice(0, 3000))
  }
}
