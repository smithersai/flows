import * as Flow from "@smthrs/core/Flow"
import * as Binding from "@smthrs/scorers/Binding"
import * as Scorer from "@smthrs/scorers/Scorer"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { readFile } from "node:fs/promises"
import * as Baseline from "../src/Baseline.ts"
import * as CaseExecutor from "../src/CaseExecutor.ts"
import { EvalError } from "../src/EvalError.ts"
import * as Gate from "../src/Gate.ts"
import * as Regression from "../src/Regression.ts"
import * as Report from "../src/Report.ts"
import * as Runner from "../src/Runner.ts"
import * as Suite from "../src/Suite.ts"

const target = Flow.make({ name: "ci-smoke-echo" })
const exact = Scorer.make({
  name: "exact",
  score: ({ output, groundTruth }) =>
    Effect.succeed({
      score: JSON.stringify(output) === JSON.stringify(groundTruth) ? 1 : 0,
      reason: "deep JSON equality"
    })
})

const program = Effect.gen(function*() {
  const [suiteText, baselineText] = yield* Effect.promise(() =>
    Promise.all([
      readFile(new URL("../suites/ci-smoke.jsonl", import.meta.url), "utf8"),
      readFile(new URL("../baselines/ci-smoke.json", import.meta.url), "utf8")
    ])
  )
  const suite = yield* Suite.fromJsonLines(suiteText, {
    name: "ci-smoke",
    concurrency: 1,
    bindings: [Binding.make({ scorer: exact, appliesTo: target })]
  })
  const run = yield* Runner.run(suite, {
    runId: "ci-smoke",
    sampleId: "committed"
  })
  const baseline = yield* Baseline.load(baselineText)
  const regression = yield* Regression.compare(baseline, run)
  if (
    regression.regressions.length > 0 ||
    regression.nondeterminism.length > 0 ||
    regression.missing.length > 0
  ) {
    return yield* Effect.fail(
      new EvalError({
        code: "invalid_baseline",
        message: "Committed evaluation baseline does not match the current run"
      })
    )
  }
  const verdict = yield* Gate.check(regression, { mean: 1, min: 1 })
  return { regression, verdict }
}).pipe(
  Effect.provide(
    Layer.succeed(
      CaseExecutor.CaseExecutor
    )(
      CaseExecutor.make((suiteCase) =>
        Effect.succeed({
          output: suiteCase.input,
          stepKey: "ci-smoke:echo:v1",
          latencyMs: 0,
          target
        })
      )
    )
  )
)

const result = await Effect.runPromise(program)
process.stdout.write(Report.json(result.regression))
process.exitCode = Gate.ciGrade(result.verdict).exitCode
