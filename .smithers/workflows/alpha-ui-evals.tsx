/** @jsxImportSource smthrs */
import { homedir } from "node:os"
import path from "node:path"
import { ClaudeCodeAgent, CodexAgent, KimiAgent, createSmithers, Task } from "smthrs"
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

const claudeSeat = (n: number, model: string) =>
  new ClaudeCodeAgent({
    model,
    configDir: path.join(homedir(), `.smithers/accounts/claude-${n}`),
    id: `smithers-account:claude-${n}`,
  })

// The judge failover chain, ordered primary-first then ACROSS providers as
// ui.PROMPT.md requires. Two claude seats would not be a fallback: an
// account-level quota stall or a claude-wide incident takes both rungs down in
// the same window, and the runner grades every case INCONCLUSIVE. Each rung
// here is pinned to its own registered account and the providers alternate, so
// one provider's outage costs a retry instead of the suite.
const judge = [
  claudeSeat(2, "claude-sonnet-5"),
  new CodexAgent({
    model: "gpt-5.6-sol",
    configDir: path.join(homedir(), ".smithers/accounts/codex-2"),
    id: "smithers-account:codex-2",
    skipGitRepoCheck: true,
  }),
  new KimiAgent({
    model: "kimi-k2.7-code",
    configDir: path.join(homedir(), ".smithers/accounts/kimi-1"),
    id: "smithers-account:kimi-1",
  }),
  claudeSeat(3, "claude-fable-5"),
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
