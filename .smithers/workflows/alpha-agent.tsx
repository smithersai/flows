/** @jsxImportSource smthrs */
// alpha-agent: flows agent-layer production readiness (agent.PROMPT.md track).
// Phases: parallel implement -> one review per lane -> merge queue (land on
// main immediately) -> per-commit polish loops -> evals lane -> production
// readiness panel -> human tasks behind the panel.
import { homedir } from "node:os"
import { join } from "node:path"
import { ClaudeCodeAgent, CodexAgent, createSmithers, HumanTask, Loop, MergeQueue, Parallel, Sequence, Task, UI, Worktree } from "smthrs"
import { z } from "zod"

const laneKeyEnum = z.enum(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "evals", "remediate"])

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({
    carriedFindings: z.string().default(""),
  }),
  alphaImpl: z.object({
    laneKey: laneKeyEnum,
    summary: z.string().min(40),
    alreadyLandedOnMain: z.boolean(),
    commitsOnBranch: z.string().min(2),
    gatesRun: z.string().min(10),
    gatesGreen: z.boolean(),
    blocked: z.string().min(2),
  }),
  alphaReview: z.object({
    laneKey: laneKeyEnum,
    verdict: z.enum(["APPROVE", "FIX"]),
    findings: z.string().min(2),
    dodAssessment: z.string().min(20),
  }),
  alphaCorrection: z.object({
    laneKey: laneKeyEnum,
    summary: z.string().min(20),
    addressed: z.string().min(2),
    commitTip: z.string().min(7),
  }),
  alphaLand: z.object({
    laneKey: laneKeyEnum,
    landed: z.boolean(),
    landedShas: z.string().min(2),
    gatesRun: z.string().min(10),
    gatesGreen: z.boolean(),
    notes: z.string().min(2),
  }),
  alphaPolish: z.object({
    laneKey: laneKeyEnum,
    verdict: z.enum(["LGTM", "FIX"]),
    ciStatus: z.string().min(2),
    findings: z.string().min(2),
  }),
  alphaFix: z.object({
    laneKey: laneKeyEnum,
    summary: z.string().min(20),
    landedShas: z.string().min(2),
    blocked: z.string().min(2),
  }),
  alphaEvals: z.object({
    suitePath: z.string().min(5),
    caseCount: z.number().int(),
    baselineSummary: z.string().min(40),
    committed: z.boolean(),
    blocked: z.string().min(2),
  }),
  alphaPanel: z.object({
    verifier: z.enum(["codex", "fable"]),
    verdict: z.enum(["PRODUCTION-READY", "NOT-READY"]),
    findings: z.string().min(2),
    evidence: z.string().min(40),
  }),
  alphaPrep: z.object({
    humanTasksPath: z.string().min(5),
    summary: z.string().min(40),
    committed: z.boolean(),
  }),
  alphaHuman: z.object({
    decisions: z.string().min(1),
  }),
})

// ---------------------------------------------------------------------------
// Agents. Load-balanced pools: every pool call gets a freshly shuffled chain
// across the registered Claude Max subscriptions, so parallel lanes start on
// different accounts and the engine's quota failover walks the rest.
// claude-1 is excluded (weekly quota 100% as of 2026-08-16); codex-2 is
// excluded (token rejected 401); codex-1 is the live Codex account.
// ---------------------------------------------------------------------------
const HOME = homedir()
// claude-1 (weekly 100%), claude-2 (org_level_disabled) and claude-5
// (out_of_credits) are quota-dead as of 2026-08-16T21:00Z and were removed:
// a dead rung costs a whole retry before the chain advances.
const CLAUDE_ACCOUNTS = ["claude-3", "claude-4", "claude-6", "claude-7"] as const

function shuffled<T>(items: readonly T[]): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

const claudePool = (model: string): ClaudeCodeAgent[] =>
  shuffled(CLAUDE_ACCOUNTS).map(
    (label) =>
      new ClaudeCodeAgent({
        model,
        configDir: join(HOME, ".smithers/accounts", label),
        id: `smithers-account:${label}`,
      }),
  )

// Lanes need network (pnpm install) and the parent repo's .git metadata
// outside the worktree cwd, so workspace-write is not enough for codex.
const codexFull = (model: string, effort: string): CodexAgent =>
  new CodexAgent({
    model,
    config: { model_reasoning_effort: effort },
    configDir: join(HOME, ".codex"),
    sandbox: "danger-full-access",
    skipGitRepoCheck: true,
    id: "smithers-account:codex-1",
  })

// codex-1 (pro, 0% weekly) is the only account with real headroom, so every
// pool leads with several distinct codex seats before falling back to the
// surviving Claude subscriptions and an ambient-auth opus tail.
const codexSeats = (lead: string, leadEffort: string) => [
  codexFull(lead, leadEffort),
  codexFull("gpt-5.6-terra", "medium"),
  codexFull("gpt-5.6-luna", "medium"),
]
const implPool = () => [...codexSeats("gpt-5.6-sol", "high"), ...claudePool("claude-fable-5"), new ClaudeCodeAgent({ model: "claude-opus-5" })]
const reviewPool = () => [...codexSeats("gpt-5.6-sol", "xhigh"), ...claudePool("claude-fable-5"), new ClaudeCodeAgent({ model: "claude-opus-5" })]
const landPool = () => [...codexSeats("gpt-5.6-terra", "medium"), ...claudePool("claude-sonnet-5"), new ClaudeCodeAgent({ model: "claude-opus-5" })]
const opusPool = () => [
  ...claudePool("claude-opus-5"),
  new ClaudeCodeAgent({ model: "claude-opus-5" }),
  ...codexSeats("gpt-5.6-sol", "high"),
]
const fablePool = () => [
  ...claudePool("claude-fable-5"),
  new ClaudeCodeAgent({ model: "claude-fable-5" }),
  ...codexSeats("gpt-5.6-sol", "xhigh"),
]

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------
const REPO = "/Users/williamcory/flows1"
const WT_ROOT = `${REPO}/.smithers/workflows/.worktrees`
const AUDIT = "/Users/williamcory/Desktop/flows-alpha-readiness-2026-08-16/core-agent-delta.md"
const TRACK_PROMPT = `${REPO}/agent.PROMPT.md`

const AGENT_GROUP_PACKAGES =
  "control, cli, harness, engine-harness, model, std, memory, registry, notifications, patterns, plugin, observability, evals, scorers, triggers, gateway, core"

const RULES = `
GROUND RULES (read fully before any tool call):
- You work in an isolated git worktree of ${REPO} (origin: github.com/smithersai/flows).
  Read CLAUDE.md and AGENTS.md at the worktree root first and follow them exactly.
- WORKTREE PREFLIGHT, before anything else: run "git status --porcelain". If any
  TRACKED file differs from HEAD before you have done work, the checkout is
  stale: repair with "git reset --hard HEAD" (preserves untracked files), then
  confirm "git diff --name-only HEAD" is empty. If a previous attempt left
  commits or untracked work here, CONTINUE from it: check
  "git log --oneline -5" and "git status" before assuming a fresh start.
- FETCH-FIRST CHECK, before implementing: run "git fetch origin" and inspect
  fresh origin/main ("git log --oneline origin/main -25" plus grep of the code
  sites your task names). The agent-prod-readiness fleet and two sibling tracks
  push to the same origin and may have landed part of your task (their wave-1
  built composition-root and trust-boundary work on apr/* branches). If your
  task is already landed, switch to VERIFYING its Definition of done: close the
  gaps (missing tests, missing docs), never rebuild what exists. If your branch
  base is behind origin/main, rebase your worktree branch onto origin/main
  before starting.
- PATH OWNERSHIP: you may edit ONLY the agent-group packages
  (${AGENT_GROUP_PACKAGES})
  under packages/, plus the docs pages your task names. Check the manifest:
  every packages/*/package.json declares "smthrs": { "group": ... }; you may
  only edit packages whose group is "agent". NEVER edit engine-group package
  internals (flows, engine, journal, run-store, sync, time-travel, database,
  kernel, and the rest) or anything under apps/**. Adding a test that CONSUMES
  an engine-group export (e.g. @smthrs/flows-next/NodeRuntime) from an
  agent-group package is fine and encouraged where the task asks for it.
- This tree is pnpm. Use pnpm only, never npm or yarn. Run "pnpm install" at
  the worktree root before building or testing. Effect v4 idioms throughout;
  follow the effect-repo conventions the repo already uses.
- Commit style: match git log (emoji conventional commits). Stage with explicit
  file paths only; never "git add -A", "git add .", or "git commit -a".
- Never rewrite or force-push main. Never checkout, move, or merge the main
  branch ref inside the worktree. Commit only on the worktree's own branch.
- Every behaviour change ships with tests in the owning package.
- Never modify: .smithers/ (except the evals lane's designated files),
  smithers.db*, ${TRACK_PROMPT}.
- The full audit backing your task is at ${AUDIT} (read-only reference).
`

const LAND_PROTOCOL = `
LAND PROTOCOL (rebase-first, fix-forward, never force):
1. cd into the lane worktree (path given above). git fetch origin.
2. Rebase the worktree branch onto origin/main: "git rebase origin/main".
   Resolve conflicts preserving BOTH intents (other lanes and sibling tracks
   land continuously; their work is normal, never revert it).
3. Gates, in the worktree, after "pnpm install":
   - For every package you touched: run its own "check", "test", and "lint"
     scripts (cd packages/<dir> && pnpm run check && pnpm test && pnpm run lint,
     honoring whatever scripts exist).
   - Then root "pnpm run check" (workspace-wide types) must pass.
   Fix anything red that your diff caused. If a failure is inherited from main
   (fails identically on a clean origin/main checkout of the same file set),
   note it and do not block on it.
4. Push to main: "git push origin HEAD:main" (NO --force, ever). If the push is
   rejected because main moved: fetch, rebase, re-run the touched packages'
   tests, push again. Up to 4 attempts.
5. Verify deterministically: "git fetch origin && git merge-base --is-ancestor
   HEAD origin/main && echo LANDED". Only report landed=true if that prints
   LANDED. Report the exact commit shas you landed.
`

// Per-lane task specs from agent.PROMPT.md (evidence paths + Definition of done).
type LaneSpec = {
  key: "a1" | "a2" | "a3" | "a4" | "a5" | "a6" | "a7"
  title: string
  spec: string
  dod: string
  implMinutes: number
}

const LANES: LaneSpec[] = [
  {
    key: "a1",
    title: "A1 production composition root",
    implMinutes: 240,
    spec: `Build the production composition root: a real ControlExecutor that launches a
flows-engine body running CellHarness.run, composed over
@smthrs/flows-next/NodeRuntime, wired into NodeControl so "flows run" executes
end to end. Today ControlExecutor.makeNoop (packages/control/src/ControlExecutor.ts:62-70)
is the only implementation and runs journal-then-pend-forever;
ControlLive.ts:106,323 treats the executor as optional. The engine-side
NodeRuntime already landed on main (packages/flows/src/NodeRuntime.ts, commit
de6bd2a7) but has ZERO callers and ZERO tests (audit F1): consume it, do not
edit it. Wire the real executor as the default in the production composition
(NodeControl), keeping makeNoop for tests. Audit refs: P0-1, F1, C1.`,
    dod: `Integration test with a RecordedModel proving: a 2-frame loop, a sandboxed
tool call, approval park -> approve -> resume, and a steer round-trip, green in
CI. The test lives in an agent-group package and also closes F1 by being a real
consumer of @smthrs/flows-next/NodeRuntime.`,
  },
  {
    key: "a2",
    title: "A2 trust posture",
    implMinutes: 180,
    spec: `Ship the alpha trust posture: (a) one bearer-token ControlAuth authenticator
server-side (the only turnkey authenticator today is layerNoopAuth,
ControlRpcs.ts:226-236); (b) wire the inert CLI --credential flag (Command.ts:21)
into ControlClient request headers (ControlClient.ts currently sends no
credential); (c) NodeControl binds 127.0.0.1 by default and refuses non-loopback
binds without an explicit --listen opt-in (NodeControl.ts:264-272 serves noop
auth by default); (d) enforce or delete the never-raised NotOwner error
("grep 'new NotOwner'" is empty); (e) document the posture on a docs page.
Audit refs: P0-2, F3.`,
    dod: `An authenticated remote run passes a test; an unauthenticated non-loopback
request is refused by a test; the docs page describing the posture exists.`,
  },
  {
    key: "a3",
    title: "A3 sandbox ceilings default-on",
    implMinutes: 150,
    spec: `Make execution-safety ceilings default-on: memory/step/time limits in the cell
loop become defaults the caller may RAISE but not omit. Today
packages/harness/src/QuickJSSandbox.ts:137-143 applies limits only when the
caller passes them; unlimited is the default. Also downgrade the "hermetic
Bash" documentation claim to match the lexical pre-check reality. Audit ref: P0-4.`,
    dod: `Defaults enforced with tests (omitting limits still gets ceilings; callers can
raise them explicitly); docs claims match the implementation.`,
  },
  {
    key: "a4",
    title: "A4 D11/plugin reconciliation",
    implMinutes: 90,
    spec: `docs/architecture/design-decisions.md:71-79 says @smthrs/plugin "was deleted
rather than wired"; the package exists at HEAD and engine-harness depends on it
(packages/engine-harness/src/CellPlugin.ts, CellHarness.ts). Amend the decision
record to bless the plugin package as the cell-loop extension point (or trim
it), and trim engineHooks to the hooks the cell harness actually dispatches.
Audit refs: Dec-1, F2.`,
    dod: `The decision record and the tree agree; the unused hook catalog is trimmed or
wired, with the choice recorded in the decision doc.`,
  },
  {
    key: "a5",
    title: "A5 CLI honesty",
    implMinutes: 150,
    spec: `Make the CLI honest: report the real package version (packages/cli/src/bin.ts:15
hardcodes "0.0.0" while packages/cli/package.json is 0.1.0); remove or wire
every inert flag (--credential is being wired by lane A2 concurrently, so
coordinate: if A2's change is already on origin/main when you land, rebase over
it and do not remove that flag); non-follow "flows logs" invocations terminate
instead of hanging; malformed JSON input exits as a usage error. Audit ref: P1-3e.`,
    dod: `"flows --version" reports the package version; no inert flags remain; tests
cover version output, log termination, and the malformed-JSON usage error.`,
  },
  {
    key: "a6",
    title: "A6 supervision honesty",
    implMinutes: 90,
    spec: `Supervision honesty: packages/gateway/src/SuperviseRuntime.ts:129-143 is
makeNoop/layerNoop only, so abandoned runs are never auto-resumed. For alpha,
documentation suffices: document that abandoned runs are not auto-resumed, OR
wire the engine's existing sweep into the gateway if that is genuinely small.
Update the alpha notes. Audit ref: P1-2.`,
    dod: `The documentation (or the wiring) is landed; the alpha notes state the
supervision posture. If no alpha-notes page exists yet, create one under docs/
and note that lane A7 also appends to it (the merge queue rebase resolves the
overlap).`,
  },
  {
    key: "a7",
    title: "A7 harness pin triage",
    implMinutes: 120,
    spec: `Triage the 1 remaining "it.fails" pin in packages/harness (audit F4 counts 29
repo-wide; exactly one lives in packages/harness). Either fix the underlying
defect so the pin becomes a passing test, or reclassify it as a known
limitation with a written rationale in the alpha notes. Audit ref: F4.`,
    dod: `The pin is resolved (test passes) or ledgered (alpha notes carry the
rationale); either way packages/harness tests are green.`,
  },
]

const ALL_LAND_KEYS = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "evals"] as const

// Per-lane agent pools, one fresh shuffle each so parallel lanes start on
// different Claude accounts.
const laneAgents = Object.fromEntries(
  LANES.map((lane) => [
    lane.key,
    {
      impl: implPool(),
      review: reviewPool(),
      land: landPool(),
      polishReview: reviewPool(),
      polishFix: implPool(),
    },
  ]),
) as Record<string, { impl: CodexAgent[] | (CodexAgent | ClaudeCodeAgent)[]; review: (CodexAgent | ClaudeCodeAgent)[]; land: (CodexAgent | ClaudeCodeAgent)[]; polishReview: (CodexAgent | ClaudeCodeAgent)[]; polishFix: (CodexAgent | ClaudeCodeAgent)[] }>
const evalsAgents = {
  impl: opusPool(),
  land: landPool(),
  polishReview: reviewPool(),
  polishFix: opusPool(),
}
const panelAgents = {
  codex: [codexFull("gpt-5.6-sol", "xhigh"), ...claudePool("claude-fable-5")],
  fable: fablePool(),
  remediate: implPool(),
  prep: fablePool(),
}

export default smithers((ctx) => {
  // Defensive readers: rows may arrive snake_cased, 0/1 for booleans, or
  // wrapped in a .row envelope depending on the read path.
  const unwrap = (r: any): any => (r && typeof r === "object" && r.row && typeof r.row === "object" ? r.row : r)
  const col = (r: any, camel: string): any => {
    const row = unwrap(r)
    if (!row) return undefined
    const snake = camel.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase())
    return row[camel] ?? row[snake]
  }
  const truthy = (v: any): boolean => v === true || v === 1 || v === "1" || v === "true"
  const scanLatest = (table: any, key: string, nodeIdPrefix: string): any => {
    const arr: any[] = Array.isArray(table) ? table : table ? [table] : []
    const matches = arr.filter((r) => {
      const lk = col(r, "laneKey")
      if (lk !== undefined) return lk === key
      const nid = col(r, "nodeId")
      return typeof nid === "string" && nid.startsWith(nodeIdPrefix)
    })
    return matches.length > 0 ? matches[matches.length - 1] : undefined
  }
  const maybe = (table: any, nodeId: string): any => {
    try {
      const viaCtx = (ctx as any).outputMaybe?.(table, { nodeId })
      if (viaCtx !== undefined) return viaCtx
    } catch {
      // fall through to the array scan
    }
    return undefined
  }
  const latest = (table: any, nodeId: string): any => {
    try {
      const viaCtx = (ctx as any).latest?.(table, nodeId)
      if (viaCtx !== undefined) return viaCtx
    } catch {
      // fall through to the array scan
    }
    return undefined
  }

  const implRow = (k: string) => maybe(outputs.alphaImpl, `${k}Impl`) ?? scanLatest((ctx.outputs as any)?.alphaImpl, k, `${k}Impl`)
  const reviewRow = (k: string) => maybe(outputs.alphaReview, `${k}Review`) ?? scanLatest((ctx.outputs as any)?.alphaReview, k, `${k}Review`)
  const landRow = (k: string) => maybe(outputs.alphaLand, `${k}Land`) ?? scanLatest((ctx.outputs as any)?.alphaLand, k, `${k}Land`)
  const evalsRow = () => maybe(outputs.alphaEvals, "evalsAuthor") ?? ((ctx.outputs as any)?.alphaEvals?.length ? (ctx.outputs as any).alphaEvals.at(-1) : undefined)
  const polishRow = (k: string) => latest(outputs.alphaPolish, `${k}PolishReview`) ?? scanLatest((ctx.outputs as any)?.alphaPolish, k, `${k}PolishReview`)
  const panelRow = (verifier: "codex" | "fable") => {
    const nodeId = verifier === "codex" ? "panelCodex" : "panelFable"
    const viaLatest = latest(outputs.alphaPanel, nodeId)
    if (viaLatest !== undefined) return viaLatest
    const arr: any[] = (ctx.outputs as any)?.alphaPanel ?? []
    const matches = (Array.isArray(arr) ? arr : [arr]).filter((r) => col(r, "verifier") === verifier)
    return matches.length > 0 ? matches[matches.length - 1] : undefined
  }

  // A land node that FINISHES while reporting landed=false has not landed: it
  // lost a push race. Keep it queued until it reports a verified landing, or
  // the lane strands silently and the run proceeds as if it shipped.
  const landVerified = (k: string) => truthy(col(landRow(k), "landed"))
  const reviewApproved = (k: string) => col(reviewRow(k), "verdict") === "APPROVE"
  const laneReadyToLand = (k: string) => reviewApproved(k) && !landVerified(k)
  // Polish mounts on any land ATTEMPT, not on the landed flag, so a lane whose
  // reporting row is wrong still gets its post-land review.
  const landAttempted = (k: string) => landRow(k) !== undefined
  const polishApproved = (k: string) => col(polishRow(k), "verdict") === "LGTM"
  const needsPolishFix = (k: string) => col(polishRow(k), "verdict") === "FIX"
  const panelPassed = () =>
    col(panelRow("codex"), "verdict") === "PRODUCTION-READY" && col(panelRow("fable"), "verdict") === "PRODUCTION-READY"
  // Judge the panel only once BOTH verifiers have reported. A half-reported
  // panel is incomplete, not failed; treating it as failed mounts a
  // remediation lane against findings that do not exist yet.
  const panelHasFailure = () => {
    const codex = panelRow("codex")
    const fable = panelRow("fable")
    if (codex === undefined || fable === undefined) return false
    return !panelPassed()
  }

  const carried = (ctx.input as any)?.carriedFindings ?? ""

  const wtPath = (k: string) => `${WT_ROOT}/alpha-${k}`

  const implPrompt = (lane: LaneSpec) => `
You are implementing ONE LANE of the flows agent-layer production-readiness
track. Work only this lane; other lanes run in parallel in their own worktrees.

LANE: ${lane.title}
WORKTREE: ${wtPath(lane.key)} (branch alpha/${lane.key}, based on main)
TIMEBOX: aim to finish within ${lane.implMinutes} minutes. Land correct and
complete work over gold-plating; polish happens post-land in a later phase.

TASK:
${lane.spec}

DEFINITION OF DONE:
${lane.dod}
${RULES}
WHAT TO DO:
1. Preflight and fetch-first check (above). If the fleet already landed part of
   this task, pivot to verifying the Definition of done and closing gaps.
2. Implement in this worktree. Commit incrementally on branch alpha/${lane.key}
   with explicit pathspecs and emoji conventional-commit messages.
3. Run the owning packages' check/test/lint scripts and make them green.
4. Do NOT push anywhere. A later merge-queue step rebases and lands this branch
   on main after review.
${carried ? `\nFindings carried from a previous run, fix these first:\n${carried}\n` : ""}
Report: laneKey exactly "${lane.key}"; summary (what you shipped, key files);
alreadyLandedOnMain (true only if you found the task already landed and
verified instead of building); commitsOnBranch (shas + one-line subjects);
gatesRun (the exact commands you ran); gatesGreen (true only if every gate you
ran passed, never assumed); blocked ("none" if nothing blocks).
`

  const reviewPrompt = (lane: LaneSpec) => `
You are the SINGLE pre-merge reviewer for one lane of the flows agent-layer
production-readiness track. This is the only review before the lane lands on
main, so be thorough AND decisive; there is no second pre-merge pass. Post-land
polish loops and a production-readiness panel run later, so do not block on
nits; block on real defects.

LANE UNDER REVIEW: ${lane.title}
WORKTREE: ${wtPath(lane.key)} (branch alpha/${lane.key})
IMPLEMENTER'S REPORT: ${JSON.stringify(unwrap(implRow(lane.key)) ?? "(pending)")}

THE TASK THE LANE HAD TO COMPLETE:
${lane.spec}

DEFINITION OF DONE (audit each item concretely):
${lane.dod}
${RULES}
HOW TO REVIEW:
1. cd ${wtPath(lane.key)}. Preflight per the rules. Review the branch diff:
   "git fetch origin && git diff origin/main...HEAD" (three dots).
2. Verify the Definition of done by RUNNING the evidence: run the new tests,
   run the touched packages' gates, read the changed docs. Never accept the
   implementer's claims without executing them.
3. Check ownership (only agent-group packages + named docs pages touched),
   Effect v4 idioms, repo conventions, test adequacy, and commit hygiene.
4. verdict APPROVE only if the DoD is genuinely met and nothing blocking
   remains. verdict FIX otherwise, with numbered, concrete, actionable
   findings (file:line, defect, required change) that the landing step will
   apply. Do not restate style preferences as blockers.

Report: laneKey exactly "${lane.key}"; verdict; findings ("none" when
approving); dodAssessment (item-by-item DoD verdict with the evidence you ran).
`

  const landPrompt = (lane: LaneSpec) => `
You are the MERGE-QUEUE landing step for one lane. Land this lane on main NOW;
never batch, never wait for other lanes.

LANE: ${lane.title}
WORKTREE: ${wtPath(lane.key)} (branch alpha/${lane.key})
REVIEW VERDICT: ${col(reviewRow(lane.key), "verdict") ?? "(pending)"}
REVIEW FINDINGS TO APPLY FIRST:
${col(reviewRow(lane.key), "findings") ?? "(pending)"}
${RULES}
WHAT TO DO:
1. cd ${wtPath(lane.key)}. Preflight per the rules.
2. If the review verdict is FIX, apply every finding as additional commits on
   the branch (explicit pathspecs, emoji conventional commits). If APPROVE with
   findings "none", proceed directly.
${LAND_PROTOCOL}
Report: laneKey exactly "${lane.key}"; landed; landedShas (exact shas now on
origin/main, or "none"); gatesRun (exact commands); gatesGreen; notes (what
you applied from review, conflicts resolved, or why landing failed).
`

  const correctionPrompt = (lane: LaneSpec) => `
You are the PRE-LAND correction step for lane ${lane.key} (${lane.title}). The
review verdict was FIX, so this lane is not authorized to land. Apply every
numbered finding in the lane worktree, commit the corrections, and do not push.
A fresh review runs after you finish.

${RULES}

REVIEW FINDINGS:
${String(col(reviewRow(lane.key), "findings") ?? "(missing review findings)")}

Report laneKey exactly "${lane.key}", summary, addressed, and commitTip.
`

  const polishReviewPrompt = (k: string, title: string) => `
You are a POST-LAND polish reviewer with fresh eyes (no prior context on this
lane). Review what the "${title}" lane landed on main and drive it to explicit
LGTM quality.

LANE WORKTREE (for running commands): ${wtPath(k)}
LANE LAND REPORT: ${JSON.stringify(unwrap(landRow(k)) ?? "(pending)")}

WHAT TO DO:
1. cd ${wtPath(k)}; git fetch origin. Verify the reported landed shas are
   really ancestors of origin/main ("git merge-base --is-ancestor <sha>
   origin/main"). A lie here is an automatic FIX with a finding.
2. Check CI for the landing commits: "gh run list --branch main --limit 10"
   and, if available, "gh run list --commit <sha>". Report what CI actually
   says in ciStatus (e.g. "ci.yml green for <sha>", "still running", "no CI
   triggered"). A red CI caused by this lane's commits is an automatic FIX.
3. Review the landed commits against CURRENT origin/main
   ("git show <sha>" / "git diff <sha>~1..<sha>"): correctness, Definition of
   done adherence, Effect v4 and repo conventions, test adequacy, doc honesty.
4. verdict LGTM only when the landed work needs nothing further. verdict FIX
   otherwise with numbered, concrete findings (file:line, defect, required
   change). Do not re-open findings a previous polish round already fixed
   properly; check the fix history first.

Report: laneKey exactly "${k}"; verdict; ciStatus; findings ("none" for LGTM).
`

  const polishFixPrompt = (k: string, title: string) => `
You are the FIX-FORWARD step for post-land polish of the "${title}" lane.
Apply the polish findings below as new commits and land them on main
(fix-forward; never rewrite what already landed).

LANE WORKTREE: ${wtPath(k)}
POLISH FINDINGS TO APPLY:
${col(polishRow(k), "findings") ?? "(pending)"}
${RULES}
WHAT TO DO:
1. cd ${wtPath(k)}. Preflight. git fetch origin && git rebase origin/main.
2. Apply every finding as new commits with tests where behaviour changed.
${LAND_PROTOCOL}
Report: laneKey exactly "${k}"; summary (what you fixed); landedShas (exact
shas now on origin/main, or "none"); blocked ("none" if nothing blocks).
`

  const evalsPrompt = `
You are the EVALS LANE of the flows agent-layer production-readiness track,
running in parallel with the implementation lanes.

WORKTREE: ${wtPath("evals")} (branch alpha/evals, based on main)
TIMEBOX: aim to finish within 120 minutes.

GOAL: author a Smithers eval suite (runnable with "smithers eval") that scores
an ORCHESTRATOR following the track prompt at ${TRACK_PROMPT} (read it first;
it is also readable at that absolute path from inside this worktree). The suite
scores orchestrator behaviour on five axes:
1. parallelism (implementation lanes actually run concurrently),
2. exactly one pre-merge review per lane,
3. immediate landing (each lane lands the moment it clears review; no batching),
4. converging post-land polish loops (fix-forward to explicit LGTM),
5. human tasks gated behind the production-readiness panel.

SHAPE (hard requirements):
- Deliverables live in this worktree under .smithers/evals/alpha-agent/:
  cases as JSONL fixtures, a README explaining the suite, and a small judge
  workflow at .smithers/workflows/alpha-agent-eval-judge.tsx that "smithers
  eval" runs over the cases. Add a graph-shape test for the judge workflow at
  .smithers/tests/alpha-agent-eval-judge.test.tsx using renderWorkflow from
  "smthrs/testing".
- Fixture-driven, cheap, and non-recursive: cases are authored orchestrator
  transcripts/traces (good and violating examples you write), judged by a
  cheap agent (claude-sonnet-5) with an llmJudge-style rubric plus
  deterministic checks. The eval must NEVER launch the alpha-agent workflow
  itself, any implementation fleet, or any codex/claude worker doing real
  repo work.
- CRITICAL COMPATIBILITY CONSTRAINT: this workspace's shared run store already
  has an "input" table with exactly one user column, carriedFindings (TEXT).
  The judge workflow's input schema MUST be exactly
  z.object({ carriedFindings: z.string().default("") }) and each eval case
  passes its payload as a JSON string in carriedFindings, parsed inside the
  workflow. Any other input column will break the engine at start. Also
  prefix the judge workflow's createSmithers output-table keys with
  "alphaEvalJudge" so they collide with nothing.
- Baseline: run the suite once ("smithers eval .smithers/workflows/alpha-agent-eval-judge.tsx
  --cases .smithers/evals/alpha-agent/cases.jsonl") and commit the resulting
  report as .smithers/evals/alpha-agent/baseline-report.md (or the tool's
  native report format). If the eval CLI cannot run in this environment,
  say so honestly in blocked and commit the suite anyway.
${RULES}
EXTRA SCOPE NOTE: your deliverables are the ONE exception to the ".smithers is
off-limits" rule, but ONLY the paths named above. Commit on branch alpha/evals
with explicit pathspecs; do NOT push (the merge queue lands your branch).

Report: suitePath; caseCount (number of cases); baselineSummary (scores per
axis, or why the baseline could not run); committed (true only if your commits
exist on branch alpha/evals); blocked ("none" if nothing blocks).
`

  const evalsLandPrompt = `
You are the MERGE-QUEUE landing step for the evals lane.

WORKTREE: ${wtPath("evals")} (branch alpha/evals)
EVALS REPORT: ${JSON.stringify(unwrap(evalsRow()) ?? "(pending)")}
${RULES}
${LAND_PROTOCOL}
The gates for this lane: the judge workflow's registered test
(cd .smithers && bun test ./tests/alpha-agent-eval-judge.test.tsx, exit code is
the signal) and "smithers graph .smithers/workflows/alpha-agent-eval-judge.tsx"
exiting 0. Root pnpm gates are not required for .smithers-only changes.

Report: laneKey exactly "evals"; landed; landedShas; gatesRun; gatesGreen;
notes.
`

  const dodTable = LANES.map((l) => `- ${l.title}: ${l.dod.replace(/\n/g, " ")}`).join("\n")

  const panelPrompt = (verifier: "codex" | "fable") => `
You are ONE OF TWO INDEPENDENT production-readiness verifiers for the flows
agent-layer track. You have no knowledge of the other verifier; do not look
for their output. Audit CURRENT origin/main against the Definitions of done
and the alpha bar, then render a verdict. Be adversarial: your job is to find
what is NOT ready.

WORKTREE: ${wtPath(`panel-${verifier}`)} (yours alone).
SETUP: cd there, "git fetch origin && git reset --hard origin/main &&
git clean -fd && pnpm install".

DEFINITIONS OF DONE (all seven must hold, with evidence you ran yourself):
${dodTable}
- Evals lane: a committed Smithers eval suite under .smithers/evals/alpha-agent/
  with a baseline report.

THE ALPHA BAR (from the audit at ${AUDIT}, which you should read): a private
localhost alpha is acceptable ONLY if the trust posture is documented; the
composition root must be proven end to end by an executed test, not by
exports; sandbox ceilings must be on by default; docs must not overclaim
(hermetic Bash, supervision, D11/plugin). The release-rehearsal item (C4) is
OUT of this track's scope; do not fail the verdict on it.

METHOD: for each DoD item, run the evidence (execute the integration test, run
the auth refusal tests, run the sandbox ceiling tests, read the docs pages,
check "flows --version"). Record command + observed result. A claim you could
not verify by running it counts as NOT met.

VERDICT DISCIPLINE: verdict PRODUCTION-READY only if EVERY item above holds
with executed evidence. Otherwise NOT-READY with numbered, priority-ordered,
concrete findings (file:line, defect, required change) that a remediation lane
will apply verbatim.

Report: verifier exactly "${verifier}"; verdict; findings ("none" when ready);
evidence (the commands you ran and what they printed, compressed).
`

  const remediatePrompt = () => `
You are the REMEDIATION LANE after a failed production-readiness panel. Fix
every finding below and land the fixes on main, fix-forward.

WORKTREE: ${wtPath("remediate")} (branch alpha/remediate)
PANEL FINDINGS (codex verifier):
${col(panelRow("codex"), "findings") ?? "(none reported)"}
PANEL FINDINGS (fable verifier):
${col(panelRow("fable"), "findings") ?? "(none reported)"}
${RULES}
WHAT TO DO:
1. Preflight; git fetch origin && git rebase origin/main (or reset the branch
   onto origin/main if it has no unlanded commits).
2. Fix every finding, with tests where behaviour changed. If a finding is
   factually wrong, refute it in your report notes instead of "fixing" it, and
   say exactly why.
${LAND_PROTOCOL}
Report: laneKey exactly "remediate"; landed; landedShas; gatesRun; gatesGreen;
notes (per-finding disposition: fixed with sha, or refuted with reason).
`

  const humanPrepPrompt = `
The production-readiness panel has passed (both independent verifiers said
PRODUCTION-READY). Prepare the human handoff.

PANEL EVIDENCE (codex): ${JSON.stringify(unwrap(panelRow("codex")) ?? "(missing)")}
PANEL EVIDENCE (fable): ${JSON.stringify(unwrap(panelRow("fable")) ?? "(missing)")}

WHAT TO DO:
1. Work in ${wtPath("remediate")} (reuse it): preflight, git fetch origin,
   reset branch to origin/main.
2. Write HUMAN-TASKS.md at the repo root with exactly three items, each with
   concrete evidence links (files, commits on main, test names):
   - H1: Ratify the trust posture A2 shipped (bearer token + loopback default)
     or direct a change.
   - H2: Rule on D11/plugin if A4's reconciliation needs an owner decision
     (state plainly whether it does).
   - H3: Final verification that "flows run" end-to-end (composition root,
     auth, sandboxed tools, approvals) is alpha-shippable, with the exact
     commands a human can run to see it.
3. Commit it ("📝 docs: add the alpha handoff human tasks", explicit pathspec)
   and land on main per the land protocol: fetch, rebase, push origin
   HEAD:main, no force, verify ancestry.

Report: humanTasksPath; summary (the state of the track in five sentences,
naming what landed for each lane); committed (true only if the file is on
origin/main).
`

  const humanGatePrompt = `Flows agent-layer track: the production-readiness panel PASSED (independent codex gpt-5.6-sol and claude fable verifiers both said PRODUCTION-READY). HUMAN-TASKS.md is committed on main at the repo root of ${REPO}. Please decide:
H1: Ratify the shipped trust posture (bearer token + loopback default) or direct a change.
H2: Rule on the D11/plugin reconciliation if it needs an owner decision (see HUMAN-TASKS.md).
H3: Confirm "flows run" end-to-end is alpha-shippable (commands to verify are in HUMAN-TASKS.md).
Respond with a JSON object: {"decisions": "<your H1/H2/H3 decisions>"}.`

  const humanEscalatePrompt = `Flows agent-layer track: the production-readiness panel did NOT pass after ${3} rounds (or remediation could not converge). Latest verifier findings:
codex: ${String(col(panelRow("codex"), "findings") ?? "(missing)").slice(0, 2000)}
fable: ${String(col(panelRow("fable"), "findings") ?? "(missing)").slice(0, 2000)}
Landed work remains on main (fix-forward track). Please direct the next step. Respond with a JSON object: {"decisions": "<direction>"}.`

  return (
    <Workflow name="alpha-agent">
      <UI entry="../ui/alpha-agent.tsx" />
      <Sequence>
        <Parallel>
          {/* Phase 1+2: parallel implement, one pre-merge review per lane. */}
          <Parallel maxConcurrency={8}>
            {LANES.map((lane) => (
              <Worktree
                key={lane.key}
                id={`${lane.key}Wt`}
                path={`${WT_ROOT}/alpha-${lane.key}`}
                branch={`alpha/${lane.key}`}
                baseBranch="main"
              >
                <Sequence>
                  <Task
                    id={`${lane.key}Impl`}
                    agent={laneAgents[lane.key].impl}
                    output={outputs.alphaImpl}
                    retries={8}
                    timeoutMs={lane.implMinutes * 60_000}
                    heartbeatTimeoutMs={40 * 60_000}
                  >
                    {implPrompt(lane)}
                  </Task>
                  <Loop id={`${lane.key}ReviewLoop`} until={reviewApproved(lane.key)} maxIterations={4} onMaxReached="fail">
                    <Sequence>
                      <Task
                        id={`${lane.key}Review`}
                        agent={laneAgents[lane.key].review}
                        output={outputs.alphaReview}
                        retries={8}
                        timeoutMs={60 * 60_000}
                        heartbeatTimeoutMs={20 * 60_000}
                      >
                        {reviewPrompt(lane)}
                      </Task>
                      {col(reviewRow(lane.key), "verdict") === "FIX" ? (
                        <Task
                          id={`${lane.key}Correction`}
                          agent={laneAgents[lane.key].impl}
                          output={outputs.alphaCorrection}
                          retries={8}
                          timeoutMs={lane.implMinutes * 60_000}
                          heartbeatTimeoutMs={40 * 60_000}
                        >
                          {correctionPrompt(lane)}
                        </Task>
                      ) : null}
                    </Sequence>
                  </Loop>
                </Sequence>
              </Worktree>
            ))}
            {/* Phase 5: evals lane, parallel with implementation. */}
            <Worktree id="evalsWt" path={`${WT_ROOT}/alpha-evals`} branch="alpha/evals" baseBranch="main">
              <Task
                id="evalsAuthor"
                agent={evalsAgents.impl}
                output={outputs.alphaEvals}
                retries={8}
                timeoutMs={120 * 60_000}
                heartbeatTimeoutMs={20 * 60_000}
              >
                {evalsPrompt}
              </Task>
            </Worktree>
          </Parallel>

          {/* Phase 3: merge queue. A lane lands only after APPROVE. */}
          <MergeQueue id="alphaMergeQueue" maxConcurrency={3}>
            {LANES.filter((lane) => laneReadyToLand(lane.key)).map((lane) => (
              <Task
                key={lane.key}
                id={`${lane.key}Land`}
                agent={laneAgents[lane.key].land}
                output={outputs.alphaLand}
                retries={8}
                timeoutMs={75 * 60_000}
                heartbeatTimeoutMs={15 * 60_000}
              >
                {landPrompt(lane)}
              </Task>
            ))}
            {evalsRow() !== undefined ? (
              <Task
                id="evalsLand"
                agent={evalsAgents.land}
                output={outputs.alphaLand}
                retries={8}
                timeoutMs={60 * 60_000}
                heartbeatTimeoutMs={15 * 60_000}
              >
                {evalsLandPrompt}
              </Task>
            ) : null}
          </MergeQueue>

          {/* Phase 4: per-commit polish loops, fix-forward to explicit LGTM. */}
          {ALL_LAND_KEYS.filter((k) => landAttempted(k)).map((k) => {
            const title = k === "evals" ? "evals suite" : LANES.find((l) => l.key === k)?.title ?? k
            const agentsFor = k === "evals" ? evalsAgents : laneAgents[k]
            return (
              <Loop key={k} id={`${k}PolishLoop`} until={polishApproved(k)} maxIterations={4} onMaxReached="return-last">
                <Sequence>
                  <Task
                    id={`${k}PolishReview`}
                    agent={agentsFor.polishReview}
                    output={outputs.alphaPolish}
                    retries={8}
                    timeoutMs={45 * 60_000}
                    heartbeatTimeoutMs={15 * 60_000}
                  >
                    {polishReviewPrompt(k, title)}
                  </Task>
                  {needsPolishFix(k) ? (
                    <Task
                      id={`${k}PolishFix`}
                      agent={agentsFor.polishFix}
                      output={outputs.alphaFix}
                      retries={8}
                      timeoutMs={90 * 60_000}
                      heartbeatTimeoutMs={30 * 60_000}
                    >
                      {polishFixPrompt(k, title)}
                    </Task>
                  ) : null}
                </Sequence>
              </Loop>
            )
          })}
        </Parallel>

        {/* Phase 6: production-readiness panel; failures spawn remediation. */}
        <Loop id="panelLoop" until={panelPassed()} maxIterations={3} onMaxReached="return-last">
          <Sequence>
            {panelHasFailure() ? (
              <Worktree id="remediateWt" path={`${WT_ROOT}/alpha-remediate`} branch="alpha/remediate" baseBranch="main">
                <Task
                  id="panelRemediate"
                  agent={panelAgents.remediate}
                  output={outputs.alphaLand}
                  retries={8}
                  timeoutMs={120 * 60_000}
                  heartbeatTimeoutMs={40 * 60_000}
                >
                  {remediatePrompt()}
                </Task>
              </Worktree>
            ) : null}
            <Parallel>
              <Worktree id="panelCodexWt" path={`${WT_ROOT}/alpha-panel-codex`} branch="alpha/panel-codex" baseBranch="main">
                <Task
                  id="panelCodex"
                  agent={panelAgents.codex}
                  output={outputs.alphaPanel}
                  retries={8}
                  timeoutMs={90 * 60_000}
                  heartbeatTimeoutMs={20 * 60_000}
                >
                  {panelPrompt("codex")}
                </Task>
              </Worktree>
              <Worktree id="panelFableWt" path={`${WT_ROOT}/alpha-panel-fable`} branch="alpha/panel-fable" baseBranch="main">
                <Task
                  id="panelFable"
                  agent={panelAgents.fable}
                  output={outputs.alphaPanel}
                  retries={8}
                  timeoutMs={90 * 60_000}
                  heartbeatTimeoutMs={20 * 60_000}
                >
                  {panelPrompt("fable")}
                </Task>
              </Worktree>
            </Parallel>
          </Sequence>
        </Loop>

        {/* Phase 7: human tasks, gated behind the panel. */}
        {panelPassed() ? (
          <Sequence>
            <Task
              id="humanPrep"
              agent={panelAgents.prep}
              output={outputs.alphaPrep}
              retries={8}
              timeoutMs={45 * 60_000}
              heartbeatTimeoutMs={15 * 60_000}
            >
              {humanPrepPrompt}
            </Task>
            <HumanTask id="humanRatify" output={outputs.alphaHuman} prompt={humanGatePrompt} />
          </Sequence>
        ) : (
          <HumanTask id="humanEscalate" output={outputs.alphaHuman} prompt={humanEscalatePrompt} />
        )}
      </Sequence>
    </Workflow>
  )
})
