import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { fatalDecision, ladder, main } from "../src/04-retry-policy.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("computes the backoff ladder from policy data alone", () => {
  expect(ladder).toEqual([100, 200, 400, null])
  expect(fatalDecision).toEqual({ _tag: "GiveUp", reason: "nonRetryable" })
})

it("retries a flaky activity until it succeeds", async () => {
  const summary = await Effect.runPromise(main(join(directory, "publish.sqlite")))
  expect(summary.result).toBe("v1:uploaded")
  expect(summary.dispatches).toBe(3)
  expect(summary.attempts).toEqual([1, 2, 3])
})
