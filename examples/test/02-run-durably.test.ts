import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { main } from "../src/02-run-durably.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("runs a flow durably and journals its lifecycle", async () => {
  const summary = await Effect.runPromise(main(join(directory, "build.sqlite")))
  expect(summary.result).toBe("dist/server.js?target=server")
  expect(summary.eventTypes.length).toBeGreaterThan(0)
})
