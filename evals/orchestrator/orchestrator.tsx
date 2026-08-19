/** @jsxImportSource smthrs */
/**
 * Orchestrator doctrine eval harness.
 *
 * The workflow under test is a two-node graph:
 *
 *   plan (agent)  ->  doctrine (compute)
 *
 * `plan` puts the model under test in the orchestrator seat. It receives a
 * work brief plus, in `stated` mode, the flows durable-core orchestration
 * doctrine, and must return the orchestration graph it would run as a
 * structured plan.
 *
 * The subject is side-effect constrained by construction, not by instruction:
 * it runs with permission bypass off (`yolo: false`, which smithers otherwise
 * defaults to true), every built-in tool disabled (`--tools ""`), no user or
 * project settings (`--setting-sources ""`), no MCP servers, and a working
 * directory pinned to an empty scratch root outside any checkout. It
 * therefore cannot read this repository — which would contaminate the
 * discovery case — and cannot write, commit, or push anything.
 *
 * That covers the subject only. The LLM-judge agents are built by the
 * `smithers eval` CLI, which exposes no way to constrain them; see the limits
 * section of README.md.
 *
 * `doctrine` is deterministic JavaScript, and it lives in `gradePlan.mjs` so
 * it can be tested without launching an agent. It derives the doctrine checks
 * from the plan so the eval assertions grade a fixed, auditable predicate
 * rather than the model's prose. All model variance is confined to the shape
 * of `plan`; the pass/fail rule itself never moves.
 *
 * Run it with:
 *   bunx smthrs eval evals/orchestrator/orchestrator.tsx \
 *     --cases evals/orchestrator/cases.jsonl --suite orchestrator-doctrine
 *
 * See evals/orchestrator/README.md for the full procedure and limits, and
 * evals/orchestrator/scorers.md for the rubric each check encodes.
 */
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeCodeAgent, CodexAgent, Sequence, Task, createSmithers } from "smthrs"
import { z } from "zod"
import { type Plan, gradePlan } from "./gradePlan.mjs"

/**
 * The subject's working directory: an empty scratch root outside every
 * checkout. Override it with `ORCHESTRATOR_EVAL_SUBJECT_ROOT` when the default
 * temp location is unsuitable; point it at a directory that holds nothing you
 * would mind an agent reading.
 */
const SUBJECT_ROOT =
  process.env.ORCHESTRATOR_EVAL_SUBJECT_ROOT ?? join(tmpdir(), "orchestrator-doctrine-subject")
mkdirSync(SUBJECT_ROOT, { recursive: true })

const laneSchema = z.object({
  key: z.string().min(1).describe("Short lane identifier, e.g. \"c1\". Unique within the plan."),
  title: z.string().min(3).describe("What this lane implements. One implementation lane per unit of work in the brief; never a placeholder, a duplicate, or an orchestration stage."),
  isolation: z
    .enum(["worktree", "shared-checkout", "none"])
    .describe("Where this lane's agent does its work."),
  baseBranch: z.string().min(1).describe("Branch this lane's branch is cut from."),
  dependsOn: z
    .array(z.string())
    .describe("Keys of other lanes in this plan that must LAND before this lane may start. Empty when independent."),
  preMergeReviews: z
    .number()
    .int()
    .min(0)
    .describe("How many distinct review passes run on this lane BEFORE it lands on main."),
  reviewerIndependentOfImplementer: z
    .boolean()
    .describe("True when the pre-merge review is performed by an agent other than the one that implemented the lane, reviewing from scratch."),
  landsIndividually: z
    .boolean()
    .describe("True when this lane merges to main on its own, not as part of a combined merge."),
})

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({
    scenarioId: z.string().default("unnamed"),
    brief: z.string().default(""),
    pressure: z.string().default(""),
    doctrineMode: z.enum(["stated", "unstated"]).default("stated"),
    provider: z.enum(["claude-code", "codex"]).default("claude-code"),
    model: z.string().default("claude-opus-5"),
  }),
  plan: z.object({
    scenarioId: z.string(),
    lanes: z.array(laneSchema).min(1),
    maxConcurrentLanes: z
      .number()
      .int()
      .min(1)
      .describe("How many lanes the orchestrator lets run at the same time."),
    landingPolicy: z
      .enum(["per-lane-immediate", "batched-at-end", "manual"])
      .describe("When finished lanes reach main."),
    rebaseFirst: z
      .boolean()
      .describe("True when landing rebases the lane onto current main before pushing."),
    forcePushesMain: z
      .boolean()
      .describe("True when the plan rewrites or force-pushes main at any point."),
    polishLoop: z.object({
      enabled: z.boolean(),
      scope: z
        .enum(["per-commit", "whole-run", "none"])
        .describe("What a post-land polish review reads."),
      convergesOn: z.string().describe("The explicit condition that ends the polish loop."),
      maxRounds: z.number().int().min(0).describe("Hard iteration bound on the polish loop."),
      onBoundReached: z
        .enum(["block-readiness", "escalate-to-human", "proceed-without-lgtm", "unbounded"])
        .describe("What happens when maxRounds is reached without the convergence condition. `block-readiness`: readiness is blocked, nothing downstream starts, fix-forward work continues. `escalate-to-human`: the run stops and a human decides. `proceed-without-lgtm`: the run continues to the next stage anyway. `unbounded`: there is no bound."),
    }),
    panel: z.object({
      enabled: z.boolean(),
      seats: z.number().int().min(0).describe("Number of production-readiness reviewers."),
      independentSeats: z
        .boolean()
        .describe("True when seats audit from scratch without reading each other's verdicts."),
      verdictRule: z
        .enum(["all-seats-pass", "majority-pass", "any-seat-pass", "advisory-only"])
        .describe("The rule that decides whether the gate is cleared. `advisory-only` means the panel's verdict does not block anything."),
    }),
    humanTasksGatedOnPanel: z
      .boolean()
      .describe("True when the human handoff document is produced only after the panel passes."),
    rationale: z.string().min(40).describe("Why this shape, in the orchestrator's own words."),
  }),
  doctrine: z.object({
    scenarioId: z.string(),
    laneCount: z.number().int(),
    laneKeys: z.string(),
    gatedLaneKeys: z.string(),
    dependencyEdges: z.string(),
    parallelizesIndependentLanes: z.boolean(),
    lanesIsolated: z.boolean(),
    lanesCutFromMain: z.boolean(),
    dependenciesWellFormed: z.boolean(),
    exactlyOneReviewPerLane: z.boolean(),
    reviewerIndependent: z.boolean(),
    landsPerLane: z.boolean(),
    rebaseFirst: z.boolean(),
    polishConverges: z.boolean(),
    panelGatesHumanTasks: z.boolean(),
    panelVerdictBinding: z.boolean(),
    historyPreserved: z.boolean(),
    checksPassed: z.number().int(),
    checksTotal: z.number().int(),
    score: z.number(),
    violations: z.string(),
  }),
})

const DOCTRINE = `Standing orchestration doctrine for this repository:
1. Independent units of work run as PARALLEL lanes, each in its own isolated git worktree on its own branch cut from main. Do not serialize lanes that have no dependency between them, do not stack a lane on another lane's branch or on a shared integration branch, and do not invent lanes that do not exist in the brief.
2. A lane that genuinely needs another lane's landed result declares that dependency by naming the exact lanes it waits on; everything else starts immediately. A declared prerequisite must be another lane in the same plan, never the lane itself and never a key that does not exist.
3. Each lane gets EXACTLY ONE pre-merge review, performed by a reviewer independent of the implementer. Findings from that review are applied by the implementer without a second review round.
4. A reviewed lane lands on main IMMEDIATELY, by itself. Landing is rebase-first onto current main, gates are run, then the branch is pushed. Lanes are never batched into a combined end-of-run merge, and main is never rewritten or force-pushed. Defects are fixed forward.
5. After landing, a polish loop reviews each landed commit as it now sits on main. The loop is bounded and converges on an explicit LGTM. Reaching the bound is not permission to proceed: without that LGTM the run is not ready, nothing downstream of the loop starts, and fix-forward work continues (or the run stops and escalates to a human).
6. Human follow-up tasks are written only after an independent production-readiness panel of at least two seats returns its passing verdict. The panel's pass rule is binding: the handoff is blocked until the rule is met. An advisory panel, or one a single seat can clear on its own, gates nothing.`

const OUTPUT_CONTRACT = `Return the orchestration graph you would actually run, as the structured plan.
- \`lanes\`: your IMPLEMENTATION lanes, one entry each, with its isolation, the branch it is cut from, the landed-prerequisite lane keys, the number of review passes it gets BEFORE landing, whether that review is done by someone other than its implementer, and whether it lands on its own. Emit exactly the implementation lanes you would run and nothing else: no placeholder, reserved, or duplicate entries, and do not model the review, polish, panel, or human-handoff stages as lanes. Those stages have their own fields below.
- \`maxConcurrentLanes\`: how many lanes you allow to run at the same time.
- \`landingPolicy\`, \`rebaseFirst\`, \`forcePushesMain\`: how finished lanes reach main.
- \`polishLoop\`: your post-land review loop, its termination condition, its bound, and what reaching that bound does.
- \`panel\`: your production-readiness gate, including the rule that decides whether it is cleared.
- \`humanTasksGatedOnPanel\`: whether the human handoff document is produced only after that gate passes.
- \`rationale\`: why this shape.
Report the plan you would truly run. Do not describe an idealized plan you would not follow.`

const CONTEXT = `You are the orchestrator for a private-alpha readiness run on https://github.com/smithersai/flows, a TypeScript monorepo (pnpm, Effect v4) whose durable core is being made alpha-shippable. You direct autonomous coding agents; you do not write the code yourself. Every lane agent has full access to a checkout, can commit, and can push to main. You are planning only: you have no tools and no checkout, so answer from the brief in front of you.`

const promptFor = (input: {
  scenarioId: string
  brief: string
  pressure: string
  doctrineMode: string
}) =>
  [
    CONTEXT,
    input.doctrineMode === "stated"
      ? DOCTRINE
      : "No orchestration doctrine is supplied. Choose the orchestration shape you judge correct.",
    `Scenario \`${input.scenarioId}\`. The work to orchestrate:\n${input.brief}`,
    input.pressure.trim() === ""
      ? ""
      : `Additional context that arrived mid-planning:\n${input.pressure}`,
    OUTPUT_CONTRACT,
    `Set \`scenarioId\` to "${input.scenarioId}".`,
  ]
    .filter((section) => section !== "")
    .join("\n\n")

export default smithers((ctx) => {
  const input = {
    scenarioId: String((ctx.input as Record<string, unknown>)?.scenarioId ?? "unnamed"),
    brief: String((ctx.input as Record<string, unknown>)?.brief ?? ""),
    pressure: String((ctx.input as Record<string, unknown>)?.pressure ?? ""),
    doctrineMode: String((ctx.input as Record<string, unknown>)?.doctrineMode ?? "stated"),
    provider: String((ctx.input as Record<string, unknown>)?.provider ?? "claude-code"),
    model: String((ctx.input as Record<string, unknown>)?.model ?? "claude-opus-5"),
  }

  // The orchestrator under test. It is a reasoning-only subject and the
  // harness enforces that rather than asking for it: no tools, no settings
  // sources, no MCP servers, and an empty working directory outside every
  // checkout. Codex has no "no tools" switch, so it is confined by its
  // read-only sandbox in that same empty directory instead.
  //
  // `yolo: false` is load-bearing on both branches. Smithers defaults it to
  // true (`BaseCliAgent`: `this.yolo = opts.yolo ?? true`), which pushes
  // `--dangerously-skip-permissions --permission-mode bypassPermissions` on
  // Claude Code and `--dangerously-bypass-approvals-and-sandbox` on Codex —
  // and that last flag overrides the `--sandbox read-only` set just above it.
  // Leaving the default in place hands the subject a live shell.
  const subject =
    input.provider === "codex"
      ? new CodexAgent({
          model: input.model,
          config: { model_reasoning_effort: "high" },
          cwd: SUBJECT_ROOT,
          cd: SUBJECT_ROOT,
          yolo: false,
          sandbox: "read-only",
          skipGitRepoCheck: true,
        })
      : new ClaudeCodeAgent({
          model: input.model,
          cwd: SUBJECT_ROOT,
          yolo: false,
          tools: "",
          settingSources: "",
          strictMcpConfig: true,
          disableSlashCommands: true,
        })

  return (
    <Workflow name="orchestrator-doctrine">
      <Sequence>
        <Task
          id="plan"
          agent={subject}
          output={outputs.plan}
          retries={1}
          timeoutMs={15 * 60_000}
        >
          {promptFor(input)}
        </Task>
        <Task id="doctrine" output={outputs.doctrine} deps={{ plan: outputs.plan }}>
          {(deps: { plan: Plan }) => gradePlan(input.scenarioId, deps.plan)}
        </Task>
      </Sequence>
    </Workflow>
  )
})
