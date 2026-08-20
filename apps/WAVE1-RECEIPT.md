# Wave 1 receipt — MVP skeleton: foundation + command registry

Run: `oneshot-wave1-mvp-skeleton` on branch `oneshot-mskp7qe7-work`, 2026-08-08.

## What landed

### Preflight — uncommitted work committed (goal step 1 + 2)

The working copy held a prior run's complete, meaningful work (pure-web agent
path, the `actions.replaced` delete-insert fix, the dev-server `/api/agent`
boundary, tests). Reviewed, verified green, and committed in clean commits —
nothing left uncommitted; `.smithers/claude-mirror-subscriptions.json` (smithers
runtime state) gitignored.

- `67bbbfb` fix(state): upsert replaced actions per key so turn-end refresh cannot throw — **the step-2 delete-insert fix** (was already written in the working copy; verified, not rewritten).
- `a642928` feat(web): stream Smithers Cloud chat in the pure web build — the step-1 web-agent work (WebAgent, injectable CloudAgent, dev/preview `/api/agent` boundary, e2e script).
- `5628106` chore(smithers): record wave1 mvp-skeleton goal spec
- (`chore: ignore smithers claude-mirror runtime state`)

### Step 3 — streaming contract carries cards

- `2588012` feat(agent): carry card frames in the shared AgentTurnFrame contract
  - Card model moved to `src/shared/Cards.ts` (re-exported from `AppState.ts`); `AgentTurnFrame` is now a Zod `discriminatedUnion` with `delta` / `done` / `card` / `card.update` in `src/shared/NativeAgent.ts`.
  - `CloudAgent.ts` parses card frames off the upstream wire (Zod); `WebAgent.ts` validates with the shared schema; the Vite middleware passthrough (`src/server/AgentApi.ts`) needed no change — it streams `AgentTurnFrame`s.
  - Tests: CloudAgent card passthrough, WebAgent card passthrough, and `CardFrames.test.tsx` proving server-emitted `{type:"card"}` frames land in the store and render as PlanCard / ApprovalCard / StatusCard (`renderToStaticMarkup` on the real `CardView`).

### Step 4 — deployable Cloudflare Worker server

- `ebf4b25` feat(server): add the deployable Cloudflare Worker server
  - `src/worker/index.ts` + `wrangler.jsonc`: serves the built SPA via the assets binding (`run_worker_first` for `/api/*`, `/v1/*`, `/workflows/*`), COOP/COEP on asset responses via `src/mainview/public/_headers` (worker responses carry them directly).
  - `POST /api/agent/turn`: 64 KB body cap (413), streams `application/x-ndjson` from `chat.smithers.sh` with origin/`x-smithers-run-id` kept server-side, client disconnect aborts upstream. `POST /api/agent/turn/cancel`: per-isolate cancel map, honest `not-found`.
  - Gateway seam: `/v1/rpc/*`, `/v1/api/*`, `/workflows/*` and WebSocket upgrades 501 honestly while `GATEWAY_UPSTREAM_URL` is unset; when set, client `x-user-id` / `x-user-scopes` / `x-user-role` / `x-smithers-token-id` / `authorization` are stripped and identity re-injected from the configured session (trusted-proxy branch) or service token, per `docs/guides/custom-workflow-ui.mdx`.
  - Scripts: `bun run build` (vite build), `bun run serve:local` (`wrangler dev`), `bun run test:e2e:worker`. **Nothing deployed.**

### Step 5 — command registry

- `ea478a6` feat(commands): port the command registry — every affordance is a named command
  - `src/mainview/commands/registry.ts` (pure: metadata, gold rule, slash filter, alias, submit parsing), `Commands.ts` (bindings + one `run` path), `agentTools.ts` (one-tool agent contract).
  - 20 registered commands: connect, world, plan, reset, theme (+ dark-mode alias), chat, retry, stop, send, suggest, copy-message, approval.approve/deny, connector.add/downgrade/remove, world.new-note/select/delete.
  - Every button/pill in `App.tsx`, `ConnectorsSurface.tsx`, `ChatCards.tsx` routes through `runCommand`/`runCommandArgs`; `/` lists from the registry recommended-first, bare `/` + Enter runs gold, typing filters, `/name` invokes directly (parse in `send`), arrows/Enter/Escape unchanged.
  - `parity.test.ts` gates the launch law: every `onClick`/`onSubmit`/`onStop`/`onConfirm`/`onDecide`/`onSelect`/`onClose` in the surface files must route through the registry or carry an explicit presentation-only justification; handler counts and delegated bindings are pinned. Surface files are **discovered** (every non-test `.tsx` under `src/mainview`), not listed, so a newly added component with a command-less button fails the gate.

## Review fixes (post-implementation review pass)

- **Worker body cap was measured in UTF-16 code units, not bytes** (`src/worker/index.ts`): `text.length > 64 KB` admitted a body up to ~4x the cap when the transcript contained multi-byte characters, and a chunked request declares no `content-length` to catch it first. Now measured on the decoded `ArrayBuffer`. Regression test: `measures the 64 KB cap in bytes, not UTF-16 code units` — verified failing against the pre-fix worker and passing after.
- **The launch-law parity gate only scanned 4 hardcoded files**, so a new surface component with a command-less button was never inspected at all. File discovery is now dynamic; verified by adding a throwaway `TempProbe.tsx` with a bare `onClick` and observing both parity tests fail, then pass again once removed.
- Verified rather than assumed: the gateway seam's WebSocket upgrade path was exercised against a real `workerd` (`wrangler dev`) with `GATEWAY_UPSTREAM_URL` configured — the upgrade proxies through and the injected `x-user-id` reaches the upstream (`WS MESSAGE: hello-from-gateway`, `HTTP proxy: 200 {"ok":true,"userId":"user-123"}`). No defect; the `new Request(...)` re-wrap does not strip the upgrade in workerd.

## Proofs (all run this wave, observed output)

- `bun test src` → `52 pass / 0 fail, 169 expect() calls, 9 files` (50/165 before the review-pass tests).
- `bun run typecheck` → clean (no output, exit 0).
- `bun scripts/worker-e2e.ts` →
  `ok: SPA served with COOP/COEP headers.` /
  `ok: one streamed chat turn completed through /api/agent/turn (delta → card → done).` /
  `ok: cancel endpoint answered.` /
  `ok: gateway seam 501s honestly with no upstream configured.` /
  `PASS: worker e2e — build, wrangler dev, streamed turn, seam discipline.`
- `rg useEffect src` → no matches in application code (AGENTS.md rule holds).

## Honestly incomplete

- The agent one-tool contract (`agentTools.ts`) is wired to the registry and
  tested, but the chat transport (chat.smithers.sh) has no tool-call loop yet,
  so the model cannot invoke it end-to-end today.
- The gateway seam's "validated session" is deployment-configured placeholder
  vars; real session termination (GitHub OAuth) is out of Wave 1 scope, as
  instructed.
- `connector.downgrade`/`world.*` commands are not in the slash menu (hidden,
  id-scoped) — by design, they are button/agent-invoked.
- The worker's cancel map is per-isolate best effort; disconnect-driven cancel
  is the reliable path.
- **The turn body caps diverge between dev and production**: the Vite dev
  boundary allows 1 MB, the Worker 64 KB (as specified). Every turn replays the
  whole transcript, so a conversation past ~64 KB of messages will keep working
  in `bun run web` and start returning 413 on the deployed Worker. Not hit by
  the demo script, but it is a real ceiling — raising the Worker cap or
  truncating the replayed context is Wave 2 work.
- `scripts/web-chat-e2e.ts` (real-browser, live chat.smithers.sh) was not
  re-run this wave; it needs the dev server and a live upstream.
