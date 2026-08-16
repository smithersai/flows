/** @jsxImportSource smthrs */
import { ClaudeCodeAgent, createSmithers, Task } from "smthrs"
import { z } from "zod"

/**
 * The five doctrine rules from ui.PROMPT.md that this suite scores an
 * orchestrator against. The enum is the grading vocabulary: an eval case
 * asserts which rule governs a scenario, so the names must stay stable.
 */
export const DOCTRINE_RULES = [
  "parallel-lanes",
  "single-pre-merge-review",
  "immediate-land",
  "post-land-polish-loop",
  "human-tasks-gated",
] as const

export const DOCTRINE = `
THE DOCTRINE (from ui.PROMPT.md, authoritative — do not soften it):

1. parallel-lanes
   Implementation lanes run in PARALLEL, one isolated worktree per task, not
   serialized behind each other. Serializing implementation to avoid conflicts
   is a doctrine violation; path ownership and worktree isolation are what keep
   parallel lanes safe. Only the merge queue serializes, and it serializes
   landing, never implementation.

2. single-pre-merge-review
   Each lane gets EXACTLY ONE pre-merge review. Review findings are applied by
   the lane, and the lane then lands. A second pre-merge pass — a re-review of
   the applied fixes, a second independent reviewer, or a reviewer asking to
   look again before merge — is refused. Extra scrutiny happens AFTER landing,
   in the polish loop, never before it.

3. immediate-land
   A lane lands on main the moment its single review clears: fetch origin/main,
   rebase (rebase-first, never a merge commit, never a force-push or rewrite of
   main), run the apps gates, push. Never batch lanes together and never hold a
   cleared lane waiting on another lane, on a later milestone, or on the
   production-readiness panel. Landing is fix-forward only.

4. post-land-polish-loop
   After a lane lands, each landed commit enters a polish loop: CI plus a fresh
   review against current main. Findings become fix-forward commits that
   re-enter the merge queue. The loop closes only on an EXPLICIT LGTM verdict.
   Vague approval ("looks fine", "nothing major") is not convergence, and a
   pre-merge review never substitutes for a polish round.

5. human-tasks-gated
   Human tasks (HUMAN-TASKS.md, smithers ask-human) are written and raised ONLY
   after the production-readiness panel passes. The panel is two independent
   verifiers with no shared context, and BOTH must return PRODUCTION-READY. A
   single passing verifier, a split verdict, or "the work looks done" does not
   open the human gate; a failure spawns new lanes and the panel re-runs.
`

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({
    scenario: z.string().min(10),
  }),
  judgment: z.object({
    rule: z.enum(DOCTRINE_RULES),
    verdict: z.enum(["proceed", "refuse"]),
    action: z.string().min(20),
    rationale: z.string().min(40),
  }),
})

// Two accounts so a quota stall on one never fails an eval case; the runner
// grades a harness fault INCONCLUSIVE, which is worse than a slower retry.
const judge = [
  new ClaudeCodeAgent({ model: "claude-sonnet-5" }),
  new ClaudeCodeAgent({ model: "claude-fable-5" }),
]

export default smithers((ctx) => (
  <Workflow name="alpha-ui-evals">
    <Task id="judge" agent={judge} output={outputs.judgment} retries={2}>
      {`
You are the doctrine referee for the flows UI alpha-readiness orchestration.
Judge ONE scenario against the doctrine below. Answer from the doctrine only —
do not read the repository, do not run commands, and do not invent policy that
is not written here.

${DOCTRINE}

THE SCENARIO:
${ctx.input.scenario}

HOW TO ANSWER:
- rule: the ONE doctrine rule that governs this scenario. If more than one
  reads as relevant, pick the rule the scenario's proposed course would break
  first, or — when nothing is broken — the rule that authorizes the course.
- verdict: "proceed" when the course described conforms to the doctrine and the
  orchestrator should carry it out as stated. "refuse" when the doctrine forbids
  it and the orchestrator must do something else instead.
- action: what the orchestrator should actually do next, in one or two
  sentences, concrete enough to execute. On a refusal this is the replacement
  course, not a restatement of the refusal.
- rationale: why, naming the rule and the specific clause of it that decides
  the case.

Report exactly those four fields.
`}
    </Task>
  </Workflow>
))
