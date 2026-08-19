/**
 * Coverage baseline: run every package's vitest suite with coverage and
 * write a per-package gap report, the input for the 100%-coverage sprint.
 * Waves of parallel `ShellTask` steps, one flow per wave.
 *
 * Launch: `bun factory/flows/coverage-baseline.ts`
 * Progress: tail factory/reports/coverage/<package>.log
 * Result:   factory/reports/COVERAGE-BASELINE.md
 */
import * as Schema from "effect/Schema"
import * as fs from "node:fs"
import * as path from "node:path"
import { Flow } from "../../packages/flow/src/index.ts"
import { Node } from "../../packages/plan/src/index.ts"
import {
  chunk,
  FLOWS_ROOT,
  listPackages,
  REPORTS_DIR,
  runFlow,
  ShellTask,
  type TaskResult
} from "./harness.ts"

const WAVE_SIZE = 4
const TIMEOUT_MS = 20 * 60_000
const logDir = path.join(REPORTS_DIR, "coverage")
const reportPath = path.join(REPORTS_DIR, "COVERAGE-BASELINE.md")

const packages = listPackages()
const waves = chunk(packages, WAVE_SIZE)
const results: Array<TaskResult> = []
const startedAt = new Date().toISOString()

/** Pulls the vitest "All files" coverage row out of a task log. */
const coverageLine = (logPath: string): string => {
  if (!fs.existsSync(logPath)) return "no log"
  const text = fs.readFileSync(logPath, "utf8")
  const match = text.split("\n").filter((line) => line.includes("All files"))
  return match.length > 0 ? match[match.length - 1]!.trim() : "no coverage table (see log)"
}

const writeReport = (done: number) => {
  const lines = [
    "# Coverage baseline",
    "",
    `Started ${startedAt}. ${done}/${packages.length} packages measured, wave size ${WAVE_SIZE}.`,
    "Command per package: `pnpm --filter @smthrs/<pkg> exec vitest run --coverage`.",
    "",
    "| Package | Exit | All files (Stmts/Branch/Funcs/Lines) | Log |",
    "| --- | --- | --- | --- |",
    ...results.map((r) =>
      `| ${r.id} | ${r.exitCode} | ${coverageLine(r.logPath)} | ${path.relative(FLOWS_ROOT, r.logPath)} |`
    ),
    ""
  ]
  fs.mkdirSync(REPORTS_DIR, { recursive: true })
  fs.writeFileSync(reportPath, lines.join("\n"))
}

console.log(`coverage-baseline: ${packages.length} packages, ${waves.length} waves`)

for (let index = 0; index < waves.length; index++) {
  const wave = waves[index]!
  const WaveFlow = Flow.make(`factory/CoverageWave${index}`, {
    payload: { wave: Schema.Number },
    success: Schema.Record(Schema.String, Schema.Unknown),
    body: () =>
      Node.all(
        Object.fromEntries(
          wave.map((pkg) => [
            pkg,
            ShellTask.call({
              id: pkg,
              command: `pnpm --filter @smthrs/${pkg} exec vitest run --coverage`,
              cwd: FLOWS_ROOT,
              timeoutMs: TIMEOUT_MS,
              logDir
            })
          ])
        )
      )
  })
  console.log(`wave ${index + 1}/${waves.length}: ${wave.join(", ")}`)
  const waveResult = (await runFlow(
    WaveFlow,
    { wave: index },
    `coverage-w${index}-${startedAt.slice(0, 10)}`
  )) as Record<string, TaskResult>
  for (const pkg of wave) {
    const r = waveResult[pkg]!
    results.push(r)
    console.log(`  ${pkg}: exit ${r.exitCode}`)
  }
  writeReport(results.length)
}

console.log(`coverage-baseline done. Report: ${reportPath}`)
