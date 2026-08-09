import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { main } from "../src/06-time-travel-rewind.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("re-derives state at a frame and rewinds the journal suffix", async () => {
  const summary = await Effect.runPromise(main(join(directory, "ledger.sqlite")))
  expect(summary.derivedTotal).toBe(30)
  expect(summary.archivedCount).toBe(2)
  expect(summary.remainingSeqs).toHaveLength(2)
  expect(summary.auditStatus).toBe("completed")
})
