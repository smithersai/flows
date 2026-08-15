#!/usr/bin/env node

import { tsImport } from "tsx/esm/api"
import { installEffectResolution } from "./effect-resolution.js"

// BUILD.ts rules and the flow engine must share one Effect module instance.
// Linked development packages can otherwise resolve physically separate peer
// copies whose schema internals are not interoperable.
installEffectResolution()

await tsImport(new URL("./main.ts", import.meta.url).href, {
  parentURL: import.meta.url,
  tsconfig: false
})
