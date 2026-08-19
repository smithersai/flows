# Root causes already diagnosed — read before fixing anything

Traced in the source on 2026-08-19 against the live canary build
`assets/index-BHHXuMoZ.js`. Do not re-derive these; spend your time on the fix
and its test. Ordered by user impact.

---

## 1. SYSTEMIC: every "renders nothing" row is ONE bug

Explains **at least fourteen** separately-reported rows across seven lanes. This
is by far the highest-leverage fix in the run: one contract change closes roughly
a quarter of every failure found. The rows:
**7.7** (a 404 upstream renders no card, no transcript line, no toast, only a
console error), **13.4** (`/issues.view 99999` produces nothing), **14.3**
(`/prs.create` both forms completely silent), **5.11** (malformed arguments
refused silently), **15.2** (`/files.list does/not/exist` renders nothing),
**15.7** (`/env.set oops-no-equals` says nothing at all), **18.5**
(`/keys.remove` with no key is silent), **13.4**'s sibling shapes, and the
pre-import shape of **13.7**, and the entire §26 debug family — **26.2**
(`/debug.snapshot`), **26.3** (`/debug.events`), **26.4** (`/debug.chain`),
**26.5** (`/debug.net`) and **26.6** (`/debug.grants.reset`), each of which
"runs but renders nothing": cards 10 -> 10, messages 14 -> 14, zero new body
text, while the underlying work actually executes.

The §26 rows are the clearest proof of the diagnosis: those flows do their job
and return their answer as a string, and the user sees nothing at all. Fixing
this one contract closes all fourteen; fixing them individually would be fourteen
patches over the same hole.

The chain:

1. Seams report failure by **returning an honest error string**. `SeamContext.ts`
   states this in its own header: seams "answer the command contract — an honest
   error string, or void on success". Example, `IssuesSeam.ts:174`:
   ```ts
   return readErrorMessage(response, `Listing issues for ${repo} failed (${response.status})`)
   ```
2. That string is the flow handler's **return value**, so the Effect *succeeds*.
   `Commands.ts:149-154`:
   ```ts
   const result = settled.success
   if (result.outcome === "failure") return { status: "failed", error: unframe(name, result.message) }
   const value = valueOf(result.value)
   return value === undefined ? { status: "executed" } : { status: "executed", value }
   ```
   An honest seam error therefore arrives as `status: "executed"` with the
   message sitting in `value`.
3. `AppController.surfaceCommandFailure` discards it:
   ```ts
   const surfaceCommandFailure = (name, outcome) => {
     if (outcome.status !== "failed") return   // <-- the message dies here
     ...toast...
   }
   ```

So the product computes a correct, user-ready error message and throws it away.

**Fix guidance.** Do NOT simply render `value` on `"executed"` — a successful
flow may legitimately return a value, and turning every success string into an
error toast is a new bug. The defect is that a seam's failure is
indistinguishable from a success value at the flow boundary. Make failure
explicit: either seams return a typed/discriminated failure that maps to
`result.outcome === "failure"`, or the flow handlers translate a returned string
into an Effect failure at that one boundary.

**Test.** For issues, landings and files seams: an upstream 404/500 produces a
user-visible surface carrying the seam's message, and a successful call with a
return value produces no failure surface. Extend `IssuesSeam.test.ts` and
`LandingsSeam.test.ts`.

### 1b. The dominant path, found independently by the flow-sweep lane (23 rows)

The flow-sweep agent traced this further than the analysis above and its version
is more precise. There are TWO discard points, and this is the bigger one:

- `send()` (`AppController.ts:2317`) runs a typed slash flow as
  `void commands.run(name, args)` and **discards the CommandOutcome entirely** —
  it never reaches `surfaceCommandFailure` at all.
- The button path (`runCommand` / `runCommandArgs`, ~`4363`/`4369`) DOES attach
  `surfaceCommandFailure`.
- `App.tsx:625` routes Enter to the button path **only while the slash menu is
  open**, and the menu matches a **BARE name**.

Consequences, exactly as measured:
- `/issues.view` (bare) toasts an honest refusal — the menu was open, so the
  button path ran.
- `/issues.view 999999 owner/repo` (with arguments) renders **absolutely
  nothing** — the menu did not match, so `send()` ran and ate the outcome.
- Hidden, id-scoped flows never match the menu, so they are silent on **every**
  failure.

That explains why the same flow behaves honestly with no arguments and silently
with arguments, which no single-discard theory accounts for. Fix BOTH: route the
composer-submit path through the same failure surfacing as the button path, and
make the seam-failure contract explicit (analysis above). The flow-sweep lane
attributes **23 rows** to this cause.

Also from that lane: asked to stop the response, the model replied
**"Okay, I've stopped."** while the underlying tool call had FAILED — a fake
success generated by the model on a discarded failure. Silent failures do not
just hide from the user; they actively cause the model to lie.

---

## 2. Row 4.6 — `/retry` duplicates the user message

`AppController.retryLastTurn`:
```ts
const prompt = [...store.collections.messages.values()]
  .filter((m) => m.role === "user")
  .sort((l, r) => r.ordinal - l.ordinal)[0]?.text
if (prompt !== undefined) send(prompt)   // send() APPENDS a new user message
```
Retry re-*sends* rather than re-*runs*, so each retry appends another user
bubble. The chat lane measured `[data-role="user"]` going 1 → 2 → 3.
It must re-run the last turn without appending a second user message.

---

## 3. Rows 5.1 / 5.6 — the slash-menu cap is bypassed

Introduced by `12018780` ("name the flow you typed"), whose exact-name
precedence is correct and must be preserved. In `registry.ts`:
```ts
const nameRank = (command, query) => { if (query === "") return 0; ... }
const kept = (item) => item.recommended || nameRank(item.flow, query) <= 1
const survivors = ordered.filter(kept)
const room = Math.max(SLASH_MENU_CAP, survivors.length) - survivors.length
```
On a bare `/`, `query === ""` so `nameRank` returns 0 for **every** command,
`kept` is true for all 65, `room` computes to `max(8,65) - 65 = 0`, and
`SLASH_MENU_CAP` is bypassed entirely. Live counts confirm the math: `/` → 65
items (menu 2073px tall in a 1000px viewport, `top: -1114px`), `/a` → 13,
`/re` → 10.

**Fix.** The "never cut what the user named outright" exemption must only apply
when the user actually named something; an empty query names nothing. Either
make `nameRank` distinguish "no query" from "exact match", or require
`query !== ""` for the rank branch of `kept`.

**Test** all three: bare `/` yields at most `SLASH_MENU_CAP`; a typed exact name
is never cut; a typed prefix match is never cut. Also check whether
`overflow-y: visible` and the negative `top` on `.slash-menu` are independent
CSS bugs or just consequences of the height.

---

## 4. Row 10.8 — World content never reaches the model

`AppController.agentRuntimeContext()` includes only:
```ts
selectedWorldDocument: selected?.path ?? null,
```
The **path**, never the **body**, and only for the *selected* note. The model is
told which note is open and nothing about what any note says. Proven end to end:
a note containing `zarquon-mimsy-7741` persisted (10.5 passes), then the model
could not answer what the codeword was.

This needs a design decision, not just a patch. The World is sold as "what
Smithers understands"; if its content never reaches the model the feature is
decorative. But stuffing every note body into every turn is a token-budget
problem. Options: send the selected note's body under a character budget plus
other notes' titles; send all bodies up to a budget with an explicit truncation
marker; or expose the World as a **tool** the model reads on demand (most
token-honest, fits "flows are the app", but then the model must be told the tool
exists). Acceptance test is the lane's own method, with a fixture rather than a
live model call.

---

## 5. Row 13.7 — FAKE SUCCESS on writes (highest severity)

`codeplanesmithers` has read-only access to `octocat/Hello-World`. After import,
`/issues.create <title> octocat/Hello-World` returns a DONE card reading
"Issue #3 — octocat/Hello-World … OPEN … opened by codeplanesmithers", and a
GitHub search for that title returns **zero** results. The write landed in the
jjhub **mirror** of someone else's repository; the tell is that mirror numbering
restarts at #1 while the real repo is at #10897. `/issues.close` reports CLOSED
the same way. Run the same writes before the import completes and they are
silent instead.

The product tells a user it created an issue on a repository they cannot write
to. For a product whose stated bar is never claiming work it did not do, this is
the worst failure mode available, and worse than a crash because the user
believes it.

**Fix must establish:** authorization checked against the user's real GitHub
permissions on the **upstream** repo before touching any mirror (an importable
repo is not a writable repo); a mirror write that cannot propagate upstream is
never reported as upstream success (if mirror-local writes are legitimate, the
card says so plainly); "still importing" is an honest answer where silence is
not. Regression coverage: a write to a read-only repo produces a refusal, and no
card ever reports an upstream issue number that does not exist upstream.

---

## 6. §18 — the BYOK provider-keys feature is not wired on canary

The money lane found the whole feature dead at the routing layer, not the UI:

- `GET /api/user/byok-keys` answers **404 "404 page not found"** on canary (the
  product Worker forwards it to an upstream that does not serve it).
- `DELETE /api/user/byok-keys/anthropic` answers the same 404, and the UI shows
  nothing at all — no card, no toast (row 18.3).
- `/keys.remove gemini` with no key is completely silent (18.5).
- No add-key surface ships at all, so 18.2 (validate before save) and 18.4
  (invalid/revoked key error path) have nothing to grade.

So five checklist rows describe a capability that has no working route. Decide
which this is before "fixing" it:
1. the feature is meant to ship for the alpha and the Worker route/upstream is
   simply missing or misconfigured — then wire it and the UI surfaces follow; or
2. the feature is deliberately post-alpha — then the flows (`keys.list`,
   `keys.remove`) should not be registered and offered to users, and §18 should
   be marked out of scope in the checklist rather than reported as failing.

Either way the current state is the worst of both: the flows are registered and
invocable, and invoking them does nothing visible. Note 18.5's silence shares
root cause #1 above.

## 7. Row 17.4 — checkout is exposed to an MVP account

Typing `/billing` as `codeplanesmithers` (allowlisted, MVP) reaches a checkout
surface. The checklist bar (and `wrangler.jsonc`'s own comments) say no
top-up/checkout/card-collection flow is exposed to MVP users. `billing.upgrade`
and `billing.portal` are registered flows; either gate them behind a plan the
MVP account does not have, or unregister them for MVP sessions.

---

## 8. Row 22.7 — the model contradicts its own tool result in the same turn

Asked "What is my balance right now?", the model answered **"Your current
balance is $0.00."** one line above the balance card that its own
`billing.balance` call had just rendered reading **"$519 left."** — with the
corner chrome also showing $519 and `GET /api/billing/balance` returning
`totalUsd: "519"`. Reproduced on four consecutive turns across two different
real balances ($505 and $519 eras), so it is not a cache or a race.

This is the honesty bar failing at its most visible point: the model states a
number the product is simultaneously displaying as something else. The likely
cause is that the flow's result is not being fed back into the model's context
before it composes its reply (the card is rendered to the DOM but the tool
result never reaches the turn), so the model answers from a prior or default
state. Check the tool-loop round trip in `ToolLoop`/`AppController` — whether a
flow invoked by the model returns its value into the conversation, or only
side-effects a card. A model that can invoke a flow but cannot read its result
will confabulate on every data question, not just balance.

Test with a fixture: a flow returning a known value, then assert the model's
next message can state that value.

## 9. Row 22.6 — an honest refusal points at a remedy that hangs

The push/PR refusals correctly say they cannot do it and offer "I can start a
workflow that proposes the change". Taking that offer: `/flow.create` renders
the repo chooser, accepts the choice, then **"Preparing your
codeplanesmithers/canary-sandbox workspace…" stands past 120s** with no run
card, no timeout and no error. `POST /api/workflow/provision` never answers
(measured from the page: 20002ms, signal timed out).

Two defects in one row. First, provisioning hangs — likely related to agents
being dark in prod (`feature_flags.agents=false` because no agent VM snapshot is
promoted), in which case provisioning should REFUSE immediately and honestly
rather than hang. Second, and independently of the cause: a request that never
answers must still surface a timeout to the user. A spinner that runs forever is
the silent-failure family again (root cause #1), just with a different shape.

An honest refusal that names a next step which does not work is worse than no
next step, because it spends the user's trust twice.
