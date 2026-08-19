# Root causes already diagnosed — read before fixing anything

Traced in the source on 2026-08-19 against the live canary build
`assets/index-BHHXuMoZ.js`. Do not re-derive these; spend your time on the fix
and its test. Ordered by user impact.

---

## 1. SYSTEMIC: every "renders nothing" row is ONE bug

Explains rows **7.7** (a 404 upstream renders no card, no transcript line, no
toast, only a console error), **13.4** (`/issues.view 99999` produces nothing),
**14.3** (`/prs.create` both forms completely silent), **5.11** (malformed
arguments refused silently), and the pre-import shape of **13.7**.

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
