# Wave 10 — Receipt: onboarding chooses the repos, in the conversation. Admin-only refresh. The trigger axis.

2026-08-09 (UTC) · run `oneshot-wave10-rulings` · branch `oneshot-mskp7qe7-work` (~/mvp)

**Bottom line:** Smithers no longer watches all repos by default. The first signed-in visit opens ONE question — a repo-chooser card in the transcript (keyboard-complete, select-all/none, one confirm) — and the digest reads only the chosen set; changing it later is "just ask" (`repos.watch`, three-way: card, slash, agent tool). Pills are command bindings (the slop pills are deleted), the bare reset is admin-only (`/clear` sweeps into world first for everyone), the trigger axis keeps browser mechanics out of the model's reach, tool acts never render raw payloads, sign-in IS the GitHub connector, the connect surface is extension-store grammar, the composer shows no standing status chrome, and the browser + debug tools landed. Deployed as `smithers-mvp-web` version **`49ffc51d-705b-4d44-adf1-82e2f1fc9c3b`**, live-verified signed-out AND signed-in (real OAuth profile) on canary.

Preflight: two pre-existing untracked goal files (`.smithers/goals/wave10-onboarding.md`, `wave11-workflows-in-chat.md` — concurrent sessions on the shared jj tree) were snapshotted in their own commit `4b9e1e2` before any goal work.

The backend contract is wave-10b's LANDED code (`flows/ui/WAVE10B-WATCHED-REPOS-RECEIPT.md`): `GET /api/reco/repos`, `GET/PUT /api/reco/watched` (`via: onboarding|command|agent`), `first-run` → `{needsSelection, candidates}` until a selection exists. The stub honors it exactly; the live checks below ran against the real deployed reco worker.

## What landed, by ruling

### 1. The onboarding conversation
- `needsSelection` from first-run dispatches `reco.selection.needed`: a short welcome ("before I read anything, choose which repositories I should watch") plus the **repo-chooser card** embedded in the transcript — candidates (name, private badge, freshness, open-issue count), type-to-filter, arrows/Space/Enter, All/None, one confirm. Never a takeover.
- Confirm → `PUT /api/reco/watched` with the card's `via` → the one calm line ("Watching 2 repositories: …. You can change this anytime — just ask.") → the scoped digest + one recommendation arrive (`withToast`, the wave-9 300ms law). A failed PUT leaves the chooser open in honest error, retryable.
- `repos.watch` is the registered command, three-way: the card's confirm, `/repos.watch` (reopens pre-filled from `GET watched` + `GET repos`, `via:"command"`), and the agent tool ("watch my flows repo too" → pre-selects, `via:"agent"`). An unknown pre-select is stated honestly and the chooser still opens.
- Chose-zero renders the seam's honest `emptySelection` state, never a fabricated digest. The selection is mirrored locally (`watchedRepos` collection) so the chooser pre-fill, the command state (`needsSelection`), and the agent context stay truthful.
- The chooser is onboarding's only question — nothing else asks anything derivable from GitHub.

### 2. Admin-only refresh
- `reset` moved into the admin plugin (registered only for `admin:true`, trigger `user`); the corner reset button renders only for admins. Non-admin: absent from the registry, `/` results, the DOM manifest, and the agent tool list; `/reset` resolves as `unknown-command` exactly like a typo. Enumeration/parity tests extended.

### 2a. Deterministic affordances never route through the model
- The `suggest` command and the `actions` collection (the fabricated-prompt mechanism) are **deleted**. `ActionSchema.prompt` is gone; `Suggestion` is `{label, command, args?}` — a binding. The pill row is derived in render: the gold reco binding when a recommendation waits, else the genuinely-next step (signed-out → Sign in; needsSelection → Choose repos), else EMPTY. The `plan` command (a hardcoded prompt) is deleted too.
- The parity gate gained the §2a/§2f rule: banned slop literals, no `prompt:` pill shape, `data-command={suggestion.command}` binding, no `statusText=`.
- **Announce = invoke:** the system prompt now states act-don't-narrate verbatim-intent (announcing without the tool call in the same turn is a truth violation) and the embed law (answer in the chat; your invocation renders the embedded card; maximizing is the user's act alone).
- **The trigger axis:** `CommandMeta.trigger: user | agent | both` (default both). `auth.sign-in/out`, `reset`, `theme`(+alias), `chat.stop`(+alias), `send`, `copy-message`, `toast.dismiss`, `repos.watch.toggle/all/none/confirm`, `card.maximize/minimize` are `user`. The agent tool projection filters them from `list`; an `execute` for one returns an honest error naming the visible alternative ("sign-in is a button the human clicks…"). Tests pin both ends.

### 2a″. The auth gate is pre-model
Wave-9's client-side gate matches the law (the signed-out/non-allowlisted send short-circuits before any backend call); pinned harder here: a signed-out send produces zero `startTurn` calls (unit) and zero turn POSTs (worker e2e, carried from wave 9), the deterministic reply rides the real sign-in action.

### 2a′. Sign-in IS the GitHub connector
- `AgentRuntimeContext` gains `github: {connected, login, watchedRepos: n | "unselected" | null}`, rendered into the hidden context ("repo work routes to the chooser, never to a sign-in they already have"). `CommandState.hasConnectors` unifies: signed-in ⇒ connected.
- The connect surface's GitHub row reads **Connected ✓ as \<login\>** for a valid session; Connect only when signed out (→ `auth.sign-in`).

### 2b. Tool acts never render raw; the admin dev-tools panel
- The act-line renderer is rewritten: `list` → "Smithers checked what it can do here"; browser → "Smithers read \<host\>"; failures are one payload-free line (a result that looks like JSON becomes "that didn't work"). Every tool act is ALSO recorded full-fidelity (`toolCalls` collection, actor smithers). Regression test: no `{"state":` can reach transcript text.
- **`admin.devtools`** (admin registry only) + `⌘/Ctrl+Shift+D` toggles the right-side dev-tools panel — chat-attached chrome, absent (not hidden) for non-admins: the tool-call stream with full arguments/results, the live registry with trigger axes, the state snapshot, session facts.

### 2d. `browser` and `debug`
- `browser <url>` (trigger both): `POST /api/tools/browser-fetch` on the product Worker (and the vite dev boundary) via a shared isomorphic handler — https only, public hosts only after DNS resolution AND on every redirect hop (DoH in workerd, `node:dns` in dev), 1 MB cap, 10s timeout, no cookies/credentials, `user-agent: smithers-browser`. SSRF guard cases pinned (127.0.0.1, 169.254.169.254, internal hostnames, redirect-to-private, IPv6 forms). The agent's invocation gets the extracted text as the tool result; the transcript carries only "Smithers read \<host\>".
- The browser card (§2d′) embeds the page in an iframe with the URL visible; a site refusing framing (X-Frame-Options / CSP frame-ancestors, detected server-side) gets the honest blocked state + "Open in a new tab" — never a silent blank.
- `debug.snapshot` / `debug.events` / `debug.seams` (admin registry, trigger both): one typed read surface the panel renders and the agent invokes; `admin.health` is now a view over the same read (`debugSeams` drives it). Non-admin: absent everywhere (registry, DOM, tool catalog; the `/api/admin/*` 404-shape discipline unchanged).

### 2d′. The maximize transition
Every card header carries maximize/minimize (trigger `user` — the agent structurally cannot). Maximizing is a real presentation transition of the SAME element (no re-mount — the test pins node identity): `data-maximized` flips the card to fixed full-viewport with a 180ms scale/translate morph + backdrop; `prefers-reduced-motion` gets a fade-only fallback (no transform). Escape or the minimize button reverses it. State rides the dispatcher (`card.maximized`/`card.minimized`, journaled).

### 2c″/2c. The embed law in-app; toggles toggle
- The agent's `world`/`connect` invocations upsert embedded `world`/`connect` cards (actor smithers) — `session.surface` never changes (journey test through the tool double: "what is in world?" → answer + embedded card, surface stays chat).
- The user's `world`/`connect` now TOGGLE: invoking the open pane's command returns to chat (both directions tested, `aria-pressed` reflects state).

### 2c′. Composer toolbar dropdown
The surface buttons collapsed into ONE compact dropdown (the `ComposerMenu`): opens on click/ArrowDown/Enter/Space, arrows move, Enter invokes, Escape closes; entries are direct command bindings, state-aware. `/` remains the full surface.

### 2e. The connect surface, store grammar
Rewritten: compact rows — icon, name, ONE line, one action (Connect / Connected ✓ as \<login\> / Coming soon) — keyboard-complete (arrows between rows, Enter is the row's action). The local-repo row is absent on web (native-only path). Connected repos keep their downgrade/remove rows. The pane remains for the user's toggle this wave; the agent gets the embedded card form. **Follow-up (noted, not done):** converting the user-facing pane itself to an embedded card per the one-page direction.

### 2g/2f. Calm composer; no slop
The persistent status line ("Smithers Cloud · live", the $0 free-chat sentence) is deleted — healthy renders nothing; a turn that cannot start still says so at that moment. The slop pills ("Build my work queue", "Plan my day", …) and their mechanism are gone; the gate greps for them.

### 2h. `/clear`
Sweeps the outgoing transcript over the comped chat path (dedicated sweep instructions → strict JSON notes), applies each as a world note (`sources: ["chat-sweep"]`, actor smithers, model-stated confidence), THEN clears and states it: "Saved 2 notes to World. Cleared." A failed sweep leaves the chat UNcleared with the honest line (tested). Ordering sweep→world→clear is pinned by journal revisions. `WORLD_DISPLAY_NAME` (AppState.ts) centralizes the display name for the pending rename — every label/summary/confirm reads it; `world` stays the internal id. The bare `reset` stays admin-only, no sweep.

## Proofs

**Local:** `bun test src` **249/249** (new: `Wave10.test.ts` — chooser flow via/confirm/scoped-digest/failure, agent three-way, embed-law journeys, transcript hygiene, /clear ordering + failure, browser tool, sign-in-is-connector, debug reads; `Wave10Chat.test.tsx` — derived pill row (empty is correct), chooser DOM + keyboard map, admin-only absence in the DOM, maximize element identity, pre-model auth gate; `BrowserFetch.test.ts` — SSRF guards, caps, extraction, frameability; worker route tests; extended registry/parity gates) · `bun run typecheck` clean · `bun run build` clean · `bun scripts/worker-e2e.ts` **PASS** — new journeys: the full onboarding flow driven by the REAL client against the stub stack (needsSelection → chooser → toggle/confirm → `via:"onboarding"` PUT observed at the stub → scoped digest → confirm line; non-admin `/reset` → unknown-command), and the agent-tool selection change through the armed tool-loop upstream (embedded chooser, `via:"agent"`, surface never changed, act line compact) · `bun scripts/live-check.ts local` **PASS 5/5**.

**Live (https://canary.smithers.sh, version `49ffc51d`):**
- `bun scripts/live-check.ts live` — **PASS** (signed-out chat stands, sign-in → github.com authorize, branded failed-callback page, JSON probe; screenshots `reports/live-checks/2026-08-09_21-58-45/`).
- `bun scripts/live-signed-in-check.ts` (new, the sanctioned persistent profile `codeplanesmithers`, real session cookie) — **PASS 9/9** (screenshots `reports/live-checks/2026-08-09T21-58-51-signed-in/`): the selection wave-10b recorded (3 repos, `via:"agent"`) is honored — NO chooser, the scoped digest opens the chat ("5 open issues and 1 open pull request across 3 repos", matching the wave-10b live numbers), the gold pill is the real recommendation's binding, no slop pills, no status chrome, no reset/devtools for this non-admin, zero console errors.

## Review pass (post-landing, same run)

A review of the landed diff found and fixed four things:

- **SSRF: bracketed IPv6 literals walked straight past the browser tool's guard.** A URL's `hostname` keeps IPv6 literals bracketed (`[::1]`), and the WHATWG serializer writes IPv4-mapped addresses in hex (`https://[::ffff:127.0.0.1]/` → hostname `[::ffff:7f00:1]`). `isPublicAddress` compared the raw bracketed string, so `[::1]`, `[fd00::1]`, `[fe80::1]` and every mapped form were judged public and fetched — the guard only ever held for IPv4. Fixed: brackets and zone ids are stripped before judging, IPv4-mapped addresses are decoded in both notations, and every other IPv6 form is now **default-deny** — only global unicast (`2000::/3`) passes, which refuses `::`, `::1`, `::7f00:1`, `fc00::/7`, `fe80::/10` and `ff00::/8` without enumerating them. Regression tests pin each form *and* that no fetch is attempted.
- **`frame-ancestors` was read as a denylist, so named-origin sites framed blank.** `frame-ancestors https://partner.example.com` passed the old `includes("https:")` check → `frameable: true` → a silent blank iframe, exactly what §2d′ forbids. It is an allowlist: unless the directive admits any origin (`*`, `https:`, …) the card now shows the honest blocked state + "Open in a new tab".
- **NO INVENTION strikes.** The chooser row carried a `private` badge and the browser card an `HTTP <status>` badge — neither is named by the brief (§1 enumerates name, freshness, open-issue count; §2d′ asks for the frame with the URL visible). Both removed; `private` stays on the wire contract, unshown.
- Housekeeping: a mangled `host.use(TURN_PATH, …)` line in `AgentApi.ts` and a dead `const commands = innerCommands` alias in `AppController.ts`.

Re-verified after the fixes: `bun test src` **252/252**, `bun run typecheck` clean, `bun run build` clean, `bun scripts/worker-e2e.ts` **PASS**.

**The deployed canary version `49ffc51d` predates these fixes** — the live `/api/tools/browser-fetch` still carries the IPv6 guard hole until the next deploy.

## Honest gaps

- **The chooser's live appearance for a selection-less account is stub-proven, not canary-proven.** The canary account has a selection (wave-10b left all 3 repos watched); wiping it to watch the chooser open would mutate shared prod state. The stub honors the landed wave-10b routes exactly (including the one-round-trip `needsSelection` shape), and the selection-exists path IS live-proven.
- **The connect/world PANES still open for the user's own invocation** (§2c kept the takeover→card conversion out of scope; the toggle is the landed honesty fix). The agent's forms are embedded cards; the user-pane conversion is the named follow-up.
- **The maximize morph is a CSS keyframe transition on the real element, not a measured FLIP from the card's exact in-transcript bounds** — same node, no re-mount, visible transition, reduced-motion fade (the pinned contract). Exact-bounds FLIP is a refinement if will wants the card to fly from its slot.
- **The dev-tools panel's seam section shows session/state facts live**; the seam probes render through `admin.health`/`debug.seams` on demand (a standing auto-probe would be a background poll nobody asked for).
- `debug.*` events cover the transition journal tail (40); deeper time-travel UI stays with the smithers CLI.
