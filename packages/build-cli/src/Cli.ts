/**
 * Incur command surface for smithers build.
 *
 * @since 0.1.0
 */
import { Cli, z } from "incur"
import * as NodePath from "node:path"
import * as Diagnostic from "./Diagnostic.ts"
import { runInstall } from "./engine.ts"
import * as Executor from "./Executor.ts"
import * as GraphOutput from "./GraphOutput.ts"
import * as Planner from "./Planner.ts"
import * as Query from "./Query.ts"
import {
  ensureGitignored,
  resolveConfig,
  type ResolvedRemoteCache,
  resolveRemoteCache,
  Workspace
} from "./Workspace.ts"

const workspaceOption = z.object({
  workspace: z.string().default(process.cwd()).describe("Workspace root containing BUILD.ts files"),
  cacheDir: z.string().optional().describe(
    "Workspace-relative cache directory; overrides the root BUILD.ts declaration and .flows"
  )
})

const executionOptions = workspaceOption.extend({
  plan: z.boolean().default(false).describe("Print the inert plan instead of executing"),
  jobs: z.number().int().min(1).optional().describe("Maximum concurrent targets; defaults to host parallelism"),
  cache: z.boolean().default(true).describe("Consult the result cache before running; --no-cache bypasses reads")
})

const runOptions = executionOptions.extend({
  name: z.string().optional().describe("Package name supplied to scaffold targets")
})

const executionAlias = { workspace: "w", jobs: "j" }

const patternArgument = z.object({
  pattern: z.string().describe("Bazel label or recursive pattern")
})

/** The flags every command shares. */
interface WorkspaceFlags {
  readonly workspace: string
  readonly cacheDir?: string | undefined
}

/** The flags shared by commands that execute targets. */
interface ExecutionFlags extends WorkspaceFlags {
  readonly plan: boolean
  readonly jobs?: number | undefined
  readonly cache: boolean
}

/**
 * Process-scoped configuration captured before BUILD.ts evaluation.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeConfig {
  readonly cacheUrl?: string | undefined
  readonly cacheToken?: string | undefined
  readonly signal?: AbortSignal | undefined
}

interface PreparedWorkspace {
  readonly root: string
  readonly cacheDirectory: string
  readonly remoteCache?: (ResolvedRemoteCache & { readonly token?: string | undefined }) | undefined
}

/**
 * Settles the cache directory one command runs under. Executing commands apply
 * the declared gitignore policy before writing state; query, graph, and plan
 * commands pass `writeState = false` and remain observational.
 *
 * Reading the declared token from the environment is a read, never a write.
 * Removing the name from `process.env` here would mutate state the caller
 * owns: `makeCli` is a library entry point, and two concurrent commands with
 * different declared token names would delete each other's credentials. The
 * child-process boundary is where the credential is withheld, and `ExecLive`
 * already strips both `SMITHERS_CACHE_URL` and every name in `sensitiveEnv`
 * from a spawned tool's environment. The process entry point in `main.ts`
 * captures and clears the default names for its own short-lived process,
 * which is a choice only a process owner may make.
 */
const prepare = async (
  flags: WorkspaceFlags,
  runtime: RuntimeConfig = {},
  writeState = true
): Promise<PreparedWorkspace> => {
  runtime.signal?.throwIfAborted()
  const root = NodePath.resolve(flags.workspace)
  const config = await resolveConfig(root, flags.cacheDir)
  runtime.signal?.throwIfAborted()
  const remoteCache = await resolveRemoteCache(root, runtime.cacheUrl)
  let preparedRemote: PreparedWorkspace["remoteCache"]
  if (remoteCache !== undefined) {
    const token = remoteCache.tokenEnv === "SMITHERS_CACHE_TOKEN"
      ? runtime.cacheToken ?? process.env[remoteCache.tokenEnv]
      : process.env[remoteCache.tokenEnv]
    preparedRemote = { ...remoteCache, token }
  }
  if (writeState && config.gitignored) await ensureGitignored(root, config.cacheDirectory)
  runtime.signal?.throwIfAborted()
  return preparedRemote === undefined
    ? { root, cacheDirectory: config.cacheDirectory }
    : { root, cacheDirectory: config.cacheDirectory, remoteCache: preparedRemote }
}

/** Opens the workspace index under the resolved cache directory. */
const openWorkspace = async (
  flags: WorkspaceFlags,
  runtime: RuntimeConfig = {},
  writeState = true
): Promise<{ readonly workspace: Workspace; readonly remoteCache: PreparedWorkspace["remoteCache"] }> => {
  const prepared = await prepare(flags, runtime, writeState)
  return {
    workspace: await Workspace.make(prepared.root, process.cwd(), {
      cacheDirectory: prepared.cacheDirectory,
      signal: runtime.signal
    }),
    remoteCache: prepared.remoteCache
  }
}

/** The plan printed by `ci --plan`: all CI verb plans merged over one pattern. */
interface CiPlan extends Executor.MergedPlan {
  readonly verb: "ci"
  readonly pattern: string
}

/** Plans one verb and executes it unless `--plan` asked for the inert print. */
const runVerb = async (
  verb: "build" | "test" | "lint" | "run" | "docs",
  pattern: string,
  flags: ExecutionFlags,
  config: RuntimeConfig
): Promise<Planner.Plan | Executor.Summary> => {
  const { remoteCache, workspace } = await openWorkspace(flags, config, !flags.plan)
  const plan = await Planner.make(workspace, verb, pattern)
  if (flags.plan) return plan
  return Executor.execute({
    workspace,
    verb,
    pattern,
    targets: plan.targets,
    jobs: flags.jobs,
    readCache: flags.cache,
    remoteCache,
    signal: config.signal,
    packageName: "name" in flags && typeof flags.name === "string" ? flags.name : undefined
  })
}

/**
 * The verbs `ci` merges, LINT FIRST.
 *
 * `mergePlans` deduplicates on label and first occurrence wins, so the plan a
 * target contributes to `ci` is the one from the first verb that selected it.
 * A generator target participates in both `build` and `lint`, and its `lint`
 * form is the non-mutating one (`attrsForKind` maps write to check). Planning
 * `build` first therefore made `smthrs ci` rewrite checked-in package
 * manifests and workflow files as a side effect of asking whether the
 * repository was green. Lint first makes the merged graph the checking form,
 * which is the only correct posture for a CI verb.
 */
const ciKinds = ["lint", "build", "test", "docs"] as const

/** Plans every CI-safe verb over one pattern and executes the merged graph. */
const runCi = async (
  pattern: string,
  flags: ExecutionFlags,
  config: RuntimeConfig
): Promise<CiPlan | Executor.Summary> => {
  const { remoteCache, workspace } = await openWorkspace(flags, config, !flags.plan)
  const plans: Array<Planner.Plan> = []
  const refusals: Array<unknown> = []
  for (const kind of ciKinds) {
    try {
      plans.push(await Planner.make(workspace, kind, pattern))
    } catch (cause) {
      // An exact label that does not participate in one of the CI kinds is
      // fine as long as it participates in another; any other planning error
      // is real and propagates.
      if (cause instanceof Planner.UnsupportedVerbError && cause.verb === kind) refusals.push(cause)
      else throw cause
    }
  }
  if (plans.length === 0) throw refusals[0] ?? new Error(`no targets selected by ${pattern}`)
  const merged = Executor.mergePlans(plans)
  if (flags.plan) return { verb: "ci", pattern, ...merged }
  return Executor.execute({
    workspace,
    verb: "ci",
    pattern,
    targets: merged.targets,
    jobs: flags.jobs,
    readCache: flags.cache,
    remoteCache,
    signal: config.signal
  })
}

/** Whether an outcome is an execution summary rather than an inert plan. */
const failedSummary = (
  outcome: Planner.Plan | CiPlan | Executor.Summary
): outcome is Executor.Summary => "ok" in outcome && !outcome.ok

const failureMessage = (summary: Executor.Summary): string =>
  `${summary.counts.failed} of ${summary.results.length} targets failed` +
  (summary.counts.skipped === 0 ? "" : ` (${summary.counts.skipped} skipped)`)

/**
 * Creates the configured smthrs CLI.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeCli = (config: RuntimeConfig = {}) =>
  Cli.create("smthrs", {
    description: "Execute BUILD.ts targets and install pnpm workspaces with flows",
    version: "0.1.0"
  })
    .command("install", {
      description: "Plan and execute the pnpm install Flow",
      options: workspaceOption,
      alias: { workspace: "w" },
      async run(context) {
        try {
          const prepared = await prepare(context.options, config)
          return await runInstall(prepared.root, {
            cacheDirectory: prepared.cacheDirectory,
            sensitiveEnvironment: prepared.remoteCache === undefined
              ? []
              : [prepared.remoteCache.tokenEnv],
            signal: config.signal
          })
        } catch (cause) {
          return context.error({
            code: "install_failed",
            exitCode: 1,
            message: Diagnostic.message(cause),
            retryable: false
          })
        }
      }
    })
    .command("build", {
      description: "Execute the build targets selected by a pattern",
      args: patternArgument,
      options: executionOptions,
      alias: executionAlias,
      async run(context) {
        let outcome: Planner.Plan | Executor.Summary
        try {
          outcome = await runVerb("build", context.args.pattern, context.options, config)
        } catch (cause) {
          return context.error({ code: "build_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
        if (failedSummary(outcome)) {
          return context.error({
            code: "targets_failed",
            exitCode: 1,
            message: failureMessage(outcome),
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("test", {
      description: "Execute the test targets selected by a pattern",
      args: patternArgument,
      options: executionOptions,
      alias: executionAlias,
      async run(context) {
        let outcome: Planner.Plan | Executor.Summary
        try {
          outcome = await runVerb("test", context.args.pattern, context.options, config)
        } catch (cause) {
          return context.error({ code: "test_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
        if (failedSummary(outcome)) {
          return context.error({
            code: "targets_failed",
            exitCode: 1,
            message: failureMessage(outcome),
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("lint", {
      description: "Execute the lint targets selected by a pattern",
      args: patternArgument,
      options: executionOptions,
      alias: executionAlias,
      async run(context) {
        let outcome: Planner.Plan | Executor.Summary
        try {
          outcome = await runVerb("lint", context.args.pattern, context.options, config)
        } catch (cause) {
          return context.error({ code: "lint_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
        if (failedSummary(outcome)) {
          return context.error({
            code: "targets_failed",
            exitCode: 1,
            message: failureMessage(outcome),
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("docs", {
      description: "Execute the documentation-parity targets selected by a pattern",
      args: patternArgument,
      options: executionOptions,
      alias: executionAlias,
      async run(context) {
        let outcome: Planner.Plan | Executor.Summary
        try {
          outcome = await runVerb("docs", context.args.pattern, context.options, config)
        } catch (cause) {
          return context.error({ code: "docs_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
        if (failedSummary(outcome)) {
          return context.error({
            code: "targets_failed",
            exitCode: 1,
            message: failureMessage(outcome),
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("run", {
      description: "Execute run targets selected by a pattern",
      args: patternArgument,
      options: runOptions,
      alias: { ...executionAlias, name: "n" },
      async run(context) {
        let outcome: Planner.Plan | Executor.Summary
        try {
          outcome = await runVerb("run", context.args.pattern, context.options, config)
        } catch (cause) {
          return context.error({ code: "run_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
        if (failedSummary(outcome)) {
          return context.error({
            code: "targets_failed",
            exitCode: 1,
            message: failureMessage(outcome),
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("ci", {
      description: "Execute build, test, lint, and documentation targets over one merged graph",
      args: patternArgument,
      options: executionOptions,
      alias: executionAlias,
      async run(context) {
        let outcome: CiPlan | Executor.Summary
        try {
          outcome = await runCi(context.args.pattern, context.options, config)
        } catch (cause) {
          return context.error({ code: "ci_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
        if (failedSummary(outcome)) {
          return context.error({
            code: "targets_failed",
            exitCode: 1,
            message: failureMessage(outcome),
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("query", {
      description: "List labels or evaluate deps(label)",
      args: z.object({ expr: z.string().describe("Label, pattern, or deps(label)") }),
      options: workspaceOption,
      alias: { workspace: "w" },
      async run(context) {
        try {
          const { workspace } = await openWorkspace(context.options, config, false)
          return await Query.run(workspace, context.args.expr)
        } catch (cause) {
          return context.error({ code: "query_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
      }
    })
    .command("graph", {
      description: "Print the target graph without executing it",
      args: patternArgument,
      options: workspaceOption.extend({
        mermaid: z.boolean().default(false).describe("Render Mermaid instead of a text tree")
      }),
      alias: { workspace: "w", mermaid: "m" },
      async run(context) {
        try {
          const { workspace } = await openWorkspace(context.options, config, false)
          const plan = await Planner.make(workspace, "graph", context.args.pattern)
          return {
            pattern: context.args.pattern,
            format: context.options.mermaid ? "mermaid" : "text",
            graph: context.options.mermaid ? GraphOutput.mermaid(plan) : GraphOutput.text(plan),
            roots: plan.roots,
            targets: plan.targets.map((target) => ({ label: target.label, target: target.target })),
            edges: plan.edges,
            warnings: plan.warnings
          }
        } catch (cause) {
          return context.error({ code: "graph_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
      }
    })

/**
 * Programmatic CLI without process-scoped remote cache or interruption state.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cli = makeCli()
