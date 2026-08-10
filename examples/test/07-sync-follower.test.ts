import * as Effect from "effect/Effect"
import { expect, it } from "vitest"
import { main } from "../src/07-sync-follower.ts"

it("catches up on durable history, then follows live commits", async () => {
  const summary = await Effect.runPromise(main)
  expect(summary.caughtUp).toEqual(["run.started", "step.recorded"])
  expect(summary.followed).toEqual(["run.completed"])
})
