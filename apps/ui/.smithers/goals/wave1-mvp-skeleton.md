# Wave 1 — MVP skeleton: foundation + command registry

You are working in `/Users/williamcory/mvp` — the repo where the Smithers web MVP ships **Monday 2026-08-10** (feature-complete; Thu Aug 13 is the live demo). Read `DESIGN.md` and `AGENTS.md` first and obey their rules: **no `useEffect` in application code; React components are projections, never authorities; every state change goes through the shared Flux dispatcher in `src/mainview/state/AppStore.ts` with actor recorded.** Never claim a step done without running its proof.

The repo is **jj-colocated on branch `oneshot-mskp7qe7-work`** (3 commits ahead of `main`); there may be no local `main`. Commit on the current branch. Do not create worktrees.

Do these in order:

## 1. Commit the uncommitted web-agent work
`git status` shows ~9 modified/new files (the entire pure-web agent path: `src/mainview/native/WebAgent.ts` + test, `src/bun/CloudAgent.test.ts`, edits to `CloudAgent.ts`, `bun/index.ts`, `App.tsx`, `NativeBridge.ts`, `AppController.test.ts`, `vite.config.ts`). Review, then commit in one or two clean conventional commits. This work must not stay uncommitted.

## 2. Fix the delete-insert bug (breaks every chat turn)
`bun test src` has 1 failing test: `AppStore.ts` `actions.replaced` deletes all action keys and re-inserts **the same ids** in one `createTransaction`, so TanStack DB throws `Unhandled mutation combination: delete-insert` (thrown from `refreshSuggestions()` after **every** completed/failed/cancelled turn — see `AppController.ts:143`). Fix by diffing/upserting per key (update existing ids, insert new, delete removed) instead of blanket delete+insert. Proof: `bun test src` fully green.

## 3. Widen the streaming contract to carry cards
`src/shared/NativeAgent.ts` `AgentTurnFrame` today only carries `{delta, kind, text}` and `{done, error?}`. The client already handles card frames (`AppController.ts:17-24`, Zod-validated `card` / `card.update`). Promote card frames into the shared `AgentTurnFrame` type (Zod schema), update `CloudAgent.ts` and `WebAgent.ts` parsing + the Vite middleware passthrough, and add tests proving a server-emitted `{type:"card"}` frame renders a PlanCard/ApprovalCard/StatusCard. This unblocks server-created approvals (DESIGN.md §5 says cards then go live with zero UI change).

## 4. Build the real deployable server (there is none today)
The web chat path only exists as a **Vite dev-server middleware** (`vite.config.ts:60-138`) — it does not exist in `vite build` output. Build the production server as a **Cloudflare Worker** (matching every other `*.smithers.sh` surface; the pattern to copy is `/Users/williamcory/flows/ui/workers/chat` and its siblings):
- Serves the built SPA (assets binding, `run_worker_first` for `/api/*`), with the COOP/COEP headers the OPFS SQLite persistence needs (see the headers the vite middleware sets today).
- Implements `POST /api/agent/turn` (streams `application/x-ndjson`, 64 KB body cap, cancel on disconnect) and `POST /api/agent/turn/cancel`, proxying upstream to `https://chat.smithers.sh/chat` exactly as `createCloudAgent` does — keep credentials/origin server-side.
- Include a **proxy seam for the engine gateway** (do not build the engine itself): route stubs for `/v1/rpc/*`, `/v1/api/*`, `/workflows/*` and the WebSocket upgrade that forward to a per-session upstream gateway URL (config placeholder), stripping client-supplied `x-user-id`/`x-user-scopes`/`x-user-role` and re-injecting from the validated session, per the trusted-proxy pattern in `/Users/williamcory/smithers/docs/guides/custom-workflow-ui.mdx`. A stub that 501s with an honest message when no upstream is configured is fine — the seam and header discipline are what matter.
- Add `bun run build` (vite build) and a wrangler config + `bun run serve:local` (`wrangler dev`) path. **Do NOT deploy to production.** Proof: scripted local e2e — build, start `wrangler dev`, open the page headless (or curl the endpoints), complete one streamed chat turn through `/api/agent/turn`.

## 5. Port the command registry — every button becomes a named command
Lift the pure command-registry model from `/Users/williamcory/flows/ui/src/ui/commands/registry.ts` (pure half: metadata, gold-recommendation rule, slash filtering, alias resolution, submit parsing), the binding pattern from `Commands.ts`, and the one-tool agent contract from `/Users/williamcory/flows/ui/src/ui/runtime/agentTools.ts`, into `src/mainview/commands/`. Then:
- Register **every existing action** as a command: connect, world, plan, reset, theme toggle, retry, copy message, approval approve/deny, connector add/remove/downgrade, and each suggestion pill.
- Every button/pill routes through the registry (`runCommand`), never a direct controller call. **Launch law: a button with no command behind it is a launch blocker.**
- `/` opens the menu listing from the registry with the **recommended command first**; bare `/` + Enter runs it; typing filters; `/name` invokes directly. Keep the existing keyboard behavior (arrows/Enter/Escape).
- Add a **parity test** that enumerates the registered commands and asserts every interactive affordance in the app maps to one (grep-based or render-based — make it a real gate, not a stub).

## 6. Final proofs
- `bun test src` fully green (including the new tests from steps 3–5).
- `bun run typecheck` clean.
- The step-4 local e2e proof runs scripted and passes.
- Write `WAVE1-RECEIPT.md` at the repo root: what landed, commit ids, every proof command with its observed output, and anything honestly incomplete. Do not overstate — an honest "not done" beats a fake done.
