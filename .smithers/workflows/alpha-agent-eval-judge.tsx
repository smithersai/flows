/** @jsxImportSource smthrs */
// alpha-agent-eval-judge: the workflow `smithers eval` runs once per case of
// the alpha-agent orchestrator eval suite (.smithers/evals/alpha-agent/).
//
// One case = one authored orchestrator trace plus its ground truth. The
// workflow grades the trace on the five axes of agent.PROMPT.md and never
// launches the alpha-agent workflow, an implementation lane, or any worker
// that touches the repo. Cost per case is one cheap claude-sonnet-5 call.
//
// Shape: deterministic checks (compute, no model) -> rubric judge (cheap
// agent, sees only the trace) -> verdict (compute, reconciles the two).
// The deterministic checks are authoritative for the axis verdicts; the
// rubric judge is measured against them through `agreement`, so the suite
// regresses on both the checker and the judge.
//
// Input compatibility: the shared run store's `input` table carries exactly
// one user column, `carriedFindings`. Every case therefore smuggles its
// payload through that column as a JSON string, parsed here.
import { homedir } from "node:os"
import { join } from "node:path"
import { ClaudeCodeAgent, createSmithers, Sequence, Task } from "smthrs"
import { z } from "zod"
import { AXES, parsePayload, scoreTrace, unscorable, type EvalPayload } from "../evals/alpha-agent/scoreTrace.ts"

const verdictEnum = z.enum(["PASS", "FAIL", "N/A"])

const axisFields = {
  parallelism: verdictEnum,
  singleReview: verdictEnum,
  immediateLanding: verdictEnum,
  polishConvergence: verdictEnum,
  humanGating: verdictEnum,
}

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({
    carriedFindings: z.string().default(""),
  }),
  alphaEvalJudgeChecks: z.object({
    caseId: z.string(),
    ...axisFields,
    overall: verdictEnum,
    violations: z.string(),
    stats: z.string(),
  }),
  alphaEvalJudgeRubric: z.object({
    caseId: z.string(),
    ...axisFields,
    score: z.number().min(0).max(1),
    reasoning: z.string().min(20),
  }),
  alphaEvalJudgeVerdict: z.object({
    caseId: z.string(),
    ...axisFields,
    overall: verdictEnum,
    /** The rubric judge's 0..1 score for the trace as a whole. */
    rubricScore: z.number().min(0).max(1),
    /** True when the rubric judge matched the deterministic checks on every decided axis. */
    agreement: z.boolean(),
    disagreements: z.string(),
    summary: z.string().min(10),
  }),
})

// ---------------------------------------------------------------------------
// Judge agent: cheapest tier, fixed account order so renders are reproducible.
// claude-1 is excluded (weekly quota exhausted as of 2026-08-16).
// ---------------------------------------------------------------------------
const HOME = homedir()
const JUDGE_ACCOUNTS = ["claude-2", "claude-3", "claude-4", "claude-5", "claude-6", "claude-7"] as const

// An explicit chain, not `fallbackAgents()`: the registry pool that helper
// builds is derived from every registered account and drops the model, which
// would let a judge case land on a codex or premium-tier agent. Every entry
// here is pinned to the cheap tier.
const judgeAgents = [
  ...JUDGE_ACCOUNTS.map(
    (label) =>
      new ClaudeCodeAgent({
        model: "claude-sonnet-5",
        configDir: join(HOME, ".smithers/accounts", label),
        id: `smithers-account:${label}`,
      }),
  ),
  new ClaudeCodeAgent({ model: "claude-sonnet-5" }),
]

const RUBRIC = `
RUBRIC — score an orchestrator that must follow this doctrine (agent.PROMPT.md):

1. parallelism — implementation lanes run CONCURRENTLY, one worktree each.
   PASS when at least three lanes (or all of them, when fewer exist) overlap in
   time. FAIL when lanes run one after another.
2. singleReview — EXACTLY ONE pre-merge review per lane, by a separate
   reviewer. FAIL on zero reviews before a landing, on a second pre-merge pass,
   or on a re-review after the lane already landed (that belongs to polish).
3. immediateLanding — a lane lands on main the moment it clears review;
   rebase-first, never batched. FAIL when a lane sits on a clean review while
   other lanes finish, or when a reviewed lane never lands. A gap over 30
   minutes between clearing review and landing is batching.
4. polishConvergence — every landed lane runs post-land polish loops that
   converge to an explicit LGTM, fixing forward. FAIL when a loop ends on FIX,
   when a landed lane is never polished, or when a FIX is never applied by a
   fix-forward task before the next polish review.
5. humanGating — human tasks are raised ONLY after both independent
   production-readiness verifiers report PRODUCTION-READY. FAIL when a human
   task precedes the panel, when a verifier said NOT-READY, or when fewer than
   two independent verifiers reported. Escalations after a failed panel
   (kind "escalation") are legitimate and never a violation.

Verdict per axis: PASS, FAIL, or "N/A" when the trace carries no evidence for
that axis at all. Judge only what the trace shows; do not assume unlogged work.
`

export default smithers((ctx) => {
  const carried = String((ctx.input as { carriedFindings?: string })?.carriedFindings ?? "")
  const parsed = parsePayload(carried)
  const payload: EvalPayload = parsed.ok ? parsed.payload : {}
  const caseId = payload.caseId ?? (parsed.ok ? "unknown" : "unparsed")
  const traceJson = JSON.stringify(payload.trace ?? { events: [] }, null, 2)

  const rubricPrompt = `You are grading ONE authored trace of a Smithers orchestrator run. This is a
fixture, not a live system: judge the trace exactly as written and never run
commands, read the repository, or launch other agents.

CASE ID: ${caseId}
${RUBRIC}
TRACE (JSON; tMin is minutes since the run started, "phase" is the node's role,
"lane" is the implementation lane, "verdict" carries review/panel outcomes):
${traceJson}

Return JSON only:
{
  "caseId": "${caseId}",
${AXES.map((axis) => `  "${axis}": "PASS" | "FAIL" | "N/A"`).join(",\n")},
  "score": <0..1, how well the whole trace follows the doctrine>,
  "reasoning": "<one sentence per axis you failed or marked N/A, citing tMin values>"
}`

  return (
    <Workflow name="alpha-agent-eval-judge">
      <Sequence>
        <Task id="deterministicChecks" output={outputs.alphaEvalJudgeChecks} retries={1}>
          {async () => (parsed.ok ? scoreTrace(parsed.payload) : unscorable(caseId, parsed.error))}
        </Task>
        {parsed.ok ? (
          <Sequence>
            <Task
              id="rubricJudge"
              agent={judgeAgents}
              output={outputs.alphaEvalJudgeRubric}
              retries={2}
              timeoutMs={10 * 60_000}
              heartbeatTimeoutMs={5 * 60_000}
            >
              {rubricPrompt}
            </Task>
            <Task
              id="reconcile"
              output={outputs.alphaEvalJudgeVerdict}
              retries={1}
              deps={{ deterministicChecks: outputs.alphaEvalJudgeChecks, rubricJudge: outputs.alphaEvalJudgeRubric }}
            >
              {async (resolved: {
                deterministicChecks: Record<string, string>
                rubricJudge: Record<string, string | number>
              }) => {
                // A deps key doubles as the node id it waits on, so the keys
                // are named after the upstream tasks.
                const deps = { checks: resolved.deterministicChecks, rubric: resolved.rubricJudge }
                // The deterministic checks decide the axes; the rubric judge is
                // scored against them so the suite tracks judge drift too.
                const disagreements = AXES.filter(
                  (axis) => deps.checks[axis] !== "N/A" && deps.rubric[axis] !== deps.checks[axis],
                ).map((axis) => `${axis}: checks=${deps.checks[axis]} rubric=${String(deps.rubric[axis])}`)
                const failed = AXES.filter((axis) => deps.checks[axis] === "FAIL")
                return {
                  caseId: deps.checks.caseId,
                  parallelism: deps.checks.parallelism,
                  singleReview: deps.checks.singleReview,
                  immediateLanding: deps.checks.immediateLanding,
                  polishConvergence: deps.checks.polishConvergence,
                  humanGating: deps.checks.humanGating,
                  overall: deps.checks.overall,
                  rubricScore: Number(deps.rubric.score ?? 0),
                  agreement: disagreements.length === 0,
                  disagreements: disagreements.length === 0 ? "none" : disagreements.join("; "),
                  summary:
                    failed.length === 0
                      ? `${deps.checks.caseId}: all decided axes hold; ${disagreements.length === 0 ? "the rubric judge agreed" : "the rubric judge disagreed"}.`
                      : `${deps.checks.caseId}: ${failed.join(", ")} violated. ${deps.checks.violations}`,
                }
              }}
            </Task>
          </Sequence>
        ) : null}
      </Sequence>
    </Workflow>
  )
})
