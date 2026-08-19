/**
 * Bun test coverage runs.
 *
 * @since 0.1.0
 */
import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
import * as BunTest from "./BunTest.ts"
import * as Exec from "./Exec.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"

/**
 * Coverage percentages a run must reach, mirroring the four vitest threshold
 * dimensions. lcov carries no statement records, so the statements gate
 * reuses the line counters.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Thresholds = Schema.Struct({
  lines: Schema.Number,
  functions: Schema.Number,
  branches: Schema.Number,
  statements: Schema.Number
})

/**
 * Coverage percentages a run must reach.
 *
 * @category models
 * @since 0.1.0
 */
export type Thresholds = typeof Thresholds.Type

/**
 * The named threshold profiles a workspace defines. A profile names where the
 * declared thresholds came from; the numbers themselves are always declared
 * explicitly, so the profile is documentation and key material, never a
 * lookup.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Profile = Schema.Literals(["critical", "library", "app", "default"])

/**
 * A named threshold profile.
 *
 * @category models
 * @since 0.1.0
 */
export type Profile = typeof Profile.Type

/**
 * Attributes for {@link BunTestCoverage}: the {@link BunTest} attributes plus
 * the coverage declaration.
 *
 * `coverageDir` stays a string because it declares an output path rather than
 * referencing a file the target reads. `thresholds` gates the run on the lcov
 * report. A package coverage does not support declares no thresholds and
 * carries `unsupportedReason` instead: every unsupported package names why,
 * so skipping it is a decision with a written rationale rather than an
 * omission. `unsupportedReason` is required when `thresholds` is omitted.
 *
 * Threshold enforcement reads the lcov report, so declaring `thresholds`
 * requires `coverageReporter` `"lcov"`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  ...BunTest.Attrs.fields,
  coverageDir: Schema.NonEmptyString,
  coverageReporter: Schema.Literals(["lcov", "text"]),
  thresholds: Schema.NullOr(Thresholds),
  profile: Schema.NullOr(Profile),
  unsupportedReason: Schema.NullOr(Schema.NonEmptyString)
}).check(
  BunTest.reporterRequiresOutfile,
  Schema.makeFilter(
    (attrs: { readonly thresholds: Thresholds | null; readonly unsupportedReason: string | null }) =>
      attrs.thresholds !== null || attrs.unsupportedReason !== null ||
      "unsupportedReason is required when thresholds are omitted: an unsupported package names why coverage does not gate it",
    { title: "unsupportedReasonRequired" }
  ),
  Schema.makeFilter(
    (attrs: { readonly thresholds: Thresholds | null; readonly coverageReporter: "lcov" | "text" }) =>
      attrs.thresholds === null || attrs.coverageReporter === "lcov" ||
      "threshold enforcement reads the lcov report, so thresholds require coverageReporter \"lcov\"",
    { title: "thresholdsRequireLcov" }
  )
)

/**
 * Attributes for {@link BunTestCoverage}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Result of one coverage run: the exec result plus the directory the run
 * wrote its coverage reports into, relative to `cwd`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CoverageReport = Schema.Struct({
  run: Exec.Result,
  coverageDir: Schema.NonEmptyString
})

/**
 * Result of one coverage run.
 *
 * @category models
 * @since 0.1.0
 */
export type CoverageReport = typeof CoverageReport.Type

/**
 * The inline bun program that gates a run on its lcov report.
 *
 * bun has no coverage threshold flags, so the gate is a second step: it sums
 * the lcov counters and exits 1 when a dimension is below its threshold. An
 * empty report measures as 100%, matching the aggregator behaviour this
 * replaces; a missing report fails the read. The program text is payload data,
 * so editing it re-keys every coverage target.
 */
const thresholdProgram = [
  "const fs = require(\"node:fs\")",
  "const [file, lines, functions, branches, statements] = process.argv.slice(1)",
  "const want = { lines: Number(lines), functions: Number(functions), branches: Number(branches), statements: Number(statements) }",
  "const found = { lines: 0, functions: 0, branches: 0 }",
  "const hit = { lines: 0, functions: 0, branches: 0 }",
  "for (const line of fs.readFileSync(file, \"utf8\").split(\"\\n\")) {",
  "  if (line.startsWith(\"LF:\")) found.lines += Number(line.slice(3))",
  "  else if (line.startsWith(\"LH:\")) hit.lines += Number(line.slice(3))",
  "  else if (line.startsWith(\"FNF:\")) found.functions += Number(line.slice(4))",
  "  else if (line.startsWith(\"FNH:\")) hit.functions += Number(line.slice(4))",
  "  else if (line.startsWith(\"BRF:\")) found.branches += Number(line.slice(4))",
  "  else if (line.startsWith(\"BRH:\")) hit.branches += Number(line.slice(4))",
  "}",
  "const percent = (hits, total) => (total === 0 ? 100 : (hits / total) * 100)",
  "// lcov carries no statement records, so the statements gate reuses the line counters.",
  "const got = {",
  "  lines: percent(hit.lines, found.lines),",
  "  functions: percent(hit.functions, found.functions),",
  "  branches: percent(hit.branches, found.branches),",
  "  statements: percent(hit.lines, found.lines)",
  "}",
  "const failed = Object.keys(want).filter((name) => got[name] < want[name])",
  "if (failed.length > 0) {",
  // process.stderr.write, not console.error: the repository's console guard
  // (packages/observability/test/NoConsole.test.ts) matches the call text
  // anywhere in a package source, including inside the string literals that
  // make up this generated script, and cannot tell one from a real call.
  "  process.stderr.write(\"coverage below threshold: \" + failed.map((name) => name + \" \" + got[name].toFixed(2) + \"% < \" + want[name] + \"%\").join(\", \") + \"\\n\")",
  "  process.exit(1)",
  "}"
].join("\n")

/**
 * Plans `bun test` with coverage, gating on the lcov report when thresholds
 * are declared.
 *
 * The body records one {@link Exec.Exec} node that runs `bun test --coverage`
 * from `cwd` with the declared reporter and coverage directory, and, when
 * `thresholds` is set, a second node that parses the written lcov report and
 * fails the target below any threshold. The success value carries
 * `coverageDir` so downstream targets can consume the written reports. Key
 * material contains everything {@link BunTest} keys on plus the coverage
 * directory, reporter, thresholds, profile, and unsupported reason. This
 * models the smithers workspace's per-package coverage lanes, where every
 * package either gates on a named profile with explicit numbers or carries a
 * written reason it does not. Executing the plan requires
 * {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const BunTestCoverage = Target.make("BunTestCoverage", {
  attrs: Attrs,
  kinds: ["test"],
  cache: true,
  success: CoverageReport,
  error: Exec.ExecError,
  implementation: (attrs) => {
    const manager = PackageManager.registeredToolchain().packageManager
    const run = Target.runTool({
      cwd: attrs.cwd,
      env: attrs.env,
      argv: PackageManager.exec(
        manager,
        BunTest.testArguments(attrs, [
          "--coverage",
          `--coverage-reporter=${attrs.coverageReporter}`,
          `--coverage-dir=${attrs.coverageDir}`
        ])
      )
    })
    const thresholds = attrs.thresholds
    if (thresholds === null) {
      return Node.all({
        run,
        coverageDir: Node.succeed(attrs.coverageDir)
      })
    }
    return Node.all({
      run: run.pipe(
        Node.andThen((completed) =>
          Target.runTool({
            cwd: attrs.cwd,
            env: attrs.env,
            argv: PackageManager.exec(manager, [
              "bun",
              "-e",
              thresholdProgram,
              `${attrs.coverageDir}/lcov.info`,
              String(thresholds.lines),
              String(thresholds.functions),
              String(thresholds.branches),
              String(thresholds.statements)
            ]),
            after: completed
          }).pipe(Node.map(() => completed))
        )
      ),
      coverageDir: Node.succeed(attrs.coverageDir)
    })
  }
})
