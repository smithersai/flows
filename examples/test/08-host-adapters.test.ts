import * as Effect from "effect/Effect"
import { expect, it } from "vitest"
import { main } from "../src/08-host-adapters.ts"

it("runs one host program on the test and Node adapters", async () => {
  const summary = await Effect.runPromise(main)
  expect(summary.scriptedRead).toBe("hello from memory")
  expect(summary.scriptedExec).toBe("hello from script")
  expect(summary.nodeExec).toBe("hello from node")
})
