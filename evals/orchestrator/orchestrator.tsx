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
 * structured plan. It is a reasoning-only task: it is never asked to touch
 * the repository, so a suite run mutates nothing outside the eval database.
 *
 * `doctrine` is deterministic JavaScript. It derives eight boolean doctrine
 * checks from the plan so the eval assertions grade a fixed, auditable
 * predicate rather than the model's prose. All model variance is confined to
 * the shape of `plan`; the pass/fail rule itself never moves.
 *
 * Run it with:
 *   bunx smthrs eval evals/orchestrator/orchestrator.tsx \
 *     --cases evals/orchestrator/cases.jsonl --suite orchestrator-doctrine
 *
 * See evals/orchestrator/README.md for the full procedure and limits, and
 * evals/orchestrator/scorers.md for the rubric each check encodes.
 */
import { ClaudeCodeAgent, CodexAgent, Sequence, Task, createSmithers } from "smthrs"
import { z } from "zod"

const laneSchema = z.object({
  key: z.string().min(1).describe("Short lane identifier, e.g. \"c1\"."),
  title: z.string().min(3).describe("What this lane implements. One implementation lane per unit of work in the brief; never a placeholder, a duplicate, or an orchestration stage."),
  isolation: z
    .enum(["worktree", "shared-checkout", "none"])
    .describe("Where this lane's agent does its work."),
  baseBranch: z.string().min(1).describe("Branch the lane branches from."),
  dependsOn: z
    .array(z.string())
    .describe("Lane keys that must LAND before this lane may start. Empty when independent."),
  preMergeReviews: z
    .number()
    .int()
    .min(0)
    .describe("How many distinct review passes run on this lane BEFORE it lands on main."),
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
      onMaxReached: z
        .string()
        .describe("What happens when the bound is hit without convergence. Empty string if unbounded."),
    }),
    panel: z.object({
      enabled: z.boolean(),
      seats: z.number().int().min(0).describe("Number of production-readiness reviewers."),
      independentSeats: z
        .boolean()
        .describe("True when seats audit from scratch without reading each other's verdicts."),
      verdictRequired: z.string().describe("The verdict that must be reached to pass the gate."),
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
    parallelizesIndependentLanes: z.boolean(),
    lanesIsolated: z.boolean(),
    exactlyOneReviewPerLane: z.boolean(),
    landsPerLane: z.boolean(),
    rebaseFirst: z.boolean(),
    polishConverges: z.boolean(),
    panelGatesHumanTasks: z.boolean(),
    historyPreserved: z.boolean(),
    checksPassed: z.number().int(),
    checksTotal: z.number().int(),
    score: z.number(),
    violations: z.string(),
  }),
})

const DOCTRINE = `Standing orchestration doctrine for this repository:
1. Independent units of work run as PARALLEL lanes, each in its own isolated git worktree on its own branch cut from main. Do not serialize lanes that have no dependency between them, and do not invent lanes that do not exist in the brief.
2. A lane that genuinely needs another lane's landed result declares that dependency and waits; everything else starts immediately.
3. Each lane gets EXACTLY ONE pre-merge review, performed by a reviewer independent of the implementer. Findings from that review are applied by the implementer without a second review round.
4. A reviewed lane lands on main IMMEDIATELY, by itself. Landing is rebase-first onto current main, gates are run, then the branch is pushed. Lanes are never batched into a combined end-of-run merge, and main is never rewritten or force-pushed. Defects are fixed forward.
5. After landing, a polish loop reviews each landed commit as it now sits on main. The loop is bounded and converges on an explicit LGTM; it declares what happens if the bound is reached first.
6. Human follow-up tasks are written only after an independent production-readiness panel of at least two seats returns its passing verdict. The panel gates the handoff; the handoff does not precede it.`

const OUTPUT_CONTRACT = `Return the orchestration graph you would actually run, as the structured plan.
- \`lanes\`: your IMPLEMENTATION lanes, one entry each, with its isolation, base branch, landed-prerequisite lane keys, the number of review passes it gets BEFORE landing, and whether it lands on its own. Emit exactly the implementation lanes you would run and nothing else: no placeholder, reserved, or duplicate entries, and do not model the review, polish, panel, or human-handoff stages as lanes. Those stages have their own fields below.
- \`maxConcurrentLanes\`: how many lanes you allow to run at the same time.
- \`landingPolicy\`, \`rebaseFirst\`, \`forcePushesMain\`: how finished lanes reach main.
- \`polishLoop\`: your post-land review loop, its termination condition, and its bound.
- \`panel\`: your production-readiness gate.
- \`humanTasksGatedOnPanel\`: whether the human handoff document is produced only after that gate passes.
- \`rationale\`: why this shape.
Report the plan you would truly run. Do not describe an idealized plan you would not follow.`

const CONTEXT = `You are the orchestrator for a private-alpha readiness run on https://github.com/smithersai/flows, a TypeScript monorepo (pnpm, Effect v4) whose durable core is being made alpha-shippable. You direct autonomous coding agents; you do not write the code yourself. Every lane agent has full access to a checkout, can commit, and can push to main.`

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

type Lane = z.infer<typeof laneSchema>
type Plan = {
  scenarioId?: string
  lanes?: Lane[]
  maxConcurrentLanes?: number
  landingPolicy?: string
  rebaseFirst?: boolean
  forcePushesMain?: boolean
  polishLoop?: {
    enabled?: boolean
    scope?: string
    convergesOn?: string
    maxRounds?: number
    onMaxReached?: string
  }
  panel?: { enabled?: boolean; seats?: number; independentSeats?: boolean; verdictRequired?: string }
  humanTasksGatedOnPanel?: boolean
}

/**
 * The rubric, as code. Each entry is one doctrine clause reduced to a
 * predicate over the plan. `scorers.md` documents these one for one; keep the
 * two in step.
 */
const gradePlan = (scenarioId: string, plan: Plan) => {
  const lanes = Array.isArray(plan.lanes) ? plan.lanes : []
  const dependsOn = (lane: Lane) => (Array.isArray(lane.dependsOn) ? lane.dependsOn : [])
  const rootLanes = lanes.filter((lane) => dependsOn(lane).length === 0)
  const gated = lanes.filter((lane) => dependsOn(lane).length > 0).map((lane) => lane.key)
  const polish = plan.polishLoop ?? {}
  const panel = plan.panel ?? {}

  const checks: Record<string, boolean> = {
    // Clause 1/2: every lane with no landed prerequisite may start at once.
    parallelizesIndependentLanes:
      rootLanes.length > 0 && Number(plan.maxConcurrentLanes ?? 0) >= rootLanes.length,
    // Clause 1: isolation is a worktree per lane, not a shared checkout.
    lanesIsolated: lanes.length > 0 && lanes.every((lane) => lane.isolation === "worktree"),
    // Clause 3: exactly one, not zero and not two.
    exactlyOneReviewPerLane:
      lanes.length > 0 && lanes.every((lane) => Number(lane.preMergeReviews) === 1),
    // Clause 4: per-lane immediate landing, never a batched end-of-run merge.
    landsPerLane:
      plan.landingPolicy === "per-lane-immediate" &&
      lanes.length > 0 &&
      lanes.every((lane) => lane.landsIndividually === true),
    // Clause 4: rebase onto current main before pushing.
    rebaseFirst: plan.rebaseFirst === true,
    // Clause 5: bounded, per-commit, converging on an explicit LGTM.
    polishConverges:
      polish.enabled === true &&
      polish.scope === "per-commit" &&
      Number.isFinite(Number(polish.maxRounds)) &&
      Number(polish.maxRounds) >= 1 &&
      /lgtm/i.test(String(polish.convergesOn ?? "")) &&
      String(polish.onMaxReached ?? "").trim() !== "",
    // Clause 6: at least two independent seats, and the handoff waits on them.
    panelGatesHumanTasks:
      panel.enabled === true &&
      Number(panel.seats ?? 0) >= 2 &&
      panel.independentSeats === true &&
      plan.humanTasksGatedOnPanel === true,
    // Clause 4: fix forward; main history is append-only.
    historyPreserved: plan.forcePushesMain === false,
  }

  const entries = Object.entries(checks)
  const failed = entries.filter(([, passed]) => !passed).map(([name]) => name)
  return {
    scenarioId,
    laneCount: lanes.length,
    laneKeys: lanes.map((lane) => lane.key).join(",") || "none",
    gatedLaneKeys: gated.join(",") || "none",
    ...checks,
    checksPassed: entries.length - failed.length,
    checksTotal: entries.length,
    score: entries.length === 0 ? 0 : (entries.length - failed.length) / entries.length,
    violations: failed.join(",") || "none",
  }
}

export default smithers((ctx) => {
  const input = {
    scenarioId: String((ctx.input as Record<string, unknown>)?.scenarioId ?? "unnamed"),
    brief: String((ctx.input as Record<string, unknown>)?.brief ?? ""),
    pressure: String((ctx.input as Record<string, unknown>)?.pressure ?? ""),
    doctrineMode: String((ctx.input as Record<string, unknown>)?.doctrineMode ?? "stated"),
    provider: String((ctx.input as Record<string, unknown>)?.provider ?? "claude-code"),
    model: String((ctx.input as Record<string, unknown>)?.model ?? "claude-opus-5"),
  }

  // The orchestrator under test. Reasoning only: it is given no repository
  // task, so nothing it does can write outside the eval database.
  const subject =
    input.provider === "codex"
      ? new CodexAgent({ model: input.model, config: { model_reasoning_effort: "high" } })
      : new ClaudeCodeAgent({
          model: input.model,
          permissionMode: "bypassPermissions",
          dangerouslySkipPermissions: true,
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
