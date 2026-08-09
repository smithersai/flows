import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { main } from "../src/05-time-travel-fork.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("forks a finished run and replays its recorded attempts", async () => {
  const summary = await Effect.runPromise(main(join(directory, "analyse.sqlite")))
  expect(summary.parentResult).toBe("42")
  expect(summary.forkResult).toBe("42")
  expect(summary.forkRunId).not.toBe("analyse-1")
  expect(summary.dispatches).toBe(1)
  expect(summary.parentEntryCount).toBeGreaterThan(0)
})
