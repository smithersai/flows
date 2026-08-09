import assert from "node:assert/strict"
import test from "node:test"
import { publicationManifest } from "./pack-release.mjs"

test("publicationManifest replaces source exports without mutating the input", () => {
  const manifest = {
    name: "@smthrs/example",
    exports: {
      ".": "./src/index.ts"
    },
    publishConfig: {
      access: "public",
      provenance: true,
      exports: {
        ".": {
          types: "./dist/esm/index.d.ts",
          import: "./dist/esm/index.js",
          require: "./dist/cjs/index.js"
        }
      }
    }
  }

  assert.deepEqual(publicationManifest(manifest), {
    name: "@smthrs/example",
    exports: {
      ".": {
        types: "./dist/esm/index.d.ts",
        import: "./dist/esm/index.js",
        require: "./dist/cjs/index.js"
      }
    },
    publishConfig: {
      access: "public",
      provenance: true
    }
  })
  assert.equal(manifest.exports["."], "./src/index.ts")
  assert.ok("exports" in manifest.publishConfig)
})

test("publicationManifest rejects a package without publication exports", () => {
  assert.throws(
    () => publicationManifest({ name: "@smthrs/example", publishConfig: { access: "public" } }),
    /publishConfig\.exports/
  )
})
