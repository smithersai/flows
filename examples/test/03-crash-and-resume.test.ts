import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { main } from "../src/03-crash-and-resume.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("resumes a suspended run without re-dispatching completed work", async () => {
  const summary = await Effect.runPromise(main(join(directory, "review.sqlite")))
  expect(summary.result).toBe("rfc:draft body:approved")
  expect(summary.handlerEntries).toBeGreaterThan(1)
  expect(summary.readDispatches).toBe(1)
})
