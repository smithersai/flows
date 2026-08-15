import * as Flow from "@smthrs/core/Flow"
import * as Binding from "@smthrs/scorers/Binding"
import * as Scorer from "@smthrs/scorers/Scorer"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import * as CaseExecutor from "../src/CaseExecutor.ts"
import { EvalError } from "../src/EvalError.ts"
import * as Runner from "../src/Runner.ts"
import * as Suite from "../src/Suite.ts"

const target = Flow.make({ name: "target" })
const scorerFlow = Scorer.make({
  name: "exact",
  score: ({ output, groundTruth }) =>
    Effect.succeed({
      score: Object.is(output, groundTruth ?? output) ? 1 : 0,
      reason: "exact"
    })
})
const binding = Binding.make({ scorer: scorerFlow, appliesTo: target })

const inlineScorer: Runner.ScoreBatchRunner = {
  runBatch: (jobs, options) =>
    Effect.forEach(
      jobs,
      (job) =>
        job.score.pipe(
          Effect.flatMap(Scorer.validate),
          Effect.map((result): Runner.ScoreObservation => ({
            ...job.observation,
            kind: "score",
            score: result.score,
            ...(result.reason === undefined ? {} : { reason: result.reason }),
            ...(result.meta === undefined ? {} : { meta: result.meta }),
            at: job.at ?? 0
          }))
        ),
      { concurrency: options?.concurrency ?? 1 }
    )
}

describe("Runner", () => {
  it("keeps declaration order under bounded concurrency", async () => {
    const suite = await Effect.runPromise(
      Suite.make({
        name: "order",
        concurrency: 2,
        bindings: [binding],
        cases: [{ name: "slow", input: 1 }, { name: "fast", input: 2 }]
      })
    )
    const executor = CaseExecutor.make((suiteCase) =>
      suiteCase.name === "slow"
        ? Effect.sleep("20 millis").pipe(
          Effect.as({ output: suiteCase.input, stepKey: suiteCase.name, latencyMs: 20, target })
        )
        : Effect.succeed({ output: suiteCase.input, stepKey: suiteCase.name, latencyMs: 1, target })
    )
    const scorer = {
      runBatch: (requests: ReadonlyArray<Runner.ScoreJob>) =>
        Effect.succeed(
          requests.map((request) => ({
            ...request.observation,
            kind: "score" as const,
            score: 1,
            reason: "ok",
            at: 0
          }))
        )
    }
    const result = await Effect.runPromise(
      Runner.run(suite, { scorer }).pipe(
        Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(executor)),
        Effect.provide(Runner.layerNoop)
      )
    )
    expect(result.cases.map((caseResult) => caseResult.case)).toEqual(["slow", "fast"])
  })

  it("propagates scorer failures as inconclusive observations", async () => {
    const suite = await Effect.runPromise(
      Suite.make({ name: "failure", concurrency: 1, bindings: [binding], cases: [{ name: "one", input: 1 }] })
    )
    const executor = CaseExecutor.make((suiteCase) =>
      Effect.succeed({ output: suiteCase.input, stepKey: "step", latencyMs: 0, target })
    )
    const scorer = { runBatch: () => Effect.fail("judge unavailable") }
    const result = await Effect.runPromise(
      Runner.run(suite, { scorer }).pipe(
        Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(executor)),
        Effect.provide(Runner.layerNoop)
      )
    )
    expect(result.observations[0]?.kind).toBe("inconclusive")
  })

  it("retains a typed target failure without re-running the target", async () => {
    const suite = await Effect.runPromise(
      Suite.make({ name: "target-failure", concurrency: 1, cases: [{ name: "one", input: 1 }] })
    )
    const executor = CaseExecutor.make(() => Effect.fail(new EvalError({ code: "executor", message: "target failed" })))
    const result = await Effect.runPromise(
      Runner.run(suite).pipe(
        Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(executor)),
        Effect.provide(Runner.layerNoop)
      )
    )
    expect(result.cases[0]?.error?.code).toBe("executor")
  })

  it("applies deterministic scorer sampling before batch execution", async () => {
    const unsampled = Binding.make({ scorer: scorerFlow, appliesTo: target, sampling: "none" })
    const suite = await Effect.runPromise(
      Suite.make({
        name: "sampling",
        concurrency: 1,
        bindings: [unsampled],
        cases: [{ name: "one", input: 1 }]
      })
    )
    const executor = CaseExecutor.make((suiteCase) =>
      Effect.succeed({ output: suiteCase.input, stepKey: "step", latencyMs: 0, target })
    )
    let batches = 0
    const scorer = {
      runBatch: (_requests: ReadonlyArray<Runner.ScoreJob>) =>
        Effect.sync(() => {
          batches += 1
          return []
        })
    }
    const result = await Effect.runPromise(
      Runner.run(suite, { scorer }).pipe(
        Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(executor)),
        Effect.provide(Runner.layerNoop)
      )
    )
    expect(batches).toBe(0)
    expect(result.observations).toEqual([])
  })

  it("runs sampled bound scorers inline and omits unsampled bindings", async () => {
    const unsampled = Binding.make({ scorer: scorerFlow, appliesTo: target, sampling: "none" })
    const suite = await Effect.runPromise(
      Suite.make({
        name: "mixed-sampling",
        concurrency: 1,
        bindings: [binding, unsampled],
        cases: [{ name: "one", input: 1 }]
      })
    )
    const executor = CaseExecutor.make((suiteCase) =>
      Effect.succeed({ output: suiteCase.input, stepKey: "step", latencyMs: 0, target })
    )
    const result = await Effect.runPromise(
      Runner.run(suite).pipe(
        Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(executor)),
        Effect.provide(Layer.succeed(Runner.Runner)(inlineScorer))
      )
    )

    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]?.kind).toBe("score")
  })

  it("propagates fiber interruption", async () => {
    const suite = await Effect.runPromise(
      Suite.make({ name: "interrupt", concurrency: 1, cases: [{ name: "one", input: 1 }] })
    )
    const executor = CaseExecutor.make(() => Effect.never)
    const run = Runner.run(suite).pipe(
      Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(executor)),
      Effect.provide(Runner.layerNoop),
      Effect.timeout("10 millis")
    )
    const exit = await Effect.runPromiseExit(run)
    expect(exit._tag).toBe("Failure")
  })

  it("applies bindings only to their target and forwards ground truth and context", async () => {
    const other = Flow.make({ name: "other" })
    let seen: Scorer.Input | undefined
    const inspecting = Scorer.make({
      name: "inspect",
      score: (input) =>
        Effect.sync(() => {
          seen = input
          return { score: 1 }
        })
    })
    const suite = await Effect.runPromise(
      Suite.make({
        name: "bindings",
        concurrency: 1,
        bindings: [
          Binding.make({
            scorer: inspecting,
            appliesTo: target,
            groundTruth: "answer",
            context: { rubric: "exact" }
          }),
          Binding.make({ scorer: inspecting, appliesTo: other })
        ],
        cases: [{ name: "one", input: "question" }]
      })
    )
    const executor = CaseExecutor.make(() =>
      Effect.succeed({ output: "answer", stepKey: "step", latencyMs: 1, target })
    )
    const result = await Effect.runPromise(
      Runner.run(suite, { runId: "run", sampleId: "sample" }).pipe(
        Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(executor)),
        Effect.provide(Layer.succeed(Runner.Runner)(inlineScorer))
      )
    )
    expect(result.observations).toHaveLength(1)
    expect(seen).toMatchObject({
      input: "question",
      output: "answer",
      groundTruth: "answer",
      context: { rubric: "exact" }
    })
  })
})
