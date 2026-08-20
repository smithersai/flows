# Wave 6 — Endgame: assemble the full stack and run the Launch Checklist against it

You are working in `/Users/williamcory/mvp` on branch `oneshot-mskp7qe7-work`. Read `WAVE3B-RECEIPT.md`, `WAVE2A-RECEIPT.md` first. **A concurrent workstream's files may sit uncommitted in this tree** (per-turn agent runtime context: `src/shared/AgentContext.*`, `src/server/AgentApiContext.test.ts`, `src/bun/CloudAgentContext.test.ts`, `src/mainview/state/AgentRuntimeContext.test.ts`, `src/worker/turnContext.test.ts`, `scripts/web-chat-context-e2e.ts`, and possible edits to `src/bun/CloudAgent.ts` / `src/server/AgentApi.ts`) — **do not commit, revert, or modify them**; stage your own commits by explicit path only, exactly as wave 3b did.

Everything is built. This wave finds out what is actually true. Three assets from the sibling repo `/Users/williamcory/flows/ui` (branch `wave5-billing-bridge` — verify it carries billing/identity/reco/chat/checklist by `git log`):
- `scripts/dev-stack.sh` + `scripts/dev-stack.env` — brings up all four workers wired together in test mode and prints the product Worker's env block (see `WAVE5-BRIDGE-RECEIPT.md`).
- `e2e/launch-checklist/` + `playwright.launch-checklist.config.ts` — the 27-row §A–§F suite, targeted by `SMITHERS_MVP_BASE_URL`, report at `launch-checklist-report.{json,md}` (see `WAVE1B-CHECKLIST-RECEIPT.md`).
- The relay gateway contract in `/Users/williamcory/plue/WAVE4-RELAY-RECEIPT.md` §5 (provision-or-resume, renew cadence, reconnect-and-replay, error taxonomy).

## 1. Bring the whole stack up locally
- Check out / use `wave5-billing-bridge` in the flows/ui checkout (the tree is idle; if it is on another branch, note it and switch — do not rebase or merge anything).
- `dev-stack.sh` up, health-checked. Product Worker `wrangler dev` on the expected origin with the printed env block: identity, billing, reco, chat all pointed at the stack; `GATEWAY_UPSTREAM_URL` at the stub gateway double for the baseline run. Zero 501s on the configured seams — prove with a seam probe script.
- **Stretch (attempt, don't block):** if a jjhub PAT is available locally (`jjhub` CLI auth / env), provision a real canary repo gateway via `POST https://api.jjhub.tech/api/repos/smithers-canary/hello-world/gateway` per the relay contract and point `GATEWAY_UPSTREAM_URL` at the relay for a second approval-path proof against PRODUCTION engine infra. If no PAT, say so honestly and stay on the double.

## 2. Run the checklist
- From flows/ui: `SMITHERS_MVP_BASE_URL=<product origin> npm run test:launch-checklist` (plus the storage-state env its receipt documents, using identity test-mode to mint the session). Archive `launch-checklist-report.{json,md}` into the mvp repo under `reports/launch-checklist/<timestamp>/`.
- Selector or harness drift against the real product is EXPECTED on first contact: you may fix the harness in flows/ui, commits path-scoped to `e2e/launch-checklist/` on its current branch, each fix justified in the receipt (a harness fix must make the check MORE honest, never looser — loosening an assertion to pass is forbidden).

## 3. Triage every fail into exactly one bucket
1. **Product bug, small** → fix it now in this repo (house rules: path-scoped commits, tests, parity gate), re-run the affected section.
2. **Product bug, large** → document precisely (row, repro, suspected seam) — do not half-fix.
3. **Config/deploy gap** (needs a real upstream, real OAuth, real deploy) → name the exact env/secret/deploy step and who provides it.
4. **Will-item** (allowlist handles, Stripe keys, OAuth app, quota, N) → list under a "waiting on will" heading.
5. **Not locally testable by design** (e.g. real GitHub OAuth redirect, real repo work landing on GitHub) → say why and what the staging pass will need.
- Re-run until the only remaining fails are buckets 2–5. Every re-run's report is archived; the receipt's table shows first-run vs final-run per row.

## 4. Receipt — the launch punch list
`WAVE6-ENDGAME-RECEIPT.md` at the repo root — THE document will reads before Monday:
- The final row-by-row table: 27 rows × {pass / fail(bucket) / not-testable-locally}, first vs final run.
- What was fixed this wave (commits), what remains per bucket with exact next actions and owners.
- The complete deploy checklist compiled across all receipts: every env var, secret, ALLOWED_ORIGINS entry, service token pairing, seed step, and deploy command for the product Worker + four sibling workers, in order, with will-provided items marked.
- Honest bottom line: what a design partner CAN experience today on this stack, and what they cannot yet.
