import * as Effect from "effect/Effect"
import { expect, it } from "vitest"
import { main } from "../src/01-define-and-run.ts"

it("runs a typed flow on the in-memory engine", async () => {
  expect(await Effect.runPromise(main)).toBe("Hello, Ada.")
})
