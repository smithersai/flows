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
  // Folded from an ORDINARY engine journal: nothing in the example writes
  // `meta.lineageId`, the engine does.
  expect(summary.derivedAttempts).toBeGreaterThan(0)
  expect(summary.archivedCount).toBeGreaterThan(0)
  expect(summary.remainingSeqs.length).toBeLessThan(summary.totalEntries)
  expect(summary.auditStatus).toBe("completed")
})
