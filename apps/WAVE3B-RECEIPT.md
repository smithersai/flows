# Wave 3b receipt — Product integration: recommendations, the agent tool loop, the admin plugin

Run: `oneshot-wave3b-integration` on branch `oneshot-mskp7qe7-work`, 2026-08-08.

## Preflight

The one untracked pre-existing path (`.smithers/goals/wave3b-reco-tools-admin.md`, the goal spec
itself) was committed alone as `a6523d6 chore(preflight): preserve pre-existing working-copy
changes before oneshot-wave3b-integration`. No conflicts, no `.jjconflict*` trees.

**Concurrent-session note:** a second oneshot run (`oneshot-mskuzra6-aa572bde`, the per-turn agent
runtime context wave) started in this same working tree mid-run. Its preflight snapshotted my
in-flight (uncommitted-at-the-time) wave-3b edits into `a39be1e`; its own goal files
(`src/shared/AgentContext.*`, `src/server/AgentApiContext.test.ts`, `src/bun/CloudAgentContext.test.ts`,
`src/mainview/state/AgentRuntimeContext.test.ts`, `src/worker/turnContext.test.ts`,
`scripts/web-chat-context-e2e.ts`, plus edits to `src/bun/CloudAgent.ts` / `src/server/AgentApi.ts`)
remain **uncommitted and untouched by this wave** — every wave-3b commit was staged by explicit
path and contains only wave-3b work. All gates below were run with both workstreams present and
are green for both.

## What landed

### 1. Recommendations in the product (Beat 5) — `5b27b4a`, `5c03744`, `0821b3a`, `a7e36c3`

- `/api/reco/*` proxies to `RECO_UPSTREAM_URL` with the same seam discipline (client identity
  headers stripped, the session cookie forwarded — the reco worker validates it against identity
  itself — and the proxy stating its own origin). Honest 501 naming the var when unset.
- On entering chat signed-in + allowlisted (`loadSession` chains it; sign-in is a full-page
  redirect so boot covers entry): `GET /api/reco/first-run`. A grounded answer renders the digest
  sentence **as the first Smithers message** — on a fresh transcript it replaces the filler
  welcome; the typed evidence (counts, most-active repo, oldest waiting item with its waiting
  days, untriaged count) sits one step deeper on the card. `degraded:true` renders the
  `honestMessage` as that first message; an unset/unreachable/unparseable seam renders its own
  honest line. Never a fake digest.
- The ONE recommendation is a card carrying proposes / why now / what happens (+ `whatChanged`
  when the server offers it). **Dismiss is one key** (Escape or `d` while the card is focused)
  plus the visible "Not now" affordance; it posts `dismiss` and removes the card without
  argument. Accept posts `accept`, freezes the card, and runs the proposal as an ordinary turn.
  Edit posts `edit` and opens the composer prefilled with the proposal. **Every accept/edit/dismiss
  posts feedback** with the recommendation id and evidenceKey; a failed post leaves the card
  honestly in error and retryable (the approval discipline), and the e2e + unit tests prove the
  retry path.
- The `/` surface lists the recommendation FIRST: `reco.accept` leads `recommendedNames` whenever
  an unanswered recommendation card exists, so bare `/` + Enter runs it. Commands: `reco.accept`,
  `reco.edit`, `reco.dismiss` (optional `[cardId]`), `reco.refresh` (re-reads and re-surfaces).
- `scripts/stub-backends.ts` gained the reco double honoring the landed shapes (grounded digest +
  one recommendation, the `/stub/degrade` control, the feedback log with 201s, the
  404-never-403 admin read, healthz).

### 2. The agent tool loop, client side — `5c03744`, `62a2060`, `a7e36c3`

- Every turn sends the one tool spec (`commands`, from `src/mainview/commands/agentTools.ts`) as
  `tools`; the Worker forwards it untouched (a turn without it fails the e2e's armed stub).
- A `{"type":"tool_call"}` frame is executed through `Commands.executeForAgent` — the identical
  `run` path as buttons and slash — with the controller's command actor set to `smithers` for the
  duration, so the journal records the agent as the actor of its own acts
  (`world.document.upserted` with `actor: "smithers"` is asserted in the tool-loop test).
- The continuation leg POSTs the same runId with the accumulated `function_call` /
  `function_call_output` items appended to the live transcript (tool-act lines and empty bubbles
  are filtered out of agent context). Client-side legs cap at **8** (mirroring the server's
  declared `CHAT_MAX_TOOL_LEGS` default); the cap and a server-side `done.reason:"tool_limit"`
  both end the turn with the same honest limit line. An unknown tool name returns
  `unknown-tool: <name>` to the model as the tool result — never a crash (tested).
- **Visibility:** every tool act renders a compact one-line marker ("Smithers ran
  /world.new-note", or the honest "Smithers tried …" with the error). Nothing completes silently.
- **Contract status (verified against the landed sibling code, since `workers/chat/TOOL-LOOP.md`
  does not exist):** the chat worker DOES carry `tools` upstream and DOES emit `tool_call`
  frames from both provider paths, and accepts the continuation items — but the wave-4 contract
  is only partially landed: `done.reason` is declared yet never emitted, `CHAT_MAX_TOOL_LEGS` is
  declared on `Env` yet never enforced, and the `tool_call` frame type declares an `id` field the
  emissions never set. The client is built against the documented frame contract with the stub
  upstream emitting `tool_call` frames; **no live end-to-end claim is made.** The e2e drives the
  real client (store + controller + WebAgent) against `wrangler dev`: the stub model calls
  `/world.new-note`, the note exists in the store afterward, the final text acknowledges it, and
  the act line rendered.

### 3. The admin plugin (Launch Checklist §E) — `5b27b4a`, `5c03744`, `0821b3a`, `fa7f8ea`

- Product Worker `/api/admin/*`: every route FIRST validates the session via identity's
  `/api/identity/validate` and requires `admin:true`. Anyone else — signed-out or signed-in
  non-admin — gets the canonical 404 `{status:"error","message":"Not found."}`, **byte-identical
  to any unknown `/api/*` route** (unknown API routes now answer that same 404 instead of the
  SPA). The e2e asserts byte equality for both a signed-out probe and a validated non-admin.
- Admin-true requests proxy: allowlist add/remove → identity's `admin/allowlist` with
  `requester` = the admin's validated login and a fresh timestamp; grant → billing's
  `admin/grants` with the same attribution and a fresh `admin:`-prefixed grant id; queue read →
  identity's `admin/requests`; reco feedback log → reco's `admin/feedback`. Each spends the
  sibling's own admin token (`IDENTITY_ADMIN_TOKEN` / `BILLING_ADMIN_TOKEN` / `RECO_ADMIN_TOKEN`);
  an unset token is an honest 501, never a forward.
- Client: the `admin.*` commands REGISTER ONLY when the session validates `admin:true` — absent,
  not hidden: a non-admin session's `registry.all()`, slash menu, and agent-tool list contain no
  trace, and `/admin.health` typed into a non-admin composer resolves exactly like any typo (the
  parity gate now pins both directions). Commands: `admin.allowlist.add|remove <login>`,
  `admin.grant <amount> <login>` (confirmation card stating exactly what will happen before
  anything posts; confirm/cancel via hidden id-scoped commands), `admin.requests` (queue card,
  one-click approve → allowlist add → the card re-reads the server's truth), `admin.feedback`
  (reco log card), `admin.health`.
- **"What failed overnight?" v1:** `GET /api/admin/health` composes real reads — billing
  healthz + the ledger's charge totals (read with the account bearer and the Worker's own
  origin), identity healthz, reco healthz, and the request-queue depth — each service an honest
  ok/failed/unconfigured line; charges and queue depth are null (not zero) when unreadable. The
  card carries no invented metrics.

## Proofs (all run this wave, observed output)

- `bun test src` → `135 pass / 0 fail, 509 expect() calls, 18 files` (was 85/10; the file count
  includes the concurrent context wave's five new suites, also green).
- `bun run typecheck` → clean (no output, exit 0).
- `bun scripts/worker-e2e.ts` → all 17 checks `ok`, including the new ones:
  `ok: reco seam 501s honestly with no upstream configured.` /
  `ok: the admin surface answers signed-out probes byte-identically to an unknown route (404, never 403).` /
  `ok: reco first-run + feedback round-trip through the seam; a signed-in non-admin probe is byte-identical to an unknown route.` /
  `ok: the admin journey — allowlist add with attribution, grant with attribution + fresh id, queue read, reco feedback log, health card facts.` /
  `ok: degraded reco answers render the honestMessage, never a fake digest.` /
  `ok: tool loop end to end — the stub model called /world.new-note, the registry created the note, the final text acknowledged it, and the act line rendered.` /
  `PASS: worker e2e — build, wrangler dev, streamed turn, seam discipline, auth journey, $0 pause, approval round trip, reco seam, admin journey, non-admin undetectability, agent tool loop.`
- `rg useEffect src` → no matches in application code.

## Contract deltas found while reading the landed sibling code

1. **The deployed Worker's turn pass-through dropped every frame's turn identity.** The upstream
   wire frame carries no `runId` (the dev boundary's CloudAgent adds it on publish), and the
   client stream reader drops frames that don't name their turn — every pure-web turn through the
   deployed Worker would have stalled. Fixed in `62a2060` (the Worker stamps the runId on every
   frame now), caught by driving the real client against `wrangler dev` instead of trusting the
   raw-NDJSON assertion.
2. **Stale-409 race on tool-loop continuations.** Both the Worker's cancel map and the WebAgent's
   active-turn map released a runId only when the stream lifecycle settled, so the continuation
   leg's re-POST of the same runId met "That Smithers turn is already running." Both now release
   at the terminal `done` frame, strictly before the client can act on it (`62a2060`).
3. **The chat tool-loop contract is only partially landed** (see §2): no `TOOL-LOOP.md`, no
   emitted `done.reason`, no enforced `CHAT_MAX_TOOL_LEGS`, no `id` on emitted `tool_call`
   frames. The client consumes `call_id` (what the code actually emits) and treats `reason` as
   optional.
4. **The goal doc's "workflows" tool is named `commands`** in the landed product contract
   (`agentTools.ts`) — kept as `commands`; renaming would churn the contract for no behavior.
5. **The reco affordance `command` strings** (`reco.feedback accept <id>` etc.) are the worker's
   own logging commands; the product maps accept/edit/dismiss to its `reco.*` commands, which post
   that feedback AND drive the product behavior (turn / composer / removal).
6. **The request-access queue does not drain on allowlist approval** — `allowlistApply` writes
   the entry + audit only; `listRequests` returns the queue regardless
   (`workers/identity/src/store.ts`). The queue card re-reads after approve and renders the
   server's truth; the test double was corrected to match (`fa7f8ea`).
7. **Admin-token failure shapes differ per sibling**: identity and reco 404 without the admin
   token, billing 401s. The product Worker's own admin surface uniformly 404s non-admins; the
   sibling passthroughs return whatever the sibling answered to an admin session.
8. **Concurrent in-tree wave:** the runtime-context wave (uncommitted at receipt time) adds an
   optional `context` field to the turn body, accepted by the Vite dev boundary and rendered into
   instructions by the bun CloudAgent. The deployed Worker's `handleTurn` does not forward
   `context` yet — when that wave lands, the Worker seam needs the same passthrough or the
   deployed app silently drops it.

## Deploy checklist — every env var the product Worker now reads

| Var | Seam | Unset behavior |
| --- | --- | --- |
| `SMITHERS_CHAT_URL` | chat turn upstream | defaults to `https://chat.smithers.sh/chat` |
| `SMITHERS_CHAT_ORIGIN` | chat upstream origin gate | defaults to `https://smithers.sh` |
| `GATEWAY_UPSTREAM_URL` | engine gateway (`/v1/*`, `/workflows/*`, approvals) | 501 |
| `GATEWAY_AUTH_TOKEN` | gateway service-token branch | falls through to the session branch; 501 if neither |
| `GATEWAY_SESSION_USER_ID` / `GATEWAY_SESSION_USER_ROLE` / `GATEWAY_SESSION_USER_SCOPES` | gateway trusted-proxy placeholder session | 501 if no auth branch |
| `IDENTITY_UPSTREAM_URL` | identity (`/api/auth/*`, `/api/identity/*`, session validation) | 501; admin surface 404s everyone |
| `IDENTITY_SERVICE_TOKEN` | product Worker → `/api/identity/validate` | validation degrades (billing 401s; admin 404s) |
| `IDENTITY_ADMIN_TOKEN` | identity `admin/allowlist` + `admin/requests` | admin allowlist/queue 501 (admin sessions only) |
| `BILLING_UPSTREAM_URL` | billing (`/api/billing/*`) | 501 |
| `BILLING_AUTH_TOKEN` | the Smithers Cloud user bearer billing authenticates with | 501 |
| `BILLING_ADMIN_TOKEN` | billing `admin/grants` | admin grant 501 (admin sessions only) |
| `RECO_UPSTREAM_URL` | recommendations (`/api/reco/*`) | 501; the first-run message says so honestly |
| `RECO_ADMIN_TOKEN` | reco `admin/feedback` | admin feedback 501 (admin sessions only) |

Deployment requirement carried from Wave 2a and now extended to reco: **this Worker's origin must
be listed in the identity, billing, AND recommendations workers' `ALLOWED_ORIGINS`** — the proxy
states its own origin on every sibling-bound request, and billing 403s a request that carries
none (the admin-health charges read states it too).

## Honest gaps

- **The tool loop is unproven against live chat.smithers.sh** — the server-side wave-4 pieces
  (emitted `reason`, enforced leg cap, `TOOL-LOOP.md`) have not landed; all loop proofs run
  against the documented frame contract via the labeled doubles.
- **The native Electrobun agent path drops `tool_call` frames.** `src/bun/CloudAgent.ts`'s frame
  parse handles delta/card/card.update/done only, so the desktop app's native transport ends the
  turn at `done` without executing the tool (graceful, but the loop is dead there). The fix is
  one `case` plus the `isFrame` widening — deliberately NOT made in this wave because the
  concurrent context wave has uncommitted edits in that exact file; it owns the merge.
- **Per-user billing is still unsolved** (carried from Wave 2a): balance reads use one
  deployment-wide bearer, and admin grants target `userId` = the GitHub login — billing's ledger
  keys the grant by that login, but no per-user read path exists to show its effect in-product.
  `admin.health`'s charge totals are the deployment account's.
- **The turn endpoint is still not gated server-side** (carried from Wave 2a): `/api/agent/turn`
  does not validate identity or balance; gating remains client-side.
- **Turn body cap vs. tool transcripts:** the 64 KB turn cap now also bounds the accumulated
  function_call/function_call_output items of a multi-leg turn; a long conversation plus several
  tool legs can 413 earlier than before. Bounded, honest (413 with a message), unmitigated.
- Reco/identity/billing integrations remain **unproven against the running services** — corrected
  to the landed source, proven against doubles that enforce the same origin/token gates.
- `admin.health` marks a service `unconfigured` when its upstream var is unset on the product
  Worker — it cannot distinguish "worker down" from "never deployed" beyond what healthz says.

## Review addendum (post-wave, commits `fc392b5`, `fa65c40`)

Two items above are now closed, and one statement in "Preflight" went stale. Recorded here rather
than edited in place, so the wave's own claims stay as they were made.

### `HEAD` did not compile (blocker, found by review)

The concurrent context wave's `src/shared/AgentContext.ts` was an intent-to-add (empty-blob) index
entry, so it was invisible to `git ls-files --others` and never committed — while every *importer*
of it (`src/shared/NativeAgent.ts`, `AppController.ts`, `AppStore.ts`, `src/worker/index.ts`) rode
into the wave-3b commits. Typechecking a detached worktree at `543a1d8` observed:

```
src/mainview/state/AppController.ts(30,47): error TS2307: Cannot find module '../../shared/AgentContext'
src/mainview/state/AppController.ts(31,42): error TS2307: Cannot find module '../../shared/AgentContext'
src/shared/NativeAgent.ts(3,42):            error TS2307: Cannot find module './AgentContext'
src/worker/index.ts(16,69):                 error TS2307: Cannot find module '../shared/AgentContext'
```

The gates were green in the working tree only because the file existed *on disk* there. `fc392b5`
lands the missing half byte-identically (module, boundary composition, five test files, the browser
e2e script); a detached worktree at `fa65c40` now typechecks clean. The "remains uncommitted and
untouched by this wave" line under **Preflight** is superseded by this.

### The native/dev tool-loop gap is closed (`fa65c40`)

The gap listed below as "deliberately NOT made in this wave" is fixed now that the file's other
owner has landed. It was wider than the one `case` the gap note estimated — `src/bun/CloudAgent.ts`
also never forwarded `request.tools` upstream, so on the native app and on `bun dev` the model was
never offered the `commands` tool at all, and a `done.reason: "tool_limit"` was stripped to a bare
`done` (surfacing the wrong "Smithers Cloud returned an empty response" instead of the honest cap
message `AppController` already had wired). All three are fixed; `src/bun/CloudAgentToolLoop.test.ts`
locks tool-spec forwarding, `tool_call` publication, `done.reason` carriage, and rejection of a
foreign `reason`. `src/server/AgentApi.ts` also now applies the Worker's non-array-`tools` guard,
and `scripts/web-chat-context-e2e.ts` is registered as `test:e2e:web:context` rather than an orphan.

Gates after both commits: `bun test src` **140 pass / 0 fail** (19 files, 514 expects),
`bun run typecheck` clean, `bun scripts/worker-e2e.ts` **PASS** (all 17 `ok:` lines).

Still open and unchanged: the loop remains proven against the documented frame contract and the
labeled doubles, not a live chat worker.
