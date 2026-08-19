# The hermetic e2e harness (`apps/ui/e2e/`)

A suite here drives the real product — the built SPA, the deployable Worker
under `wrangler dev`, and the app's own `AppStore`/`AppController`/`WebAgent` —
against the test doubles in `../scripts/stub-backends.ts`. Nothing contacts the
internet, nothing spends a model credential, and nothing needs a deployment.

Run it:

```
bun e2e/run.ts                    # every suite
bun e2e/run.ts --suite E1.9       # one suite, by id or filename substring
bun e2e/run.ts --list             # id, phase, order, file
bun e2e/run.ts --skip-build       # reuse the dist/ you already built
bun e2e/run.ts --phase A          # only the unconfigured-seam suites
bun e2e/run.ts --port 8799        # a port of your own; $FLOWS_E2E_PORT also works
```

`package.json` exposes `test:e2e`, `test:e2e:list`, and `test:e2e:all` (the
landed `scripts/worker-e2e.ts` suite, then this one).

## What a lane owns

One file, `e2e/suites/<name>.e2e.ts`, default-exporting one suite. Nothing else.
The runner discovers suites from the filesystem, so there is no registry to edit
and no file two lanes both touch.

```ts
import { defineSuite } from "../Suite.ts";
import { openClient } from "../Client.ts";

export default defineSuite({
	id: "E1.9",
	title: "sign-out and session expiry are conversation states",
	run: async ({ origin, stack, report }) => {
		const cookie = await stack.signedInCookie();
		const client = await openClient({ origin, cookie });
		await client.controller.loadSession();
		report.equals(
			client.store.collections.identitySessions.get("identity")?.state,
			"signed-in",
			"the client did not record the signed-in session",
		);
		report.ok("a signed-in cookie resolves to the signed-in conversation state.");
	},
});
```

Fields: `id`, `title`, `run`, and optionally `phase` (default `"B"`), `order`
(default `0`, sorted ascending inside a phase) and `browser` (default `false`).

## The two phases

| Phase | Boot | Use it for |
| --- | --- | --- |
| `A` | every backend seam sealed empty | the honest 501s, the isolation headers, the cross-origin 403 |
| `B` | every seam pointed at a double | everything else |

The stack boots **once per phase** and every suite in that phase shares it, so
fourteen suites cost the two wrangler boots and one vite build that
`scripts/worker-e2e.ts` costs today. Phase B runs first; a phase with no
selected suite is never booted.

## Isolation between suites

The runner calls `stack.reset()` before each suite. Reset recreates the
identity, billing and reco doubles (a drained balance, a flipped allowlist, an
armed degrade mode and a stale watched selection all disappear with them),
clears every front override, resets the chat and model doubles, puts the gateway
back to capacity/lively/cloud-repo, and forgets the memoized cookie.

Two things reset does **not** undo:

- **The gateway double is not recreated.** The Worker's `GATEWAY_SESSIONS`
  Durable Object caches each provisioned gateway's `base_url` per (login, repo),
  so a recreated gateway would be resumed on a dead port. Its counters
  accumulate within a phase: assert deltas off `GET /stub/relay-state`, and
  provision under a repo name unique to your suite (`will/e2e-<lane>`).
- **The reco double's feedback log has no clear control.** Assert on the last
  entry, never on the log length.

## Adding routes, faults and delays: the front

Every double sits behind a `Front`, a reverse proxy the Worker's
`*_UPSTREAM_URL` points at. A suite programs its front at runtime, so no suite
ever edits `scripts/stub-backends.ts` — a file every other suite shares.

```ts
stack.fronts.identity.handle("POST", "/api/auth/native/start", () =>
	Response.json({ handoffId: "h-1", authorizeUrl: "https://github.test/login" }),
);
stack.fronts.identity.failOnce("POST", "/api/identity/validate", 401);
stack.fronts.gateway.dropOnce("GET", "/api/gateways/*");   // a network drop
stack.fronts.reco.delay("/api/reco/first-run", 800);       // until cleared
stack.fronts.billing.requests();                            // what reached the double
```

A registered path matches exactly, or by prefix when it ends with `*`. A handler
returning `undefined` falls through to the double. Everything a front holds is
dropped by the next `reset()`.

If a double genuinely lacks a control you need, register it on the front. Do not
edit `scripts/stub-backends.ts`, and do not edit `scripts/worker-e2e.ts`: that
suite is landed and goes to CI unchanged.

## Scripting the model

`stack.chat` is the chat upstream double. Turn N uses `scripts[N]` while one
exists, then the last one repeats, so a two-element array is exactly the
tool-loop shape.

```ts
stack.chat.script({ frames: [{ type: "delta", kind: "text", text: "hi" }, { type: "done" }] });
stack.chat.script({ status: 500, body: "upstream on fire" });   // a failed turn
stack.chat.script(toolLoopScript({ callId: "c1", name: "world.new-note" }, (out) => `done: ${out}`));
stack.chat.slow();                                              // 32 deltas at 250ms — killable
stack.chat.requests();                                          // what the Worker forwarded
```

`stack.chat` also stands in for the model relay's upstream. `/api/model/stream`
forwards to the SAME managed-inference upstream `/api/agent/turn` does, so one
double serves both routes and `requests()` sees every model call the Worker made.

## Driving the real client

`openClient({ origin, cookie })` builds the product's own store and controller
over an injected fetch that attaches the cookie to same-origin requests and
records every call.

`openClient({ origin, cookie, backend: "chain" })` builds the product's SHIPPING
wiring instead: the agent seat plus the chain runtime, authoring over
`/api/model/stream` exactly as `main.tsx` composes it. Script the chat double
with a fenced `flow` block and the chain runs it in process. The default,
`"proxy"`, drives the `/api/agent/turn` seam the Worker still serves for the
terminal client and the native shell — which is what most suites here were
written against.

**Never assign `globalThis.fetch`.** `AppController` and `createWebAgent` both
accept a `fetchImpl`, and nothing else under `src/mainview` touches the global.
A suite that patches it corrupts the stack for every other suite.

**Import `src/mainview/native/NativeBridge.ts` with `import type` only.** It
reads `window.__electrobun` at module scope and throws under bun.

## Driving a page

Set `browser: true` and use `ctx.browser`. It drives a system Chrome over CDP —
no Playwright, no download. When the machine has no Chrome the runner prints
`skip: <id> — <reason>` and counts the suite as skipped, never as passed.

```ts
const session = await browser.open(cookie);
await session.viewport(390, 844);
await session.media("prefers-reduced-motion", "reduce");
const text = await session.page.text();
session.consoleErrors();
```

`session.page` is the checklist's `ProbePage`, so the predicates in
`src/launch-checklist/Probes.ts` (`waitForText`, `sendPrompt`, `replyRegion`,
`hasSmithersMessage`, `REGISTERED_COMMANDS`, …) work unchanged. Use them rather
than writing new ones: a hermetic assertion and its canary row then stay in
lockstep by construction. `Page.navigate` resolves before React mounts, so wait
for content — `waitForText(session.page, hasSmithersMessage, …)` — instead of
reading `text()` once.

## House rules

- One `ok:` line per proven outcome, and say what was proven, not what was called.
- Every assertion throws `SuiteFailure`; the runner records it and continues to
  the next suite, so one lane's regression never hides thirteen others.
- Never weaken or delete an existing test.
- Tabs, Google developer-docs register, short declarative sentences.
