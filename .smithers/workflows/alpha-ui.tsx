/** @jsxImportSource smthrs */
import { execSync } from "node:child_process"
import { homedir } from "node:os"
import path from "node:path"
import {
  Approval,
  ClaudeCodeAgent,
  CodexAgent,
  KimiAgent,
  Loop,
  MergeQueue,
  Parallel,
  Sequence,
  Task,
  UI,
  Worktree,
  approvalDecisionSchema,
  createSmithers,
} from "smthrs"
import { z } from "zod"

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({
    carriedFindings: z.string().default(""),
  }),
  alphaUiImpl: z.object({
    laneKey: z.string().min(2),
    summary: z.string().min(40),
    testsAdded: z.string().min(4),
    gatesGreen: z.boolean(),
    commitTip: z.string().min(7),
    blocked: z.string().min(2),
  }),
  alphaUiReview: z.object({
    laneKey: z.string().min(2),
    verdict: z.enum(["approve", "fix"]),
    findings: z.string().min(4),
    summary: z.string().min(40),
  }),
  alphaUiFix: z.object({
    laneKey: z.string().min(2),
    summary: z.string().min(20),
    addressed: z.string().min(4),
    commitTip: z.string().min(7),
  }),
  alphaUiLand: z.object({
    laneKey: z.string().min(2),
    landedTip: z.string().min(7),
    gatesGreen: z.boolean(),
    summary: z.string().min(20),
  }),
  alphaUiLandCheck: z.object({
    laneKey: z.string().min(2),
    verifiedTip: z.string().min(2),
    onMain: z.boolean(),
  }),
  alphaUiPolish: z.object({
    laneKey: z.string().min(2),
    verdict: z.enum(["lgtm", "fix"]),
    findings: z.string().min(4),
    gatesGreen: z.boolean(),
    summary: z.string().min(30),
  }),
  alphaUiPolishFix: z.object({
    laneKey: z.string().min(2),
    summary: z.string().min(20),
    landedTip: z.string().min(7),
  }),
  alphaUiPanelFix: z.object({
    summary: z.string().min(30),
    addressed: z.string().min(4),
    landedTip: z.string().min(7),
  }),
  alphaUiPanel: z.object({
    panelist: z.enum(["codex-sol", "claude-fable"]),
    verdict: z.enum(["PRODUCTION-READY", "NOT-READY"]),
    failures: z.string().min(4),
    summary: z.string().min(40),
  }),
  alphaUiHuman: z.object({
    summary: z.string().min(20),
    humanTasksPath: z.string().min(5),
    landedTip: z.string().min(7),
  }),
  alphaUiGate: approvalDecisionSchema,
})

const REPO = "/Users/williamcory/flows2"
const AUDIT = "/Users/williamcory/Desktop/flows-alpha-readiness-2026-08-16/ui-readiness.md"
const BRIEF = "/Users/williamcory/flows2/ui.PROMPT.md"

const GATES = `
THE APPS GATES (run all nine from the worktree root; every one must exit 0):
  pnpm --filter smithers-ui run typecheck
  pnpm --filter smithers-server run typecheck
  pnpm --filter smithers-shared run typecheck
  (cd apps/tui && bun run typecheck)
  pnpm --filter smithers-ui run build
  (cd apps/ui && bun test src)
  (cd apps/server && bun test src)
  (cd apps/shared && bun test src)
  (cd apps/tui && bun test src)
Baseline at commit 3fcf5fcd: all nine green (468/100/33/20 tests). A red gate
you did not cause means your base moved; rebase and re-run before blaming your
change. Never weaken or edit an existing test to get green.
`

const RULES = `
Ground rules:
- You work in an isolated git worktree (plain git, not jj). First command:
  "git status" and "git log --oneline -3" to confirm where you are. Continue
  from any previous attempt's commits instead of restarting.
- Run "pnpm install --frozen-lockfile --ignore-scripts" at the worktree root
  before building or testing. Never symlink node_modules from another checkout.
- pnpm only (packageManager pinned in package.json). Never npm or yarn.
- PATH OWNERSHIP: edit only apps/** unless your lane brief explicitly names
  another path. Never edit packages/**. If a change belongs in packages/**,
  append a request to apps/ui/LIBRARY-CHANGE-REQUESTS.md instead (existing
  convention in that file).
- Read apps/ui/AGENTS.md before touching apps/ui. The EMBED LAW and the
  NO INVENTION rule are binding: everything renders as an embedded card in the
  chat transcript, and nothing user-visible is added unless the brief names it.
- No React useEffect in application code. Store app state in TanStack DB
  collections; components are projections.
- Test discipline: never edit an existing test to make your change pass. New
  behavior ships with new tests in the owning package.
- Commit style: emoji conventional commits, matching "git log --oneline". Stage
  with explicit file paths only; never "git add -A", "git add .", "git commit -a".
- Never run "wrangler deploy" against real Cloudflare, never touch the deployed
  Worker identity (apps/server/wrangler.jsonc:7-11 is deliberately frozen).
  Anything deploy-shaped must be dry-run only.
- Time budget: your task should finish in under 75 minutes. Prefer the minimal
  correct diff; do not refactor beyond your lane.
${GATES}
`

const LAND_DISCIPLINE = `
LANDING DISCIPLINE (fix-forward, rebase-first, never rewrite main):
1. git fetch origin
2. git rebase origin/main   (resolve conflicts preserving both intents; never
   discard other lanes' work; never force-push anything)
3. Re-run all nine apps gates. All green.
4. git push origin HEAD:main
5. If the push is rejected (non-fast-forward), repeat from step 1. Give up
   only after 4 rejected attempts and say so in your report.
6. Verify: "git fetch origin && git merge-base --is-ancestor <your-tip> origin/main"
   must exit 0. Report the exact 40-char sha of your tip as landedTip only
   after this verification passes.
Never rewrite or force-push main. Fix-forward only.
`

type Lane = {
  key: string
  title: string
  brief: string
}

const LANES: Lane[] = [
  {
    key: "u1",
    title: "U1 reco card content (checklist A-8)",
    brief: `
Fix launch-checklist fail A-8: the recommendation card is missing its
proposes / why-now / what-happens content.
Evidence: apps/reports/launch-checklist/20260810T193728Z-launch-final/launch-checklist-report.md
(section "A-8"). The checker found no card carrying proposes/why-now/what-happens
with accept/edit/dismiss controls. Find the recommendation card component under
apps/ui/src/mainview (the reco.* flows and their card renderer) and make the
card render all three fields from the recommendation payload, with the
accept/edit/dismiss controls the checklist expects.
Definition of done: the card renders proposes, why-now, and what-happens; a
unit test on the card asserts all three render from a representative payload
(bun test, happy-dom, matching the suite conventions in apps/ui).`,
  },
  {
    key: "u2",
    title: "U2 Escape dismisses reco card (checklist A-9)",
    brief: `
Fix launch-checklist fail A-9: Escape does not dismiss the recommendation card.
Evidence: apps/reports/launch-checklist/20260810T193728Z-launch-final/launch-checklist-report.md
(section "A-9"): "Escape did not dismiss the recommendation card in one
keypress". Make one Escape keypress dismiss the focused/visible recommendation
card, and make the dismissal route through the same flow dispatch path as the
dismiss button (reco.dismiss), with the actor recorded, so the same
recommendation does not return unchanged.
Definition of done: Escape dismisses in one keypress; a unit test simulates the
keypress and asserts the card is gone and the dismiss flow ran.`,
  },
  {
    key: "u3",
    title: "U3 silence the workflow-launch overclaim",
    brief: `
Silence the workflow-launch overclaim: the chat model claims workflow creation
in prose while only the deterministic card is authoritative.
Evidence: apps/WAVE11-RECEIPT.md section 5 ("The model still overstates the
launch"): live, beside a run card saying Running, the assistant wrote that a
workflow "has been created and is now running", inventing a name. Prompt-level
truth discipline did not hold. Route the launch-result claim through the card
only, or tighten the tool result until the model stops inventing: apply the
wave-10 lesson that deterministic affordances must not route through the model,
extended to result claims. Acceptable implementations include suppressing or
post-processing the model prose for launch turns, or restructuring the tool
result so there is nothing for the model to overclaim; pick the smallest
mechanism that is deterministic (not another prompt plea).
Definition of done: a turn that launches a workflow produces no prose claim
beyond what the card shows, enforced by a regression test that exercises the
turn path with a fake model that tries to overclaim.`,
  },
  {
    key: "u4",
    title: "U4 scripted deploy (dry-run capable)",
    brief: `
Scripted deploy: one repeatable path, vite build then wrangler deploy with
version recording, as a script plus a CI workflow triggered on tag, both
runnable in --dry-run mode without Cloudflare credentials.
Evidence: audit sections 2 and 8.3 (${AUDIT}); apps/server/wrangler.jsonc;
manual procedure in apps/WAVE7-DEPLOY-RECEIPT.md section 2.
Implement:
- A deploy script (apps/server/scripts/ or apps/ui/scripts/, your call) that
  builds apps/ui with vite, then runs wrangler deploy for apps/server, records
  the deployed version (git sha + timestamp) into a small receipt file, and
  supports --dry-run end to end: with --dry-run it must run the real vite
  build and "wrangler deploy --dry-run" (no credentials needed) and write the
  receipt to a dry-run location.
- A root-reachable "pnpm run deploy:dry" script wiring (add the script to the
  relevant package.json under apps/; if a root package.json script is needed,
  add exactly one line there and nothing else).
- A NEW GitHub Actions workflow file .github/workflows/apps-deploy.yml
  triggered on tag push (pattern like apps-v*), running the same script with
  the real deploy step gated on a CLOUDFLARE_API_TOKEN secret. Do NOT edit the
  existing ci.yml or release.yml. The workflow must also be runnable via
  workflow_dispatch in dry-run mode.
- A runbook (apps/server/DEPLOY.md) for the credentialed human run: exact
  commands, required secrets, rollback note, and the frozen-identity warning
  from wrangler.jsonc:7-11.
HARD CONSTRAINT: never run a real "wrangler deploy" here; the Worker identity
is frozen to protect Durable Object state. Prove the pipeline with --dry-run.
Definition of done: "pnpm run deploy:dry" proves build + dry-run deploy +
receipt end to end without credentials; the CI workflow file is committed and
lints (actionlint if available, else careful YAML review); runbook committed.`,
  },
  {
    key: "u5",
    title: "U5 invite mechanics hardening",
    brief: `
Invite mechanics hardening: test the auth.request-access -> admin approval ->
allowlist path end to end at the unit/integration level, and add an
admin.allowlist.add batch door or script so seeding invitees is one command.
Evidence: audit section 7.9 (${AUDIT}); flows declared in
apps/ui/src/mainview/flows/Flows.ts (auth.request-access, admin.allowlist.*,
admin.grant*); the identity/allowlist seam lives behind apps/server.
Implement:
- Tests (bun test, no live network; fake the identity worker seam the way the
  existing apps/server tests fake upstreams) covering: a signed-in
  non-allowlisted user issuing auth.request-access; an admin approving; the
  user then passing the allowlist check.
- A batch seed door: either extend admin.allowlist.add to accept a list, or a
  script (apps/server/scripts/seed-allowlist.mjs or similar) that takes a file
  or comma list of GitHub logins and issues the admin calls; must support a
  --dry-run mode that prints what it would do without credentials.
- Document the one-command seed procedure in apps/server/DEPLOY.md or a
  dedicated apps/server/INVITES.md.
Definition of done: tests green; documented one-command seed procedure.`,
  },
  {
    key: "u6",
    title: "U6 zero-balance UX (checklist D-4)",
    brief: `
Zero-balance behavior (checklist D-4, never tested): implement/verify what a
signed-in user with a $0 balance sees on chat and on workflow launch. It must
be a clear paywall/grant message, not a hang or a stack trace.
Evidence: launch-checklist D-4 in
apps/reports/launch-checklist/20260810T193728Z-launch-final/launch-checklist-report.md:
"At $0, interactive chat keeps working; only non-complimentary work pauses".
Trace the metering path in apps/server (turn routes) and the billing flows in
apps/ui (billing.balance, billing.upgrade) to find what actually happens at $0
today. Implement the deterministic UX: chat and workflow launch at $0 render a
clear embedded message stating the balance is exhausted and how to proceed
(grant/upgrade path), per the EMBED LAW (an embedded card/notice in the
transcript, never a full-screen takeover, no invented chrome beyond the
message the brief names).
Definition of done: deterministic zero-balance UX on both chat and workflow
launch, with tests (fake the billing seam at $0; assert the message renders
and nothing hangs or throws).`,
  },
  {
    key: "u7",
    title: "U7 headless launch-checklist runner",
    brief: `
Launch-checklist automation: make the signed-in checklist runnable headlessly
against a target origin via an env-var/flag base URL, so the post-deploy re-run
is one command. Do NOT run it against live canary from this lane; prove it in
dry/local mode only.
Evidence: apps/ui/scripts/ (the existing e2e/checklist scripts that produced
apps/reports/launch-checklist/*); audit section 4 (${AUDIT}).
Implement:
- Parameterize the checklist runner on a target origin (flag --target or env
  CHECKLIST_TARGET), removing any hardcoded canary URL.
- A "pnpm run checklist -- --target <origin>" entry (script in apps/ui
  package.json) that runs the signed-in checklist headlessly; auth material
  comes from env (session/bearer), never committed.
- A dry/local mode (--dry-run or a local target) that proves the runner wires
  up, enumerates its checks (including D-4 with a zero-balance bearer), and
  writes a report skeleton without needing the live deployment.
- A short runbook section (apps/ui/scripts/README.md or extend the existing
  docs) covering the post-deploy invocation.
Definition of done: "pnpm run checklist -- --target <origin>" works in
dry/local mode; runbook committed. No live canary traffic from this lane.`,
  },
  {
    key: "u8",
    title: "U8 apps-split follow-ups",
    brief: `
Follow-ups from the apps split (cheap, bounded):
Evidence: apps/MIGRATION.md "Known follow-ups" (lines ~138-143).
1. apps/ui/.gitignore still carries stale "reports/" rules from before the
   docs moved to apps/reports/, while e2e scripts still write screenshots to
   apps/ui/reports/. Reconcile: keep ignoring the screenshot output dir if the
   scripts still write there, drop rules that reference the moved docs, and
   leave a one-line comment saying which scripts write there.
2. Add "@smthrs/chain-next" to the browser-safe entry list in
   scripts/browser-check.mjs (repo root; this file is explicitly in your lane
   scope as the one exception to apps/** ownership). Run the script to prove
   it passes: "pnpm run browser" or "node scripts/browser-check.mjs".
Update apps/MIGRATION.md to mark both follow-ups done.
Definition of done: both fixed with the checks run, or explicitly deferred
with a reason noted in apps/MIGRATION.md.`,
  },
  {
    key: "evals",
    title: "Evals lane: orchestration eval suite",
    brief: `
Author a Smithers eval suite that scores an orchestrator following the alpha
readiness brief, and commit the suite plus a baseline report.
The brief lives at ${BRIEF} (read it in full; it may be absent from your
worktree since it is untracked, so read that absolute path directly).
The doctrine the suite must score an orchestrator against:
- parallel implementation lanes (not serialized),
- exactly one pre-merge review per lane,
- landing on main immediately after review clears (rebase-first, never batch),
- post-land polish loops that converge to explicit LGTM,
- human tasks gated behind a production-readiness panel.
Implement, all under .smithers/ (this lane does NOT touch apps/**):
- .smithers/workflows/alpha-ui-evals.tsx: a small single-task workflow that
  takes an orchestration-scenario description as input and produces a
  structured judgment (which doctrine rule applies and what the orchestrator
  should do). Use the createSmithers pattern from
  .smithers/workflows/iso-ui-port.tsx as a style reference. Do NOT edit
  .smithers/workflows/alpha-ui.tsx or anything it imports; it is running.
- .smithers/evals/alpha-ui-cases.jsonl: at least 10 scenario cases with
  expected judgments covering every doctrine rule above (e.g. "reviewer asked
  for a second pre-merge pass" -> refused; "three lanes cleared review" ->
  land each immediately, serialized only by the queue).
- A test for the new workflow at .smithers/tests/alpha-ui-evals.test.tsx using
  renderWorkflow from "smthrs/testing" (assert node ids, schema, and behavior
  for representative inputs), registered by appending the file to the "test"
  script in .smithers/package.json (space-separated list; do not remove
  existing entries).
- Run the suite: "cd .smithers && bunx smthrs eval workflows/alpha-ui-evals.tsx
  --cases evals/alpha-ui-cases.jsonl --suite alpha-ui-baseline" and commit the
  resulting report (or, if the eval runner cannot execute in this environment,
  commit the suite plus a REPORT.md explaining exactly what blocked execution
  and how to run it).
Definition of done: suite + workflow + registered test committed, baseline
report (or honest blocker note) committed.`,
  },
]

const implPrompt = (lane: Lane, carried: string) => `
You are one implementation lane of the flows UI alpha-readiness track in this
repo (an independent checkout of smithersai/flows). Your lane: ${lane.title}.

${lane.brief}

${RULES}

Land your work as commits on this worktree's branch (do NOT push to main; a
separate land step does that). Keep the lane to one commit if reasonable, or a
small series of clean commits.

Report laneKey as exactly "${lane.key}", a summary of what you changed and why,
testsAdded (the test files/names you added), gatesGreen (true only if you ran
all nine gates and they passed; run them, do not assume), commitTip (the exact
40-char sha of your branch tip), and blocked ("none" if nothing is blocked).
${carried ? `\nFindings carried from a previous run, fix these first:\n${carried}\n` : ""}
`

const reviewPrompt = (lane: Lane) => `
You are the single pre-merge reviewer for one implementation lane of the flows
UI alpha-readiness track. Lane: ${lane.title}. This is the ONLY review before
this lane lands on main, so be thorough but proportionate; there is no second
pre-merge pass.

The lane brief the implementation was working to:
${lane.brief}

Review IN THIS WORKTREE (you are in the lane's worktree; the implementation is
committed on this branch):
1. Read the diff against the merge base:
   git log --oneline origin/main..HEAD and git diff origin/main...HEAD
2. Check the definition of done in the brief, point by point.
3. Check the repo rules: apps/** ownership (except paths the brief names),
   apps/ui/AGENTS.md EMBED LAW and NO INVENTION, no useEffect in app code, no
   edits that weaken existing tests, emoji conventional commits.
4. Run the gates you consider decisive for this lane (at minimum the owning
   package's typecheck and bun test suite; run "pnpm install --frozen-lockfile
   --ignore-scripts" first if node_modules is missing).
5. Distinguish lane defects from inherited main breakage: a failure in files
   the diff never touched is not this lane's finding.

Verdict "approve" only if the definition of done is met and you found nothing
that must change before landing. Otherwise verdict "fix" with findings as a
numbered, priority-ordered list: file:line, the defect, what to change.
Findings must be actionable; do not pad. Report laneKey exactly "${lane.key}",
verdict, findings ("none" when approving), and a summary of what you verified.
Time budget: 25 minutes.
`

const fixPrompt = (lane: Lane) => `
You are the fix step of one implementation lane (${lane.title}) of the flows UI
alpha-readiness track. The single pre-merge review returned verdict "fix".
Apply every finding from the review, in this worktree, as follow-up commits.

The findings are in the alphaUiReview output row for laneKey "${lane.key}"
(shown to you below via the workflow context if available; otherwise read the
review's numbered findings from the task output referenced in your prompt).

${RULES}

After applying the findings, re-run the gates the findings touch plus the
owning package's tests. Do not push to main; the land step does that.
Report laneKey exactly "${lane.key}", summary, addressed (each finding number
and what you did), and commitTip (exact 40-char sha of the branch tip).
`

const landPrompt = (lane: Lane) => `
You are the LAND step for lane ${lane.key} (${lane.title}) of the flows UI
alpha-readiness track. The lane has cleared its single pre-merge review.

Work in the lane worktree at the absolute path
${REPO}/.smithers/workflows/.worktrees/alpha-${lane.key}
(cd there first; do not touch any other checkout, and make no edits outside
that worktree). The lane's work is committed on its branch alpha-ui/${lane.key}.

${LAND_DISCIPLINE}

Conflict rule: if the rebase conflicts with work other lanes landed, resolve
keeping both intents; if a conflict is semantic and you cannot preserve both,
prefer origin/main's version and re-apply this lane's intent on top with a new
commit, noting it in your summary.

Report laneKey exactly "${lane.key}", landedTip (the verified 40-char sha now
an ancestor of origin/main), gatesGreen (the observed result of the nine gates
you ran after the final rebase), and a summary. If after 4 attempts you could
not land, report landedTip "unlanded" plus what blocked you.
`

const polishReviewPrompt = (lane: Lane) => `
You are a post-land polish reviewer for lane ${lane.key} (${lane.title}) of the
flows UI alpha-readiness track. The lane already landed on origin/main. Your
job is the per-commit polish pass: a fresh review of the landed work against
CURRENT origin/main, plus the gates, converging to an explicit LGTM.

Work in the lane worktree at
${REPO}/.smithers/workflows/.worktrees/alpha-${lane.key} (cd there first).
1. git fetch origin && git checkout the lane branch if needed, then
   git log origin/main --oneline -20 to locate the lane's landed commits
   (they carry the lane's changes; identify them by content, not memory).
2. Review the landed diff as it exists ON MAIN now (git show / git diff
   against the parent), for: correctness against the lane brief's definition
   of done, interactions with everything else that has landed since, EMBED
   LAW / NO INVENTION compliance, and test quality.
3. Run the nine apps gates on origin/main in this worktree
   (git checkout --detach origin/main is acceptable for the gate run; return
   to the branch afterwards). Report their result as gatesGreen.
Lane brief for reference:
${lane.brief}

Verdict "lgtm" only when the landed state needs nothing further and the gates
are green on current main. Otherwise verdict "fix" with numbered actionable
findings (file:line, defect, change). Do not re-open findings a previous
polish round already fixed properly, and do not invent work: absence of polish
opportunities is the expected terminal state. Report laneKey exactly
"${lane.key}", verdict, findings ("none" for lgtm), gatesGreen, summary.
Time budget: 20 minutes.
`

const polishFixPrompt = (lane: Lane) => `
You are the polish fix-forward step for lane ${lane.key} (${lane.title}). The
polish reviewer returned "fix". Apply every finding, then land the fix-forward
commit(s) on main yourself.

Work only in ${REPO}/.smithers/workflows/.worktrees/alpha-${lane.key}
(cd there first). Rebase the lane branch on origin/main, apply the findings as
new commits, then follow:
${LAND_DISCIPLINE}
${RULES}

Report laneKey exactly "${lane.key}", summary, and landedTip (verified 40-char
sha ancestor of origin/main; "unlanded" plus the reason if landing failed).
`

const panelPrompt = (panelist: "codex-sol" | "claude-fable") => `
You are one of two INDEPENDENT production-readiness verifiers for the flows UI
alpha-readiness track (panelist "${panelist}"). You share no context with the
other verifier; do not look for or rely on their output. Audit what is
actually on origin/main against the definitions of done, from scratch,
trusting nothing any implementer reported.

Setup: create your own scratch worktree so you never touch a shared checkout:
  cd ${REPO} && git fetch origin &&
  git worktree add --detach /tmp/alpha-ui-panel-${panelist} origin/main &&
  cd /tmp/alpha-ui-panel-${panelist} &&
  pnpm install --frozen-lockfile --ignore-scripts

The eight task definitions of done (audit each one against the code and tests
now on origin/main; the full brief is at ${BRIEF} and the audit at ${AUDIT}):
U1 reco card renders proposes/why-now/what-happens with a unit test.
U2 Escape dismisses the reco card, with a test.
U3 a workflow-launch turn produces no prose claim beyond the card, with a
   regression test.
U4 "pnpm run deploy:dry" proves vite build + wrangler dry-run deploy + version
   receipt without credentials; a tag-triggered CI workflow file exists; a
   runbook for the credentialed run exists; the frozen Worker identity was
   never touched and no real deploy ran.
U5 request-access -> admin approval -> allowlist covered by tests; one-command
   batch allowlist seed exists and is documented.
U6 deterministic zero-balance UX on chat and workflow launch, with tests.
U7 "pnpm run checklist -- --target <origin>" runs the signed-in checklist
   headlessly in dry/local mode; runbook exists.
U8 apps/ui/.gitignore reports/ rules reconciled and @smthrs/chain-next added
   to scripts/browser-check.mjs, or explicitly deferred in apps/MIGRATION.md.
Evals: .smithers/evals suite + alpha-ui-evals workflow + registered test +
   baseline report (or honest blocker note) committed.

Also verify the alpha bar: all nine apps gates green on origin/main (run them
yourself in your scratch worktree), no forbidden edits under packages/**
attributable to this track (check git log for this track's lanes), and no test
weakened to pass (spot-check suspicious test diffs in git log).

Verdict "PRODUCTION-READY" only if every definition of done above is met on
origin/main and the gates are green. Otherwise "NOT-READY" with failures as a
numbered list naming the task id, the gap, and the file evidence. Be strict;
an unmet DoD is a failure even if the work is "mostly there". Report panelist
exactly "${panelist}", verdict, failures ("none" if ready), summary.
When finished, remove your scratch worktree:
  cd ${REPO} && git worktree remove --force /tmp/alpha-ui-panel-${panelist}
Time budget: 40 minutes.
`

const panelFixPrompt = `
You are the fix-forward step after a failed production-readiness panel for the
flows UI alpha-readiness track. One or both independent verifiers returned
NOT-READY. Their numbered failures are in the alphaUiPanel output rows (nodes
panelCodex and panelFable). Address EVERY failure listed by either verifier.

Setup a scratch worktree (do not touch shared checkouts):
  cd ${REPO} && git fetch origin &&
  git worktree add /tmp/alpha-ui-panelfix -b alpha-ui/panel-fix origin/main &&
  cd /tmp/alpha-ui-panelfix &&
  pnpm install --frozen-lockfile --ignore-scripts

${RULES}
${LAND_DISCIPLINE}

When done, remove the scratch worktree:
  cd ${REPO} && git worktree remove --force /tmp/alpha-ui-panelfix
(the branch may remain). Report summary, addressed (each failure and what you
did), and landedTip (verified 40-char sha ancestor of origin/main).
`

const humanDocPrompt = `
You are the final documentation step of the flows UI alpha-readiness track.
The production-readiness panel has concluded (its verdicts are in the
alphaUiPanel rows; report their actual state honestly, including a failed
panel that exhausted its retry rounds).

Write apps/HUMAN-TASKS.md on main containing exactly the four human tasks from
the brief (full brief at ${BRIEF}), each with concrete commands and pointers
into what this run landed:
- H1: Decide the alpha entry point: keep canary.smithers.sh (zero extra work)
  or stand the Worker up on a jjhub hostname (repoint route, repeat the wave-7
  secret inventory). Note: jjhub.tech marketing links point at
  code.smithers.sh; align links with the chosen entry point.
- H2: Run the credentialed deploy using U4's pipeline (CLOUDFLARE_API_TOKEN,
  frozen Worker identity) against the chosen entry point. Point at the runbook
  U4 landed.
- H3: Seed the real invitee allowlist with U5's one-command procedure and
  grant balances (admin.grant). Point at U5's script/door and docs.
- H4: Re-run U7's checklist against the deployed target (real GitHub session),
  including D-4 with a zero-balance bearer; then final go/no-go. Point at U7's
  command.
Also include a short status header: panel verdicts, any unlanded or deferred
work, and the known backend-side blockers that are out of this track's scope
(gateway VMs lack an AI-provider credential; wedged-VM resume; both are plue
side, see ${AUDIT} section 8).

Setup a scratch worktree, land the file on main with the landing discipline:
  cd ${REPO} && git fetch origin &&
  git worktree add /tmp/alpha-ui-humantasks -b alpha-ui/human-tasks origin/main &&
  cd /tmp/alpha-ui-humantasks
${LAND_DISCIPLINE}
Then remove the scratch worktree:
  cd ${REPO} && git worktree remove --force /tmp/alpha-ui-humantasks
Report summary, humanTasksPath ("apps/HUMAN-TASKS.md"), and landedTip
(verified 40-char sha ancestor of origin/main).
`

export default smithers((ctx) => {
  const unwrap = (row: unknown): Record<string, unknown> | undefined => {
    if (!row || typeof row !== "object") return undefined
    const r = row as Record<string, unknown>
    if (r.row && typeof r.row === "object") return r.row as Record<string, unknown>
    return r
  }
  const col = (row: unknown, camel: string): unknown => {
    const r = unwrap(row)
    if (!r) return undefined
    const snake = camel.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase())
    return r[camel] ?? r[snake]
  }
  const truthy = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true"
  const tableRows = (table: unknown): unknown[] => (Array.isArray(table) ? table : [])
  const laneRows = (table: unknown, key: string): unknown[] =>
    tableRows(table).filter((r) => col(r, "laneKey") === key)
  const lastLaneRow = (table: unknown, key: string): unknown => {
    const rows = laneRows(table, key)
    return rows.length > 0 ? rows[rows.length - 1] : undefined
  }

  const reviewRow = (key: string) => lastLaneRow(ctx.outputs?.alphaUiReview, key)
  const fixRow = (key: string) => lastLaneRow(ctx.outputs?.alphaUiFix, key)
  const landCheckRow = (key: string) => lastLaneRow(ctx.outputs?.alphaUiLandCheck, key)

  const reviewApproved = (key: string) => col(reviewRow(key), "verdict") === "approve"
  const landVerified = (key: string) => truthy(col(landCheckRow(key), "onMain"))
  const latestPolish = (key: string) => ctx.latest?.(outputs.alphaUiPolish, `${key}PolishReview`)
  const polishDone = (key: string) => col(latestPolish(key), "verdict") === "lgtm"
  const latestPolishLgtm = (key: string) => polishDone(key)

  const panelVerdict = (node: string) => col(ctx.latest?.(outputs.alphaUiPanel, node), "verdict")
  const panelPassed = () =>
    panelVerdict("panelCodex") === "PRODUCTION-READY" && panelVerdict("panelFable") === "PRODUCTION-READY"
  const panelHasFailures = () =>
    tableRows(ctx.outputs?.alphaUiPanel).some((r) => col(r, "verdict") === "NOT-READY")

  const reviewFindingsFor = (key: string): string => {
    const row = reviewRow(key)
    const findings = col(row, "findings")
    return typeof findings === "string" ? findings : ""
  }
  const panelFailuresText = (): string => {
    return tableRows(ctx.outputs?.alphaUiPanel)
      .filter((r) => col(r, "verdict") === "NOT-READY")
      .map((r) => `[${String(col(r, "panelist"))}] ${String(col(r, "failures"))}`)
      .join("\n")
  }

  // Load-balanced agent pools over the registered subscription accounts
  // (~/.smithers/accounts). Each seat is a failover chain: the engine
  // preflights down the chain, skips broken/rate-limited rungs run-wide, and
  // retries onto the next account on a provider failure, so quota never
  // stalls the run. Per-lane rotation spreads the nine lanes across the
  // accounts instead of concentrating load on the first rung.
  // (smthrs 0.34.0's fallbackAgents() would do this quota-aware; 0.34.0 is
  // broken in this workspace, so the pools are built by hand on 0.33.0.)
  const claudeAccount = (n: number, model: string) =>
    new ClaudeCodeAgent({
      model,
      configDir: path.join(homedir(), `.smithers/accounts/claude-${n}`),
      id: `smithers-account:claude-${n}`,
    })
  // claude-1 is at 100% weekly as of launch; keep it as the last rung.
  const CLAUDE_ORDER = [2, 3, 4, 5, 6, 7, 1]
  const rotate = <T,>(items: T[], by: number): T[] => {
    const k = ((by % items.length) + items.length) % items.length
    return [...items.slice(k), ...items.slice(0, k)]
  }
  const claudePool = (model: string, rot = 0) =>
    rotate(CLAUDE_ORDER, rot).map((n) => claudeAccount(n, model))
  // The brief asks for the kimi-for-coding seat on implementation lanes. The
  // kimi account is credential-less on this machine as of launch; preflight
  // failover advances past it to the claude pool if that is still true.
  const kimiSeat = new KimiAgent({
    model: "kimi-k2.7-code",
    configDir: path.join(homedir(), ".smithers/accounts/kimi-1"),
    id: "smithers-account:kimi-1",
  })
  const codexAccount = (label: string, dir: string) =>
    new CodexAgent({
      model: "gpt-5.6-sol",
      config: { model_reasoning_effort: "xhigh" },
      sandbox: "danger-full-access",
      skipGitRepoCheck: true,
      configDir: dir,
      id: `smithers-account:${label}`,
    })
  const laneIndex = (key: string) => Math.max(0, LANES.findIndex((l) => l.key === key))
  // The evals lane runs on claude-opus per the brief; every other lane leads
  // with the kimi seat and falls back to the balanced sonnet pool.
  const implSeat = (key: string) =>
    key === "evals"
      ? [...claudePool("claude-opus-5", laneIndex(key)), ...claudePool("claude-sonnet-5", 2)]
      : [kimiSeat, ...claudePool("claude-sonnet-5", laneIndex(key))]
  // Opus leads every review seat: as of 2026-08-16 every registered Claude
  // account sits at ~62% weekly, and Fable carries a 50% weekly plan cap, so
  // every fable rung rejects with seven_day_overage_included while opus and
  // sonnet still have headroom on the same accounts. Fable stays last so the
  // chain uses it again once the weekly window resets.
  const reviewSeat = (key = "") => [
    ...claudePool("claude-opus-5", laneIndex(key) + 3),
    ...claudePool("claude-sonnet-5", laneIndex(key) + 5),
    ...claudePool("claude-fable-5", laneIndex(key) + 3),
  ]
  const landSeat = claudePool("claude-sonnet-5", 1)
  const panelCodexSeat = [
    codexAccount("codex-1", path.join(homedir(), ".codex")),
    codexAccount("codex-2", path.join(homedir(), ".smithers/accounts/codex-2")),
    ...claudePool("claude-opus-5", 5),
  ]
  // The second panelist stays a Claude of independent lineage from the codex
  // verifier; opus leads because fable is weekly-capped (see reviewSeat).
  const panelFableSeat = [...claudePool("claude-opus-5", 0), ...claudePool("claude-fable-5", 0)]

  const carried = String(ctx.input?.carriedFindings ?? "")

  const shaOk = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{7,40}$/i.test(v)
  const verifyLand = (key: string) => {
    const claimed = col(lastLaneRow(ctx.outputs?.alphaUiLand, key), "landedTip")
    return () => {
      if (!shaOk(claimed)) {
        return { laneKey: key, verifiedTip: "invalid-or-unlanded", onMain: false }
      }
      try {
        execSync("git fetch origin main", { cwd: REPO, stdio: "pipe", timeout: 120000 })
        execSync(`git merge-base --is-ancestor ${claimed} origin/main`, {
          cwd: REPO,
          stdio: "pipe",
          timeout: 60000,
        })
        return { laneKey: key, verifiedTip: claimed, onMain: true }
      } catch {
        return { laneKey: key, verifiedTip: claimed, onMain: false }
      }
    }
  }

  return (
    <Workflow name="alpha-ui">
      <UI entry="../ui/alpha-ui.tsx" />
      <Sequence>
        <Parallel maxConcurrency={9}>
          {LANES.map((lane) => (
            <Worktree
              key={lane.key}
              id={`${lane.key}Wt`}
              path={`${REPO}/.smithers/workflows/.worktrees/alpha-${lane.key}`}
              branch={`alpha-ui/${lane.key}`}
              baseBranch="main"
            >
              <Sequence>
                <Task id={`${lane.key}Impl`} agent={implSeat(lane.key)} output={outputs.alphaUiImpl} retries={8}>
                  {implPrompt(lane, carried)}
                </Task>
                <Task id={`${lane.key}Review`} agent={reviewSeat(lane.key)} output={outputs.alphaUiReview} retries={8}>
                  {reviewPrompt(lane)}
                </Task>
                <Task
                  id={`${lane.key}Fix`}
                  agent={implSeat(lane.key)}
                  output={outputs.alphaUiFix}
                  retries={8}
                  skipIf={reviewApproved(lane.key)}
                >
                  {`${fixPrompt(lane)}\nThe review findings to address:\n${reviewFindingsFor(lane.key) || "(review pending)"}\n`}
                </Task>
                {/* Lands are the run's critical path: measured at 32-60 min each
                    (rebase + the nine apps gates), so a strictly serialized queue
                    cannot clear nine lanes inside the deadline. Three at a time
                    still bounds the race on main, and the land prompt's
                    fetch-rebase-retry loop is what makes a rejected push safe. */}
                <MergeQueue id="landQueue" maxConcurrency={3}>
                  <Sequence>
                    <Task id={`${lane.key}LandRun`} agent={landSeat} output={outputs.alphaUiLand} retries={8}>
                      {landPrompt(lane)}
                    </Task>
                    <Task id={`${lane.key}LandVerify`} output={outputs.alphaUiLandCheck} retries={2}>
                      {verifyLand(lane.key)}
                    </Task>
                  </Sequence>
                </MergeQueue>
                <Loop
                  id={`${lane.key}PolishLoop`}
                  skipIf={!landVerified(lane.key)}
                  until={polishDone(lane.key)}
                  maxIterations={3}
                  onMaxReached="return-last"
                >
                  <Sequence>
                    <Task
                      id={`${lane.key}PolishReview`}
                      agent={reviewSeat(lane.key)}
                      output={outputs.alphaUiPolish}
                      retries={8}
                    >
                      {polishReviewPrompt(lane)}
                    </Task>
                    <Task
                      id={`${lane.key}PolishFix`}
                      agent={implSeat(lane.key)}
                      output={outputs.alphaUiPolishFix}
                      retries={8}
                      skipIf={latestPolishLgtm(lane.key)}
                    >
                      {`${polishFixPrompt(lane)}\nThe polish findings to address:\n${String(col(latestPolish(lane.key), "findings") ?? "(polish review pending)")}\n`}
                    </Task>
                  </Sequence>
                </Loop>
              </Sequence>
            </Worktree>
          ))}
        </Parallel>
        <Loop id="panelLoop" until={panelPassed()} maxIterations={3} onMaxReached="return-last">
          <Sequence>
            <Task
              id="panelFix"
              agent={[kimiSeat, ...claudePool("claude-opus-5", 4)]}
              output={outputs.alphaUiPanelFix}
              retries={8}
              skipIf={!panelHasFailures()}
            >
              {`${panelFixPrompt}\nThe panel failures to address:\n${panelFailuresText() || "(no failures recorded yet)"}\n`}
            </Task>
            <Parallel>
              <Task id="panelCodex" agent={panelCodexSeat} output={outputs.alphaUiPanel} retries={8}>
                {panelPrompt("codex-sol")}
              </Task>
              <Task id="panelFable" agent={panelFableSeat} output={outputs.alphaUiPanel} retries={8}>
                {panelPrompt("claude-fable")}
              </Task>
            </Parallel>
          </Sequence>
        </Loop>
        <Task id="humanTasksDoc" agent={reviewSeat()} output={outputs.alphaUiHuman} retries={8}>
          {humanDocPrompt}
        </Task>
        <Approval
          id="humanGate"
          output={outputs.alphaUiGate}
          onDeny="continue"
          request={{
            title: "Alpha UI readiness: human tasks are ready",
            summary:
              "The production-readiness panel has concluded and apps/HUMAN-TASKS.md is on main. " +
              "Approve to acknowledge handoff of H1 (choose alpha entry point), H2 (credentialed deploy via the U4 pipeline), " +
              "H3 (seed the invitee allowlist + grants via U5), H4 (re-run the U7 checklist against the deployed target, then go/no-go). " +
              "Deny to send findings back into the run.",
          }}
        />
      </Sequence>
    </Workflow>
  )
})
