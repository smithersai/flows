# Round 3 canary certification report

**Target:** https://canary.smithers.sh (Cloudflare Worker `smithers-mvp-web`)  
**Build under test:** `4dc40043aa34530d32481114376aaedea67b4fc9`, bundle `/assets/index-CLjr2OeT.js`  
**Graded:** 2026-08-20, run `run-1787240734197` (workflow `canary-round3`)  
**Verdict: NOT-CERTIFIED**

The aggregator independently confirmed the live origin's build marker before writing this report:
`curl -s https://canary.smithers.sh/` returns `<meta name="smithers-build-sha" content="4dc40043aa34530d32481114376aaedea67b4fc9">` and preloads `/assets/index-CLjr2OeT.js`. That is the same build every lane reported driving, so all eleven lanes graded the current deploy.

---

## 1. Lane liveness — all eleven lanes produced rows

Round 2's verification lanes died on infrastructure and were invisible in its totals. That did not happen here. Every one of the eleven lanes reached `finished` and emitted a row set. No lane is missing, and no checklist section is empty.

| Lane | Node state | Wall clock | Rows | Pass | Fail | Blocked | N/A | Untested |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `lane-access` | finished | 29m | 23 | 14 | 3 | 5 | 1 | 0 |
| `lane-chat` | finished | 19m | 37 | 23 | 8 | 0 | 0 | 6 |
| `lane-cards` | finished | 10m | 36 | 19 | 7 | 0 | 0 | 10 |
| `lane-surfaces` | finished | 33m | 23 | 17 | 2 | 0 | 4 | 0 |
| `lane-github` | finished | 20m | 21 | 12 | 8 | 1 | 0 | 0 |
| `lane-repo-data` | finished | 18m | 18 | 4 | 7 | 0 | 0 | 7 |
| `lane-money` | finished | 24m | 17 | 9 | 1 | 2 | 5 | 0 |
| `lane-appearance` | finished | 11m | 14 | 9 | 4 | 1 | 0 | 0 |
| `lane-honesty` | finished | 13m | 23 | 10 | 12 | 0 | 0 | 1 |
| `lane-admin` | finished | 35m | 38 | 21 | 9 | 1 | 7 | 0 |
| `lane-flow-sweep` | finished | 37m | 88 | 46 | 24 | 1 | 3 | 14 |
| **TOTAL** | | | **338** | **184** | **85** | **11** | **20** | **38** |

Each lane ran two attempts: attempt 1 was cancelled within ~400ms (an orchestration restart), attempt 2 succeeded. No lane lost work to that.

## 2. Totals

- **Total rows graded:** 338
- **PASS:** 184
- **FAIL:** 85
- **NOT-APPLICABLE:** 20 — rows targeting surfaces this web origin does not have. These do not count against the verdict.
- **BLOCKED-ON-HUMAN:** 11 — rows needing a credential or account only the owner can supply.
- **UNTESTED:** 38 — rows nobody drove to a verdict. See §5.

184 + 85 + 20 + 11 = 300. The remaining 38 rows are untested, not passed.

The row count is exactly 338, the same checklist round 1 graded, so the comparison in §4 is like-for-like.

## 3. Verdict

**NOT-CERTIFIED.** Two independent reasons, either of which alone is disqualifying:

1. **85 rows FAIL.** Certification requires zero.
2. **38 rows are UNTESTED.** They were never driven to a verdict, so they are not passes.

## 4. Round 1 → round 3 comparison

Round 1 graded 338 rows: 195 pass / 114 fail. Round 2 produced no usable grades. The round-1 failure set is reconstructed from the 116 numbered per-row reproduction files committed under `apps/ui/canary-repros/<lane>/<row>.md` (the six non-row files — `13.7-api`, `allowlist-revocation`, `backend-canary-auth`, `canary-alert-webhook`, `model-relay-413`, `oauth-cancel-copy` — cover backend and deploy surfaces outside the 338-row checklist and are excluded).

### 4a. Previously failing, now PASS — 59 rows

Round 2's fixers landed real repairs. These round-1 failures were re-driven in a browser against the current build and now pass:

```
2.2 2.3 2.4 2.5 4.6 5.1 5.2 5.6 5.11 5.15 6.4 7.2 9.4 11.6 12.2 13.4 13.7 15.7 17.4 19.1 19.2 19.3 20.4 21.2 21.7 21.8 23.4 24.3 25.7 26.2 26.3 26.4 26.5 26.6 28.3 28.4 28.6 28.9 28.10 28.11 A.12 A.26 A.34 A.46 A.47 A.48 A.49 A.52 A.53 A.57 A.59 A.60 A.64 A.65 A.67 A.74 A.75 A.76 A.77
```

The largest single win is the systemic "renders nothing" contract bug documented in `ROOT-CAUSES.md` §1: the whole §26 debug family (26.2–26.6) plus 13.4, 15.7 and 5.11 now surface their honest error strings instead of discarding them. Section 2 (sign-in round trip) went from four failures to fully green, and section 19 is now 5/5.

### 4b. Previously failing, still FAIL — 37 rows

- **1.1** (`access`) — Signed out the one offered next step IS sign-in (card CTA + gold suggestion pill + composer placeholder "Sign in with GitHub first — it's the one step needed…"), but on a first-ever visit the same card states a falsehood: "The identity service isn't configured
- **1.2** (`access`) — `/` signed out lists auth.sign-in FIRST (correct). Listing is: /auth.sign-in, /connect, /world, /theme, /surfaces, /dark-mode, /chat, /retry. /connect, /world, /theme, /surfaces, /dark-mode, /chat all work signed out. /retry cannot work signed out and is a tot
- **4.2** (`chat`) — The requested list, table, inline code, fenced code, and long token rendered without horizontal page overflow, but the rendered DOM contained zero heading elements and zero links despite the copied Markdown containing both.
- **6.1** (`chat`) — A hand sweep found two visible unstamped controls: the “Retry turn” button and the transcript jump-down button. Both lacked data-flow and had no data-flow ancestor.
- **7.3** (`cards`) — Completed cards did not remain Running, but grant-confirm status pills remained Waiting for approval after both Cancel and Post the grant were clicked.
- **7.5** (`cards`) — After reload, persisted cards were not ordered chronologically: a 9:29 AM balance card appeared before a 9:28 AM theme-picker card.
- **7.7** (`cards`) — Failed browser cards named the unavailable secure-egress seam but offered no recovery action or next step.
- **7.8** (`cards`) — At a 390px viewport in both themes, document body/root scroll width was 409px, producing horizontal page overflow.
- **8.13** (`cards`) — Both /browser https://example.com and a 404 URL produced Failed browser cards saying 'Secure pinned egress is unavailable for the browser tool.' Normal, 404, blocking, and large-page behavior therefore could not work.
- **8.27** (`cards`) — A text README produced a file card, but a missing-file request produced no failed file card and instead claimed the repository was not imported despite the preceding repo-import card showing done. Large and binary variants were consequently not reachable.
- **10.2** (`surfaces`) — The note is created and opened, but focus is not moved to it. After clicking 'New note' [data-flow=world.new-note], document.activeElement is still that button and typed characters go nowhere. See failureDetail.
- **10.8** (`surfaces`) — World content does not reach a model answer. Asking about a fact that exists only in the World note produces a '/recall' step and then no assistant reply at all; the fact is never named. Round 2 did not fix this. See failureDetail.
- **12.5** (`github`) — The real not-installed state was reported, but no usable installation/fix link was rendered.
- **13.3** (`github`) — Issue #43 rendered headings, bold text, code, lists, links, and two comments, but both markdown images became literal !alt text; the issue card contained zero img elements.
- **13.5** (`github`) — The command rendered DONE for issue #49, but its card had no GitHub link and a signed-in GitHub browser search returned “No results” for the unique title.
- **14.3** (`github`) — Without from:<bookmark>, the UI requested /branches.list; with valid from:codeplanesmithers-patch-1 it refused with “Couldn't derive the branch's change stack” and created no PR/card.
- **14.5** (`github`) — The card correctly showed QUEUED and then LANDING rather than claiming MERGED, but a signed-in GitHub browser search found no matching PR; the queued object existed only in the jjhub mirror.
- **14.6** (`github`) — PR #5 visibly had ci/canary-required FAILED, yet /prs.land moved it to QUEUED/LANDING instead of refusing and naming the failed required check.
- **15.2** (`repo-data`) — A nonexistent path was misreported as an unimported repository even though the repository had just completed import and valid paths worked.
- **15.3** (`repo-data`) — README markdown, nested plain text, large-file truncation, and binary-file handling rendered honestly. The missing-file case incorrectly claimed the repository was not imported.
- **15.6** (`repo-data`) — The set request succeeded, but the subsequent rendered environment card displayed the newly assigned test value in plain text.
- **16.1** (`repo-data`) — After /flow.create and selecting codeplanesmithers/canary-sandbox, the card remained at “Creating it on codeplanesmithers/canary-sandbox.” No real workflow or terminal error appeared.
- **20.3** (`appearance`) — Drove all 18 theme/mode combinations and found code, status-pill, and disabled-control styles, but the live PR detail card exposed no diff surface to inspect. The default dark theme also had a destructive status pill below required contrast.
- **20.6** (`appearance`) — Axe color-contrast audits on the default Night Owl palette reported serious violations in both light and dark modes.
- **21.4** (`appearance`) — Stop-while-streaming and maximize/minimize Escape behavior passed, but combined recommendation/menu precedence was reversed: Escape closed the menu while leaving the active recommendation untouched.
- **22.6** (`honesty`) — Only the email refusal supplied a usable next action. The local-file, Slack, and push responses lacked working next steps, while the PR response did not refuse the unsupported action.
- **22.7** (`honesty`) — The model's state answer contradicted the rendered UI and live browser-fetched session, watched-repository, and balance state.
- **23.5** (`honesty`) — /reset removed the prior marker and opened an empty conversation, but the only explanation was "Nothing here yet / Ask Smithers anything to get started"; it did not state that nothing was kept.
- **24.1** (`honesty`) — The alpha should not ship under this row: a forced identity failure was swallowed while the UI continued presenting a signed-in GitHub state, and several failures surfaced only as console resource errors or raw internal exceptions.
- **24.2** (`honesty`) — Forced agent, identity, billing, recommendation, notification, GitHub-import, and workflow failures in browser contexts. Billing, reco, notifications, import, and workflow produced named messages, but identity failed silently and the agent failure exposed a ra
- **26.1** (`admin`) — Reporting half and the routing half pass; the 'an argument is answered with that sentence, never obeyed' half fails. See failureDetail.
- **27.7** (`admin`) — Graded from the build I actually ran here, which is the surface for this row. The updater is NOT configured. See failureDetail.
- **28.2** (`admin`) — Counterexample driven in my own section: the request-access queue's empty state names no next step. See failureDetail.
- **28.5** (`admin`) — A literal 'undefined' is rendered to the user in an assistant chat bubble. See failureDetail.
- **28.12** (`admin`) — Two distinct 5xx observed during ordinary use: 501 on /api/user/byok-keys and 502 on /api/model/stream. See failureDetail.
- **A.66** (`flow-sweep`) — The documented explicit-repository root form could not be invoked: '.' was rejected as escaping the repository, while bare /files.list demanded a repository choice.
- **A.86** (`flow-sweep`) — Approving a login absent from the empty request queue issued a 201 allowlist mutation and rendered no result instead of refusing that the login was not queued. The mutation was cleaned up.

### 4c. Previously failing, now unavailable to grade — 20 rows

These round-1 failures could not be re-graded as pass or fail. Their round-1 defect is neither confirmed fixed nor confirmed present:

- **1.5** (`access`) — BLOCKED-ON-HUMAN — Needs a signed-in NON-allowlisted account. Only partial evidence driven: signed OUT, typing /admin.requests answers "There is no /admin.requests flow. Type / to see everything Smithers can do." — absent, not present-and-
- **4.13** (`chat`) — NOT-REACHABLE — UNTESTED: no single live turn produced 50 or more messages, and manufacturing that condition would not have graded a real model turn.
- **8.7** (`cards`) — NOT-REACHABLE — The request-queue card was reachable but contained zero waiting entries, so its approve-entry action could not be driven.
- **8.21** (`cards`) — NOT-REACHABLE — keys.list produced an honest toast that bring-your-own provider keys are not part of this MVP, but no keys card.
- **14.4** (`github`) — BLOCKED-ON-HUMAN — Comment and request-changes persisted and rendered correctly. Approve was honestly refused because codeplanesmithers authored the PR; completing the eligible-approval case requires a PR authored by a second GitHub identi
- **17.7** (`money`) — BLOCKED-ON-HUMAN — Two of three clauses driven, one unreachable without a credential, so the row cannot be closed. (a) NO TOKEN -> 401: driven from a page on https://billing.smithers.sh, POST /api/billing/admin/grants with no admin header 
- **18.1** (`money`) — NOT-APPLICABLE — This origin has no provider key store, and the product says so. GET /api/keys, POST /api/keys, DELETE /api/keys/anthropic all answer 404. /keys.list in the composer produces a failure toast: "/keys.list didn't run — Brin
- **18.3** (`money`) — NOT-APPLICABLE — /keys.remove anthropic produces the failure toast "/keys.remove didn't run — Bring-your-own provider keys aren't part of this preview. Smithers Cloud has no key store yet, so there is nothing to list, add, or remove — tu
- **18.5** (`money`) — NOT-APPLICABLE — Drove /keys.remove anthropic and /keys.remove openai — neither provider has a key (none can). Both answered with the same honest, readable failure toast naming why ("Bring-your-own provider keys aren't part of this previ
- **27.1** (`admin`) — BLOCKED-ON-HUMAN — I ran `bun run build:canary` here and it exited 0, producing a complete bundle: build/canary-macos-arm64/Smithers-canary.app with Contents/MacOS/launcher, Contents/Resources/AppIcon.icns (115166 B), Contents/Info.plist (
- **27.2** (`admin`) — NOT-APPLICABLE — Not applicable to the surface this lane graded (the web origin https://canary.smithers.sh). Window size, title and icon are properties of the Electrobun macOS window, which I could not drive (see 27.1: no assistive acces
- **A.18** (`flow-sweep`) — NOT-REACHABLE — /flow.create called POST /api/workflow/provision, then honestly reported that no workspace capacity was available and nothing was queued.
- **A.19** (`flow-sweep`) — NOT-REACHABLE — No workflow repository question was open. Invocation honestly said there was no repository question, so a successful choice could not be exercised.
- **A.23** (`flow-sweep`) — NOT-REACHABLE — /flow.run reached workspace preparation but capacity prevented workflow lookup or a successful run; missing name was refused honestly.
- **A.38** (`flow-sweep`) — BLOCKED-ON-HUMAN — The supplied account is already allowlisted and admin, so it can only render "You already have access". A non-allowlisted GitHub account is required to grade successful request creation.
- **A.50** (`flow-sweep`) — NOT-REACHABLE — Nonexistent and missing-number failures were honest, but no closed disposable issue remained available for a safe successful reopen.
- **A.51** (`flow-sweep`) — NOT-REACHABLE — Nonexistent and missing-number failures were honest; no disposable open issue was used for a successful named comment before cleanup.
- **A.54** (`flow-sweep`) — NOT-REACHABLE — Valid source branch had no changes over main and honestly named committing first; no changed disposable branch was available for successful PR creation.
- **A.55** (`flow-sweep`) — NOT-REACHABLE — No disposable mergeable pull request was available. Nonexistent PR and missing-number failures were honest.
- **A.56** (`flow-sweep`) — NOT-REACHABLE — Review attempts and failure paths were driven, but no safe unreviewed disposable PR was available to establish a clean successful review.

### 4d. Failing now, with no round-1 reproduction on file — 48 rows

**Honesty note on this bucket.** Round 1 graded 309 of 338 rows (195 pass + 114 fail), leaving 29 ungraded, and only its failures were written to disk as reproduction files. There is no round-1 pass list in the repository and no surviving round-1 run in the smithers database. I therefore **cannot** split these rows into true regressions versus newly-exposed defects, and I will not guess. What is true: each of these rows fails on the current build and has no round-1 repro file.

- **3.7** (`access`) — Deferral works, resume does not. Set watched repos to zero, then ran /flow.create ZZPROBE-round3-access-1: the app deferred with "/flow.create didn't run — Choose which repositories I should watch first — the chooser is open" and opened the chooser (correct). 
- **4.1** (`chat`) — A real five-bullet turn showed “Smithers is responding” at 19ms, then the entire answer appeared atomically at 958ms as the turn ended; no response token was visible well before completion.
- **4.5** (`chat`) — Copy placed the correct rendered message Markdown on the clipboard, but the button label remained “Copy message” immediately after the click and never displayed “Copied” before reverting.
- **4.7** (`chat`) — Repeated /clear attempts preserved all 33 messages and showed “The conversation changed while I was reviewing it, so I left it exactly as it is. Try /clear again.” instead of clearing and stating what was kept.
- **5.5** (`chat`) — Exact /chat and /world led their listings, but exact /stop listed only /chat.stop; the /stop exact-name entry was not reachable as the leading match.
- **5.9** (`chat`) — Unknown slash tokens did not go to the agent: /hello there rendered “/hello didn't run — There is no /hello flow,” /not-a-flow did likewise, and / followed by a space remained stuck in the draft.
- **6.3** (`chat`) — The model did not clearly refuse user-only requests. Separate sign-out/theme/send prompts yielded silence, a budget-exhaustion message, a “Change theme to dark and sign out?” approval card, and duplicate “GitHub is already connected” responses instead of stati
- **8.6** (`cards`) — Created two grant-confirm cards and clicked Cancel on one and Post the grant on the other; both cards remained Waiting for approval with unchanged confirmation copy.
- **13.2** (`github`) — The repo chooser described codeplanesmithers/demo-calendar as having 0 open issues, but /issues.list all rendered a synthetic mirror issue #1 instead of a zero-issue state.
- **13.6** (`github`) — Comment, close, and reopen visibly succeeded only on the jjhub mirror. Against real GitHub issue #1, GitHub stayed OPEN and never contained the unique comment marker.
- **15.5** (`repo-data`) — The environment card exposed literal values beside secret-like variable names and did not state that those displayed values were masked. Only a separate write-only secret entry was labeled accordingly.
- **15.8** (`repo-data`) — The local-file request ended with a generic empty-response failure instead of an honest refusal explaining that browser Smithers cannot access the local path and naming a next step.
- **16.9** (`repo-data`) — The list/run paths honestly reported no capacity, but the create path encountered an unreachable Cloud response and left the visible workflow card indefinitely saying “Creating it…” without surfacing the failure. The AI-provider-credential state was not reache
- **17.6** (`money`) — FAIL. The money figures are internally consistent, but the product's rendered spend summary misreports the volume: the balance card says "4532 turns" where 4532 is the count of billing charge line items, not turns. Real model calls at that moment were 1541. Se
- **21.6** (`appearance`) — The conversation log was a polite live region and became aria-busy=true during real streaming; cards and composer were named. Individual chat messages nevertheless appeared as unnamed articles in the accessibility tree and had no role or accessible label on th
- **22.2** (`honesty`) — The local-file request ended with an empty-response failure and no next step.
- **22.3** (`honesty`) — The Slack request eventually reported no Slack call was available, but gave no actionable next step and unnecessarily launched /background first.
- **22.4** (`honesty`) — The push request reported that no git-push capability existed, but gave no actionable next step and unnecessarily launched /background first.
- **22.5** (`honesty`) — The PR request asked which repository and branch to use and created an approval state, implying it could proceed instead of honestly saying it cannot open a PR.
- **22.8** (`honesty`) — Asked the model to sign out. The user message appeared, but no refusal, explanation, or visible alternative followed; the session stayed signed in.
- **24.4** (`honesty`) — Forced the product document request to return HTTP 500. The browser showed only "Internal Server Error" with no composer, branded recovery surface, or actionable retry.
- **24.5** (`honesty`) — Loading while offline produced a blank document and ERR_INTERNET_DISCONNECTED with no user-facing offline state. Going offline mid-use exposed a raw transport/chain exception instead of concise recovery guidance.
- **25.2** (`admin`) — Listing half passes; the approve half is a silent no-op and the end-to-end approve is additionally blocked on a second GitHub account. See failureDetail.
- **25.4** (`admin`) — The card path credits correctly; the two registered slash flows admin.grant.confirm / admin.grant.cancel do nothing at all. See failureDetail.
- **25.8** (`admin`) — Admin flows stay REGISTERED for a non-admin identity payload. See failureDetail for method and its one caveat.
- **26.7** (`admin`) — Answer to the row's question, driven: they ARE still reachable. With the identity payload's admin flag false and every client store wiped first, the shell's data-flows still lists reset, admin.devtools, debug.backend, debug.snapshot, debug.events, debug.chain,
- **A.2** (`flow-sweep`) — /world rendered World, but its bad-argument path produced no clear refusal or next step.
- **A.8** (`flow-sweep`) — /chat.stop accepted an idle stop, but malformed use falsely claimed a response was stopped.
- **A.9** (`flow-sweep`) — /stop dispatched, but malformed use completed without a rendered refusal or next step.
- **A.11** (`flow-sweep`) — /repos.watch rendered the chooser, but a nonexistent repository silently reopened it without naming the invalid target.
- **A.13** (`flow-sweep`) — Malformed /repos.watch.all was routed through the model and changed the watched selection instead of refusing.
- **A.14** (`flow-sweep`) — /repos.watch.none worked, but malformed use produced no terminal user-facing refusal.
- **A.15** (`flow-sweep`) — /repos.watch.confirm dispatched, but malformed use produced no direct refusal or next step.
- **A.16** (`flow-sweep`) — /clear dispatched, but malformed use launched unrelated model/tool work instead of rejecting the argument.
- **A.27** (`flow-sweep`) — /approval.approve with a nonexistent card silently recorded command.ran without saying that no approval existed.
- **A.28** (`flow-sweep`) — /approval.deny with a nonexistent card silently recorded command.ran without saying that no approval existed.
- **A.32** (`flow-sweep`) — /world.new-note created a note, but malformed use was interpreted by the model and created another note instead of refusing.
- **A.37** (`flow-sweep`) — The server session signed out, but after reload the SPA retained signed-in GitHub identity, balance and repository content and still dispatched signed-in flows.
- **A.39** (`flow-sweep`) — /toast.dismiss no-such-toast silently recorded command.ran; only the missing-argument case produced an honest refusal.
- **A.40** (`flow-sweep`) — /billing.balance rendered real balance data, but malformed use executed the flow and then contradicted it with "Unable to retrieve balance" instead of rejecting the argument.
- **A.45** (`flow-sweep`) — A nonexistent owner/repo was accepted as a 202 import job and remained RUNNING during observation instead of promptly naming the missing repository and next step.
- **A.61** (`flow-sweep`) — Signed-in notification listing rendered a DONE card, but after confirmed server sign-out the exact flow produced no sign-in refusal.
- **A.62** (`flow-sweep`) — Signed-in mark-read returned 204 and refreshed notifications, but after confirmed server sign-out the exact flow produced no sign-in refusal.
- **A.70** (`flow-sweep`) — /flows rendered the complete visible catalog, but an explicit model catalog request invoked /flows instead and exposed user-only flow names rather than returning the model-callable catalog.
- **A.73** (`flow-sweep`) — Bare /debug.backend correctly reported chain, but the documented /debug.backend proxy form was routed to the model, which falsely said the capability did not exist.
- **A.82** (`flow-sweep`) — Positive $0.01 input rendered a grant-confirm card, but negative amount input produced no refusal or next step.
- **A.83** (`flow-sweep`) — A grant-confirm card was created, but its "Post the grant" button exposed neither data-flow nor cardId, making a valid named confirmation unreachable; bogus IDs were refused.
- **A.84** (`flow-sweep`) — A grant-confirm card was created, but its Cancel button exposed neither data-flow nor cardId, making a valid named cancellation unreachable; bogus IDs were refused.

Net movement: 59 repaired, 37 unrepaired, 48 failing without a round-1 record. Failures moved 114 → 85.

## 5. UNTESTED rows — the certification blocker besides the failures

38 rows were reported by their lanes under a fifth status, `not-reachable`, which is not one of the four sanctioned outcomes. Reclassified honestly against the rules: none of them target a surface this origin lacks (so not NOT-APPLICABLE), and only a few need owner-only credentials (so not BLOCKED-ON-HUMAN). Nobody drove them to a verdict, so they are **UNTESTED**.

They fall into three causes:

**(a) Smithers Cloud workspace provisioning had no free capacity** — the dominant cause. `/flow.create`, `/flow.list` and `/flow.run` never got past "Preparing your codeplanesmithers/canary-sandbox workspace…" and returned "Smithers Cloud has no free workspace capacity right now — nothing was queued; try again in a bit." Everything gated behind a live workflow run was therefore ungradeable. The refusal itself is honest; the rows behind it are simply untested.

- Section 16 (workflow runs): 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.10 — 7 of 10 rows in the section
- Section 8 (cards): 8.1, 8.2, 8.3, 8.14, 8.15
- Appendix A: A.18, A.22, A.23

**(b) No suitable object existed to drive the success path.** The failure paths were driven and were honest; the success path had no safe disposable target.

- Appendix A: A.17, A.19, A.20, A.21, A.24, A.33, A.50, A.51, A.54, A.55, A.56
- Section 8: 8.7, 8.11, 8.12, 8.21, 8.26

**(c) The live product never produced the precondition the row asserts on.**

- 4.3 (no expandable reasoning block appeared), 4.9 (no `data-run-id` exposed), 4.10 (responses arrived atomically, so no partial-answer failure could be staged), 4.13 (no turn produced 50+ messages), 6.2, 6.5, 23.8 (no older database fixture available to stage the schema-downgrade path)

Full untested row list:

```
4.3 4.9 4.10 4.13 6.2 6.5 8.1 8.2 8.3 8.7 8.11 8.12 8.14 8.15 8.21 8.26 16.3 16.4 16.5 16.6 16.7 16.8 16.10 23.8 A.17 A.18 A.19 A.20 A.21 A.22 A.23 A.24 A.33 A.50 A.51 A.54 A.55 A.56
```

No checklist section is *entirely* untested — every one of sections 1–28 and Appendix A produced graded rows — but section 16 is 70% untested and section 8 is 36% untested, and neither can be called covered.

## 6. All failing rows by section


### Section 1

- **1.1** (`access`) — Signed out the one offered next step IS sign-in (card CTA + gold suggestion pill + composer placeholder "Sign in with GitHub first — it's the one step needed…"), but on a first-ever visit the same card states a falsehood: "The identity service isn't configured on this deployment, so sign-in may not 
- **1.2** (`access`) — `/` signed out lists auth.sign-in FIRST (correct). Listing is: /auth.sign-in, /connect, /world, /theme, /surfaces, /dark-mode, /chat, /retry. /connect, /world, /theme, /surfaces, /dark-mode, /chat all work signed out. /retry cannot work signed out and is a total silent no-op — body text byte-identic

### Section 3

- **3.7** (`access`) — Deferral works, resume does not. Set watched repos to zero, then ran /flow.create ZZPROBE-round3-access-1: the app deferred with "/flow.create didn't run — Choose which repositories I should watch first — the chooser is open" and opened the chooser (correct). Clicked All then Watch 3 repositories. T

### Section 4

- **4.1** (`chat`) — A real five-bullet turn showed “Smithers is responding” at 19ms, then the entire answer appeared atomically at 958ms as the turn ended; no response token was visible well before completion.
- **4.2** (`chat`) — The requested list, table, inline code, fenced code, and long token rendered without horizontal page overflow, but the rendered DOM contained zero heading elements and zero links despite the copied Markdown containing both.
- **4.5** (`chat`) — Copy placed the correct rendered message Markdown on the clipboard, but the button label remained “Copy message” immediately after the click and never displayed “Copied” before reverting.
- **4.7** (`chat`) — Repeated /clear attempts preserved all 33 messages and showed “The conversation changed while I was reviewing it, so I left it exactly as it is. Try /clear again.” instead of clearing and stating what was kept.

### Section 5

- **5.5** (`chat`) — Exact /chat and /world led their listings, but exact /stop listed only /chat.stop; the /stop exact-name entry was not reachable as the leading match.
- **5.9** (`chat`) — Unknown slash tokens did not go to the agent: /hello there rendered “/hello didn't run — There is no /hello flow,” /not-a-flow did likewise, and / followed by a space remained stuck in the draft.

### Section 6

- **6.1** (`chat`) — A hand sweep found two visible unstamped controls: the “Retry turn” button and the transcript jump-down button. Both lacked data-flow and had no data-flow ancestor.
- **6.3** (`chat`) — The model did not clearly refuse user-only requests. Separate sign-out/theme/send prompts yielded silence, a budget-exhaustion message, a “Change theme to dark and sign out?” approval card, and duplicate “GitHub is already connected” responses instead of stating it could not perform those acts.

### Section 7

- **7.3** (`cards`) — Completed cards did not remain Running, but grant-confirm status pills remained Waiting for approval after both Cancel and Post the grant were clicked.
- **7.5** (`cards`) — After reload, persisted cards were not ordered chronologically: a 9:29 AM balance card appeared before a 9:28 AM theme-picker card.
- **7.7** (`cards`) — Failed browser cards named the unavailable secure-egress seam but offered no recovery action or next step.
- **7.8** (`cards`) — At a 390px viewport in both themes, document body/root scroll width was 409px, producing horizontal page overflow.

### Section 8

- **8.6** (`cards`) — Created two grant-confirm cards and clicked Cancel on one and Post the grant on the other; both cards remained Waiting for approval with unchanged confirmation copy.
- **8.13** (`cards`) — Both /browser https://example.com and a 404 URL produced Failed browser cards saying 'Secure pinned egress is unavailable for the browser tool.' Normal, 404, blocking, and large-page behavior therefore could not work.
- **8.27** (`cards`) — A text README produced a file card, but a missing-file request produced no failed file card and instead claimed the repository was not imported despite the preceding repo-import card showing done. Large and binary variants were consequently not reachable.

### Section 10

- **10.2** (`surfaces`) — The note is created and opened, but focus is not moved to it. After clicking 'New note' [data-flow=world.new-note], document.activeElement is still that button and typed characters go nowhere. See failureDetail.
- **10.8** (`surfaces`) — World content does not reach a model answer. Asking about a fact that exists only in the World note produces a '/recall' step and then no assistant reply at all; the fact is never named. Round 2 did not fix this. See failureDetail.

### Section 12

- **12.5** (`github`) — The real not-installed state was reported, but no usable installation/fix link was rendered.

### Section 13

- **13.2** (`github`) — The repo chooser described codeplanesmithers/demo-calendar as having 0 open issues, but /issues.list all rendered a synthetic mirror issue #1 instead of a zero-issue state.
- **13.3** (`github`) — Issue #43 rendered headings, bold text, code, lists, links, and two comments, but both markdown images became literal !alt text; the issue card contained zero img elements.
- **13.5** (`github`) — The command rendered DONE for issue #49, but its card had no GitHub link and a signed-in GitHub browser search returned “No results” for the unique title.
- **13.6** (`github`) — Comment, close, and reopen visibly succeeded only on the jjhub mirror. Against real GitHub issue #1, GitHub stayed OPEN and never contained the unique comment marker.

### Section 14

- **14.3** (`github`) — Without from:<bookmark>, the UI requested /branches.list; with valid from:codeplanesmithers-patch-1 it refused with “Couldn't derive the branch's change stack” and created no PR/card.
- **14.5** (`github`) — The card correctly showed QUEUED and then LANDING rather than claiming MERGED, but a signed-in GitHub browser search found no matching PR; the queued object existed only in the jjhub mirror.
- **14.6** (`github`) — PR #5 visibly had ci/canary-required FAILED, yet /prs.land moved it to QUEUED/LANDING instead of refusing and naming the failed required check.

### Section 15

- **15.2** (`repo-data`) — A nonexistent path was misreported as an unimported repository even though the repository had just completed import and valid paths worked.
- **15.3** (`repo-data`) — README markdown, nested plain text, large-file truncation, and binary-file handling rendered honestly. The missing-file case incorrectly claimed the repository was not imported.
- **15.5** (`repo-data`) — The environment card exposed literal values beside secret-like variable names and did not state that those displayed values were masked. Only a separate write-only secret entry was labeled accordingly.
- **15.6** (`repo-data`) — The set request succeeded, but the subsequent rendered environment card displayed the newly assigned test value in plain text.
- **15.8** (`repo-data`) — The local-file request ended with a generic empty-response failure instead of an honest refusal explaining that browser Smithers cannot access the local path and naming a next step.

### Section 16

- **16.1** (`repo-data`) — After /flow.create and selecting codeplanesmithers/canary-sandbox, the card remained at “Creating it on codeplanesmithers/canary-sandbox.” No real workflow or terminal error appeared.
- **16.9** (`repo-data`) — The list/run paths honestly reported no capacity, but the create path encountered an unreachable Cloud response and left the visible workflow card indefinitely saying “Creating it…” without surfacing the failure. The AI-provider-credential state was not reached.

### Section 17

- **17.6** (`money`) — FAIL. The money figures are internally consistent, but the product's rendered spend summary misreports the volume: the balance card says "4532 turns" where 4532 is the count of billing charge line items, not turns. Real model calls at that moment were 1541. See failureDetail for the reproduction.

### Section 20

- **20.3** (`appearance`) — Drove all 18 theme/mode combinations and found code, status-pill, and disabled-control styles, but the live PR detail card exposed no diff surface to inspect. The default dark theme also had a destructive status pill below required contrast.
- **20.6** (`appearance`) — Axe color-contrast audits on the default Night Owl palette reported serious violations in both light and dark modes.

### Section 21

- **21.4** (`appearance`) — Stop-while-streaming and maximize/minimize Escape behavior passed, but combined recommendation/menu precedence was reversed: Escape closed the menu while leaving the active recommendation untouched.
- **21.6** (`appearance`) — The conversation log was a polite live region and became aria-busy=true during real streaming; cards and composer were named. Individual chat messages nevertheless appeared as unnamed articles in the accessibility tree and had no role or accessible label on their message elements.

### Section 22

- **22.2** (`honesty`) — The local-file request ended with an empty-response failure and no next step.
- **22.3** (`honesty`) — The Slack request eventually reported no Slack call was available, but gave no actionable next step and unnecessarily launched /background first.
- **22.4** (`honesty`) — The push request reported that no git-push capability existed, but gave no actionable next step and unnecessarily launched /background first.
- **22.5** (`honesty`) — The PR request asked which repository and branch to use and created an approval state, implying it could proceed instead of honestly saying it cannot open a PR.
- **22.6** (`honesty`) — Only the email refusal supplied a usable next action. The local-file, Slack, and push responses lacked working next steps, while the PR response did not refuse the unsupported action.
- **22.7** (`honesty`) — The model's state answer contradicted the rendered UI and live browser-fetched session, watched-repository, and balance state.
- **22.8** (`honesty`) — Asked the model to sign out. The user message appeared, but no refusal, explanation, or visible alternative followed; the session stayed signed in.

### Section 23

- **23.5** (`honesty`) — /reset removed the prior marker and opened an empty conversation, but the only explanation was "Nothing here yet / Ask Smithers anything to get started"; it did not state that nothing was kept.

### Section 24

- **24.1** (`honesty`) — The alpha should not ship under this row: a forced identity failure was swallowed while the UI continued presenting a signed-in GitHub state, and several failures surfaced only as console resource errors or raw internal exceptions.
- **24.2** (`honesty`) — Forced agent, identity, billing, recommendation, notification, GitHub-import, and workflow failures in browser contexts. Billing, reco, notifications, import, and workflow produced named messages, but identity failed silently and the agent failure exposed a raw internal Cause/AuthorError without an 
- **24.4** (`honesty`) — Forced the product document request to return HTTP 500. The browser showed only "Internal Server Error" with no composer, branded recovery surface, or actionable retry.
- **24.5** (`honesty`) — Loading while offline produced a blank document and ERR_INTERNET_DISCONNECTED with no user-facing offline state. Going offline mid-use exposed a raw transport/chain exception instead of concise recovery guidance.

### Section 25

- **25.2** (`admin`) — Listing half passes; the approve half is a silent no-op and the end-to-end approve is additionally blocked on a second GitHub account. See failureDetail.
- **25.4** (`admin`) — The card path credits correctly; the two registered slash flows admin.grant.confirm / admin.grant.cancel do nothing at all. See failureDetail.
- **25.8** (`admin`) — Admin flows stay REGISTERED for a non-admin identity payload. See failureDetail for method and its one caveat.

### Section 26

- **26.1** (`admin`) — Reporting half and the routing half pass; the 'an argument is answered with that sentence, never obeyed' half fails. See failureDetail.
- **26.7** (`admin`) — Answer to the row's question, driven: they ARE still reachable. With the identity payload's admin flag false and every client store wiped first, the shell's data-flows still lists reset, admin.devtools, debug.backend, debug.snapshot, debug.events, debug.chain, debug.net, debug.grants.reset, debug.se

### Section 27

- **27.7** (`admin`) — Graded from the build I actually ran here, which is the surface for this row. The updater is NOT configured. See failureDetail.

### Section 28

- **28.2** (`admin`) — Counterexample driven in my own section: the request-access queue's empty state names no next step. See failureDetail.
- **28.5** (`admin`) — A literal 'undefined' is rendered to the user in an assistant chat bubble. See failureDetail.
- **28.12** (`admin`) — Two distinct 5xx observed during ordinary use: 501 on /api/user/byok-keys and 502 on /api/model/stream. See failureDetail.

### Appendix A

- **A.2** (`flow-sweep`) — /world rendered World, but its bad-argument path produced no clear refusal or next step.
- **A.8** (`flow-sweep`) — /chat.stop accepted an idle stop, but malformed use falsely claimed a response was stopped.
- **A.9** (`flow-sweep`) — /stop dispatched, but malformed use completed without a rendered refusal or next step.
- **A.11** (`flow-sweep`) — /repos.watch rendered the chooser, but a nonexistent repository silently reopened it without naming the invalid target.
- **A.13** (`flow-sweep`) — Malformed /repos.watch.all was routed through the model and changed the watched selection instead of refusing.
- **A.14** (`flow-sweep`) — /repos.watch.none worked, but malformed use produced no terminal user-facing refusal.
- **A.15** (`flow-sweep`) — /repos.watch.confirm dispatched, but malformed use produced no direct refusal or next step.
- **A.16** (`flow-sweep`) — /clear dispatched, but malformed use launched unrelated model/tool work instead of rejecting the argument.
- **A.27** (`flow-sweep`) — /approval.approve with a nonexistent card silently recorded command.ran without saying that no approval existed.
- **A.28** (`flow-sweep`) — /approval.deny with a nonexistent card silently recorded command.ran without saying that no approval existed.
- **A.32** (`flow-sweep`) — /world.new-note created a note, but malformed use was interpreted by the model and created another note instead of refusing.
- **A.37** (`flow-sweep`) — The server session signed out, but after reload the SPA retained signed-in GitHub identity, balance and repository content and still dispatched signed-in flows.
- **A.39** (`flow-sweep`) — /toast.dismiss no-such-toast silently recorded command.ran; only the missing-argument case produced an honest refusal.
- **A.40** (`flow-sweep`) — /billing.balance rendered real balance data, but malformed use executed the flow and then contradicted it with "Unable to retrieve balance" instead of rejecting the argument.
- **A.45** (`flow-sweep`) — A nonexistent owner/repo was accepted as a 202 import job and remained RUNNING during observation instead of promptly naming the missing repository and next step.
- **A.61** (`flow-sweep`) — Signed-in notification listing rendered a DONE card, but after confirmed server sign-out the exact flow produced no sign-in refusal.
- **A.62** (`flow-sweep`) — Signed-in mark-read returned 204 and refreshed notifications, but after confirmed server sign-out the exact flow produced no sign-in refusal.
- **A.66** (`flow-sweep`) — The documented explicit-repository root form could not be invoked: '.' was rejected as escaping the repository, while bare /files.list demanded a repository choice.
- **A.70** (`flow-sweep`) — /flows rendered the complete visible catalog, but an explicit model catalog request invoked /flows instead and exposed user-only flow names rather than returning the model-callable catalog.
- **A.73** (`flow-sweep`) — Bare /debug.backend correctly reported chain, but the documented /debug.backend proxy form was routed to the model, which falsely said the capability did not exist.
- **A.82** (`flow-sweep`) — Positive $0.01 input rendered a grant-confirm card, but negative amount input produced no refusal or next step.
- **A.83** (`flow-sweep`) — A grant-confirm card was created, but its "Post the grant" button exposed neither data-flow nor cardId, making a valid named confirmation unreachable; bogus IDs were refused.
- **A.84** (`flow-sweep`) — A grant-confirm card was created, but its Cancel button exposed neither data-flow nor cardId, making a valid named cancellation unreachable; bogus IDs were refused.
- **A.86** (`flow-sweep`) — Approving a login absent from the empty request queue issued a 201 allowlist mutation and rendered no result instead of refusing that the login was not queued. The mutation was cleaned up.

## 7. Named reproductions

Each lane recorded step-by-step reproductions with observed and expected text. Reproduced verbatim below, per lane.

### `lane-access`

```
Origin: https://canary.smithers.sh, build sha 4dc40043aa34530d32481114376aaedea67b4fc9, bundle /assets/index-CLjr2OeT.js. All rows driven in headless Chromium via Playwright + bun. The sanctioned profile path /Users/williamcory/flows/flows/apps/ui/.playwright-profile-codeplanesmithers DOES NOT EXIST; I used copies of the surviving signed-in profiles under /tmp (canary-access-profile, canary-uifix-profile) copied to /tmp/round3-access-profile, /tmp/round3-access-fresh, /tmp/round3-access-fresh2, plus brand-new empty profiles for the signed-out rows. Screenshots in /tmp/r3a/.

=== FAIL 1.1 — the signed-out card tells a first-time visitor that sign-in may not work ===
Steps: rm -rf a profile dir, launch Chromium with it, goto https://canary.smithers.sh, wait 15s.
Observed (rendered innerText):
  "Smithers is a design-partner preview — sign in with GitHub to continue.
   The identity service isn't configured on this deployment, so sign-in may not work yet."
Expected: the scope disclosure that the SAME build renders on a profile that has visited before:
  "Before GitHub asks, here is what Smithers will use: Verify your GitHub identity … Add or update GitHub Actions workflow files."
The claim is false. On the same origin, in the same session, sign-in completes end to end (2.1) and curl https://canary.smithers.sh/api/auth/scopes returns 200 with verified:true and the full scope list. Network trace on first load shows ZERO /api/ requests: the app never fetches /api/auth/scopes on boot, so identity.scopesPlain is null and App.tsx:755 emits the misconfiguration fallback. It only fetches /api/auth/scopes later, on an identity transition (observed in the 2.6 trace: 401 /api/billing/balance → 200 /api/auth/session → 200 /api/auth/scopes). Every genuinely new user therefore sees the false line; only returning profiles see the truth. Reproduced on 3 independent empty profiles. Evidence: /tmp/r3a/1-signedout.png.

=== FAIL 1.2 — /retry is offered signed out and is a silent no-op ===
Steps: fresh profile, goto https://canary.smithers.sh, click the composer, type "/".
Observed menu, in order: /auth.sign-in, /connect, /world, /theme, /surfaces, /dark-mode, /chat, /retry.
Then: type "/retry", press Enter, wait 7s.
Observed: page innerText byte-identical to the text captured immediately before Enter. No message, no toast, no error, no state change of any kind.
Expected: either /retry is withheld from the signed-out listing (nothing that cannot work signed out), or running it produces an honest step the way a signed-out prompt does (1.3 correctly answers "Sign in with GitHub first — that's the one step between you and this conversation.").
auth.sign-in leading the listing is correct; the defect is /retry's presence combined with total silence.

=== FAIL 3.7 — a repos-gated flow defers, opens the chooser, and never resumes ===
Steps, signed in as codeplanesmithers on https://canary.smithers.sh:
 1. /repos.watch → click None → click "Watch 0 repositories". App confirms "Watching no repositories for now."
 2. Type "/flow.create ZZPROBE-round3-access-1", Enter.
 3. Observed (correct): toast "/flow.create didn't run — Choose which repositories I should watch first — the chooser is open", and the repo-chooser card opens.
 4. Click All, then click "Watch 3 repositories".
 5. Observed at t+5s, t+10s, t+15s, t+20s after confirm: the literal string ZZPROBE-round3-access-1 is ABSENT from the page; no workflow card, no "Continuing /flow.create", no error attributable to flow.create; the stale toast "/flow.create didn't run — Choose which repositories I should watch first — the chooser is open" is still displayed even though the chooser has closed and 3 repos are now watched. Only the digest recompute and a fresh reco appear.
Expected: the chooser confirm satisfies the repos-selected requirement and flow.create resumes with its original argument ZZPROBE-round3-access-1, running to completion.
Repeated with /flow.run round3-deferral-probe — identical: chooser opens, confirm satisfies the requirement, flow never resumes, "/flow.run didn't run" toast persists.
This is specific to the repos-selected requirement. The signed-in requirement resumes correctly (3.8): the same deferral machinery emits "Continuing /issues.list" after the OAuth round trip. Evidence: /tmp/r3a/12-watch-none.png, /tmp/r3a/13-deferred.png, /tmp/r3a/14-resumed.png, /tmp/r3a/15-defer2.png.
```

### `lane-chat`

```
4.1 reproduction: in a clean authenticated browser, submit “Give exactly five short bullet points about reliable software.” Observed “Smithers is responding” at 19ms and the complete five-item answer in one update at 958ms, coincident with completion. Expected an actual response token well before the turn ended. 4.2 reproduction: request a heading, list, two-column table, link, inline code, fenced TypeScript, and a long unbroken token. Observed list/table/code and no horizontal overflow, but zero h1-h6 elements and zero anchors; clipboard content contained “# Demo Heading” and the Markdown link. Expected all requested Markdown forms to render. 4.5 reproduction: click the last assistant message’s “Copy message” button. Observed correct clipboard content but aria-label and visible state remained “Copy message.” Expected “Copied” followed by reversion. 4.7 reproduction: wait until no stop control is present, enter /clear, and repeat after the failure. Observed all 33 messages retained and “The conversation changed while I was reviewing it, so I left it exactly as it is. Try /clear again.” Expected the conversation to clear and state what was kept. 5.5 reproduction: type /stop, /chat, and /world and inspect the first option. Observed /chat and /world first for themselves, but /stop produced only /chat.stop. Expected /stop itself to lead its exact-match listing. 5.9 reproduction: submit /hello there and /not-a-flow, then try / followed by a space. Observed “There is no /hello flow,” “There is no /not-a-flow flow,” and the slash-space draft was not submitted. Expected each unregistered slash form to reach the agent as a prompt. 6.1 reproduction: enumerate rendered visible buttons/links/menu items and inspect data-flow or a data-flow ancestor. Observed unstamped “Retry turn” and jump-down controls. Expected every visible interactive affordance to resolve to a named slash-reachable flow. 6.3 reproduction: separately ask the model to sign out, change the theme, and submit the composer. Observed no explicit refusal; instead it produced silence/budget exhaustion, a combined approval card titled “Change theme to dark and sign out?”, and duplicate “GitHub is already connected” messages. Expected the model to say it cannot execute user-only flows and not enqueue anything.
```

### `lane-cards`

```
7.3 reproduction: run /admin.grant 0.01 codeplanesmithers twice; click Cancel on the first card and Post the grant on the second. Observed: both cards still read 'WAITING FOR APPROVAL' with unchanged confirmation copy. Expected: canceled and granted terminal states with correct pills. 7.5 reproduction: create browser, balance, and theme cards, then reload. Observed transcript order included Balance at 9:29 AM before Color themes at 9:28 AM. Expected ordinal/createdAt-consistent ordering after reload. 7.7 reproduction: run /browser https://example.com. Observed: 'Failed — Secure pinned egress is unavailable for the browser tool.' with no action or guidance. Expected the named failure plus a next step. 7.8 reproduction: set viewport to 390x844, inspect body and root in light and dark. Observed scrollWidth 409 versus clientWidth 390. Expected no horizontal body overflow. 8.6 reproduction: create two grant confirmations, click Cancel and Post the grant. Observed both remained Waiting for approval. Expected one canceled state and one confirmed/granted or honestly failed state. 8.13 reproduction: run /browser https://example.com and /browser https://example.com/definitely-missing-round3. Observed identical Failed cards stating secure pinned egress was unavailable. Expected rendered normal-page and distinct 404 results, plus operable blocked-fetch and large-page cases. 8.27 reproduction: run /repos.import codeplanesmithers/canary-sandbox and observe its card report done; run /files.read README.md codeplanesmithers/canary-sandbox and observe a text file card; then run /files.read does-not-exist-round3 codeplanesmithers/canary-sandbox. Observed no failed file card and text claiming the repository was not imported. Expected a missing-file card naming the missing path and offering a next step.
```

### `lane-surfaces`

```
FAILURE 1 - row 10.2: world.new-note creates the note but does not focus it.
Steps (canary.smithers.sh, signed in as codeplanesmithers):
1. Type /world in the composer and press Enter. The World pane opens with the file tree showing ['Untitled 1'].
2. Click the 'New note' button, button[data-flow="world.new-note"], in the pane header.
3. Wait 3s, then type 'SHOULD-LAND-IN-EDITOR' without clicking anywhere.
Observed: the note is created and loaded - the tree becomes ['Untitled 1','Untitled 2'] and the .ProseMirror editor shows 'Untitled 2'. But document.activeElement is still {tag:'BUTTON', class:'sui-button sui-button-ghost sui-button-sm', text:'New note', data-flow:'world.new-note'}. After typing, the editor text is unchanged ('Untitled 2'); the typed characters reached neither the editor nor any other field. Reproduced twice, in two separate browser sessions.
Expected: after world.new-note, document.activeElement should be the new note's editor (the .ProseMirror contenteditable) so the user can type the note immediately, the way reco.edit already moves focus to textarea.sui-chat-composer-input. A keyboard user must currently Tab or mouse into the editor before writing.

FAILURE 2 - row 10.8: world content does not reach the model, and the turn returns no answer.
Steps:
1. Open /world, select the 'World' note, and append the line 'The canary lane mascot is a purple axolotl named Quibbleworth Fenwick.' Confirm it saved: reopening the note shows 'World\n\nThe canary lane mascot is a purple axolotl named Quibbleworth Fenwick.'
2. Close the pane, then ask in the composer: 'According to my world notes, what is the canary lane mascot's name? Answer with just the name.'
3. Ask again, phrased differently: 'What is the canary lane mascot's name? It is written in my World note. Reply with the name.'
Observed: each turn renders the user bubble, then a single chip 'Smithers ran /recall', then nothing. No assistant message element is ever added (I enumerated the last 14 .sui-chat-message nodes: the trailing ones are all user messages). The string 'Quibbleworth' never appears in the page after 120s of polling, and the stop affordance is gone within 10s, so the turn has ended, not stalled.
Expected: a reply naming Quibbleworth Fenwick, sourced from the note.
Diagnosis, driven in the browser: /recall is not a real flow. Typing '/recall mascot' directly answers '/recall didn't run - There is no /recall flow. Type / to see everything Smithers can do.' So the agent reaches for a recall tool that the registry does not contain, and the turn dies silently instead of falling back to the world text or saying it cannot recall.
Scope honesty: a control question in the same session, 'Reply with exactly the word PONGCHECK7 and nothing else.', also produced no assistant message. So the proximate cause may be the turn loop failing to emit assistant text for plain question turns (a §4 concern) rather than world-context plumbing specifically. Either way the 10.8 test as written fails: no answer names the note's fact. Flow-dispatching turns in the same session DID work (reco accept/edit ran /prs.view and rendered a PR card), so it is only plain-text answers that come back empty.

ADJACENT OBSERVATION (not one of my rows, but it is why 11.5 and 11.7 are N/A rather than gradeable): /repos.import codeplanesmithers/canary-sandbox succeeded - POST /api/github/import created job a855dc38-ddae-4918-a6e6-f8a073ff5d59 and GET /api/github/import/<id> returned 200 with status "ready", workspace_id c9a85bba-..., target_bookmark main - yet the Connectors pane's 'Connected repositories' section still reads 'No repositories connected' at t+72s and after a full reload. The list has no working data source on this deployment: /api/repos/connected and /api/github/imports both answer 404 'Smithers Cloud doesn't serve that request on this deployment.' That belongs to §12 (Repos), but it means no connector row, no .connected-repository-card and no button[aria-label^="Remove"] can exist on the web origin at all.

ENVIRONMENT NOTE: the shared profile named in the brief, apps/ui/.playwright-profile-codeplanesmithers, does not exist in the tree. I used ~/.multi-e2e-profile (the path scripts/live-signed-in-check.ts defaults to), copied to /tmp/round3-surfaces-profile per the no-shared-user-data-dir rule. Its session cookie had expired, so I re-signed in through the GitHub OAuth button in the browser; /api/auth/session then returned login codeplanesmithers, allowlisted true, admin true. The copied profile and all scratch scripts were deleted at the end.
```

### `lane-github`

```
12.5 — Steps: type /repos.app codeplanesmithers/canary-sandbox and submit. Observed: “The Smithers GitHub App is not installed on codeplanesmithers/canary-sandbox, and the platform's install link wasn't usable.” No GitHub installation link appeared. Expected: the real installation state plus a usable GitHub fix/install link. 13.2 — Steps: observe the browser-rendered repo chooser reporting codeplanesmithers/demo-calendar with 0 open issues, then submit /issues.list all codeplanesmithers/demo-calendar. Observed: a DONE card containing “#1 canary default-target probe OPEN” rather than an empty state. Expected: zero issues. 13.3 — Steps: submit /issues.view 43 codeplanesmithers/canary-sandbox and inspect the rendered issue card. Observed: the markdown body and comments rendered, but image positions showed “!smithers octocat” and “!octocat”; DOM inspection found 0 img elements. Expected: both markdown images rendered as images. 13.5 — Steps: submit /issues.create round3 github lane 1787243571195 codeplanesmithers/canary-sandbox, inspect the resulting card, then open GitHub's issue search for that exact title in the signed-in browser. Observed: the app claimed “Issue #49 … DONE … OPEN”, the card contained no anchors, and GitHub showed “No results.” Expected: the created issue to exist on GitHub and the card to link to it. 13.6 — Steps: open real GitHub issue codeplanesmithers/canary-sandbox#1, submit /issues.comment 1 round3-existing-1787244251889 codeplanesmithers/canary-sandbox, then /issues.close 1 and /issues.reopen 1, reloading the GitHub issue after each action. Observed: app cards claimed the comment and CLOSED/OPEN transitions, but GitHub never contained the marker and remained OPEN even after the claimed close. Expected: the comment and state transitions on the real GitHub issue. 14.3 — Steps: submit /prs.create round3 github PR 1787243794950 without a bookmark, then submit it with from:codeplanesmithers-patch-1 on codeplanesmithers/canary-sandbox. Observed: the first said “prs.create needs a source branch”; the second said “Couldn't derive the branch's change stack”; no landing or PR card was created. Expected: PR creation with and without the optional bookmark argument. 14.5 — Steps: submit /prs.land 5 codeplanesmithers/canary-sandbox, inspect the card/platform state, then search signed-in GitHub for the exact title “Canary repro 14.6 unmergeable 1787123022081”. Observed: the card moved to QUEUED and the platform to LANDING, while GitHub returned “No results matched your search.” Expected: a queued real GitHub PR whose claim can be confirmed on GitHub. 14.6 — Steps: view PR #5, confirm its rendered check “ci/canary-required FAILED”, then submit /prs.land 5 codeplanesmithers/canary-sandbox. Observed: the card changed from OPEN to QUEUED and the platform state to LANDING. Expected: an honest refusal naming the failed required check.
```

### `lane-repo-data`

```
15.2 reproduction: complete /repos.import codeplanesmithers/canary-sandbox, verify valid root and nested listings, then enter /files.list definitely-missing-round3 codeplanesmithers/canary-sandbox. Observed: “codeplanesmithers/canary-sandbox isn't imported yet — run /repos.import codeplanesmithers/canary-sandbox first.” Expected: an honest path-not-found response. 15.3 reproduction: after valid README.md, docs/nested/hello.txt, big.txt, and blob.bin reads, enter /files.read definitely-missing-round3.txt codeplanesmithers/canary-sandbox. Observed the same false not-imported message. Expected a missing-file response. 15.5 reproduction: enter /env.view codeplanesmithers/canary-sandbox. Observed secret-like names rendered beside literal values without a masking statement. Expected secret values masked and explicitly described as masked or write-only. 15.6 reproduction: enter /env.set ROUND3_REPO_DATA_SECRET=<test-value> codeplanesmithers/canary-sandbox, then /env.view codeplanesmithers/canary-sandbox. Observed the assigned test value in plain text. Expected confirmation without ever rendering the value. 15.8 reproduction: ask “Read the local file /Users/williamcory/private-notes.txt and tell me its contents.” Observed: “I couldn't complete that turn. Smithers Cloud returned an empty response.” Expected an explicit local-file access refusal with a usable next step. 16.1 reproduction: enter /flow.create a workflow that summarizes my open issues, choose codeplanesmithers/canary-sandbox, and wait 90 seconds. Observed only “Creating it on codeplanesmithers/canary-sandbox.” with no workflow or terminal error; the provision request reported Smithers Cloud unreachable. Expected a real workspace workflow or a visible terminal failure. 16.9 reproduction: follow the same create steps while recording /api/workflow/provision. Observed an unreachable-Cloud response while the UI remained indefinitely at “Creating it…”. Expected the UI to surface the unreachable/wedged state honestly instead of appearing to progress forever.
```

### `lane-money`

```
17.6 — the balance card reports charge line items as "turns", overstating the user's turn count ~2.9x.

Origin: https://canary.smithers.sh, signed in as codeplanesmithers (admin:true, allowlisted:true).

Steps:
1. Sign in on https://canary.smithers.sh with the codeplanesmithers profile.
2. Clear the persisted store (so the balance card in the transcript is from THIS load, not an earlier one) and reload.
3. Type /billing.balance in the composer and press Enter.
4. Read the [data-kind="balance"] card's innerText, and in the SAME page evaluation fetch /api/billing/balance and /api/billing/usage.

Observed (2026-08-20T16:47Z):
  card text:  "Balance / DONE / balance · 9:47 AM / $564 left. / $0 spent across 4532 turns so far."
  /api/billing/balance:  totalUsd "564", lifetimeChargedUsd "0", chargeCount 4532 (4535 one second later)
  /api/billing/usage:    totalUsd "0", totalCostUsd "0.762034",
                         byResource charges = inference.input_tokens 1541, inference.cached_input_tokens 1453, inference.output_tokens 1541

1541 + 1453 + 1541 = 4535 = chargeCount exactly. The same identity held on two earlier independent samples in this run: chargeCount 3313 = 1130 + 1053 + 1130, and chargeCount 4341 = 1476 + 1389 + 1476. So chargeCount is the number of billing CHARGE RECORDS across resources — roughly three per model call — and the card prints it as the number of turns. The actual turn count at the time of the reading was ~1541.

Expected: "$0 spent across 1541 turns so far." (or a label that names what 4532 actually counts, e.g. "4532 charges").
Actual:   "$0 spent across 4532 turns so far."

What is NOT wrong: the money itself is consistent. usage totalUsd "0" matches balance lifetimeChargedUsd "0", the balance never decremented across the whole session (543 -> 564 moved only by admin grants I and sibling lanes wrote, never by spend), and the real unbilled cost is reported separately and truthfully as totalCostUsd, which rose 0.605229 -> 0.725929 -> 0.762034 as turns ran. Only the turn count is misreported. Screenshot: /tmp/money/61-balance-card.png.

Caveat carried into 17.7 rather than graded as a failure: the checklist's own auto-check E-1 posts to https://billing.smithers.sh/api/billing/admin/grants server-side (no Origin header), and round 1 recorded 403 {"error":"Forbidden origin"} for that shape. From a browser page on the billing origin the same call answers 401 {"error":"Unauthorized admin"}, which is what the row requires. I did not drive the origin-less shape (it is not a browser action), so I make no claim about it.
```

### `lane-appearance`

```
20.3 reproduction: Sign in, enter `/files.read README.md codeplanesmithers/canary-sandbox`, then `/prs.view 2 codeplanesmithers/canary-sandbox`, open `/theme`, and toggle `/dark-mode` while selecting all nine themes. Observed: the file card rendered one code block and the PR card rendered `No description.`, `Reviews`, `Checks`, and action buttons, but no diff element, diff text, or diff affordance was present (`diffCount=0`). Expected: the checklist-required diff surface should be present and legible in both modes; dark destructive status text should also remain legible.
20.6 reproduction: Select `/theme night-owl`, set light mode, and run an Axe color-contrast audit; then toggle `/dark-mode` and repeat. Observed in light mode: `Land (queue merge)` and `Do it` had 4.39:1 contrast. Observed in dark mode: the destructive status badge had 4.11:1 contrast. Expected: at least 4.5:1 for this normal-sized text and no color-contrast violations.
21.4 reproduction: With an active `What I found` recommendation, open the Surfaces menu and press Escape once. Observed: the menu count changed from 1 to 0 while the recommendation remained active and present. Expected precedence from the checklist: dismiss the recommendation before closing the menu. Isolated checks confirmed Escape stopped a streaming turn and minimized a maximized card correctly.
21.6 reproduction: Start a real streaming turn with `Count slowly from 1 to 60, one number per line.` and inspect the browser accessibility tree while the Stop control is visible. Observed: `Conversation` was a polite live region with busy=true, the composer was a named textbox, and cards were named regions; individual messages were exposed as articles with empty names, while `.smithers-chat-message` elements had neither role nor aria-label. Expected: chat messages should expose meaningful roles and accessible labels, in addition to the working live-region announcement.
```

### `lane-honesty`

```
22.2 reproduction: In the signed-in chat, submit "Read /etc/hosts on my laptop and tell me what is in it." Observed: "Smithers paused — it is waiting on something outside this chat" followed by "I couldn't complete that turn. Smithers Cloud returned an empty response" and "Turn failed." Expected: an honest inability to access the laptop plus a concrete working next step, such as asking the user to paste or attach the file.
22.3 reproduction: Submit "Post a message in our Slack #general channel." Observed: "Smithers ran /background," then an empty-response failure, followed by a background result saying "Cannot post to Slack: no available call for Slack messaging." Expected: an immediate can't-yet refusal naming a working connection or copy/paste next step, with no unnecessary background run.
22.4 reproduction: Submit "Push my current branch to origin right now." Observed: "Smithers ran /background," an empty-response failure, then "I don't have a git push capability via available calls, so I can't push the current branch to origin." Expected: an immediate refusal plus an actionable working next step, without launching background work.
22.5 reproduction: Submit "Open a pull request for the work you just did." Observed: "Which repository and branch should I use for the pull request?" plus an approval card saying "Waiting for repository and branch info." Expected: a clear statement that Smithers cannot open the PR, followed by a working preparation/manual-open next step.
22.6 reproduction: Drive all five impossible asks above. Observed: the local-file request had only an empty-response failure; Slack and push named missing capabilities without recovery actions; PR implied it could proceed. Expected: every refusal to contain a specific next step that can actually be used.
22.7 reproduction: In the authenticated codeplanesmithers session, submit "Am I signed in? What repos do you watch? What is my current balance?" Browser-fetched state was signedIn=true, watched repos were codeplanesmithers/canary-sandbox, codeplanesmithers/demo-calendar, and codeplanesmithers/smithers-demo, and the UI showed $543. Observed model conclusion: "Sign-in status: No, you are not signed in," "You are not watching any repositories," and "Balance unavailable," despite cards in the same turn showing GitHub connected and "$543 left." Expected: all three answers to match the live UI and seam state.
22.8 reproduction: Submit "Sign me out of Smithers now." Observed: the user bubble appeared with no assistant response or refusal, and the composer still showed "GitHub · codeplanesmithers." Expected: an explicit user-only refusal naming the visible /auth.sign-out control.
23.5 reproduction: Submit a unique marker, wait for it to persist, then run /reset. Observed: the marker disappeared and the UI rendered only "Nothing here yet / Ask Smithers anything to get started." Expected: the fresh conversation plus explicit wording that nothing from the old conversation was kept.
24.1 reproduction: In a fresh browser context carrying only the authenticated cookies, force /api/auth/session to return 503 and load the app. Observed: normal signed-in GitHub recommendations and "GitHub · codeplanesmithers" with no identity failure message. Expected: a named visible identity error with retry or sign-in guidance. Other forced failures also emitted console-only 503 errors and raw internal exceptions.
24.2 reproduction: In separate fresh browser contexts, force 503 for /api/auth/session, /api/billing/balance, /api/reco/**, /api/notifications/**, /api/github/import, /api/workflow/**, and /api/model/stream; invoke the corresponding visible flows. Observed identity failure was silent. Agent failure rendered "Cause([Fail(/chain/AuthorError: flows/model/ModelError: provider_internal...HTTP 503...)])" with no plain-language retry. Expected: every upstream failure to produce a named, concise, actionable message.
24.4 reproduction: Intercept the document request for https://canary.smithers.sh/ and return HTTP 500 with body "Internal Server Error," then navigate to it. Observed: only "Internal Server Error" and zero composer elements. Expected: a branded error surface naming the Worker failure and offering retry/reload.
24.5 reproduction: Set the browser context offline before navigating to canary. Observed: ERR_INTERNET_DISCONNECTED and an empty body until networking was restored and navigation was manually retried. For mid-use, submit a marker, immediately go offline, then restore networking. Observed: "The chain failed: Cause([Fail(/chain/AuthorError...TransportError: TypeError Failed to fetch...])" and "Turn failed." Expected: visible offline-at-load guidance and concise mid-use reconnect/retry messaging without leaking internal exception structure.
```

### `lane-admin`

```
Target: https://canary.smithers.sh, build sha 4dc40043aa34530d32481114376aaedea67b4fc9 (meta name="smithers-build-sha"), graded 2026-08-20 09:30-09:57 PT. Driven in headless Chromium via Playwright from `bun`, using a private copy of the shared signed-in profile at /tmp/round3-admin-profile-v2. NOTE ON THE PROFILE: the path named in the lane brief (apps/ui/.playwright-profile-codeplanesmithers) does not exist; the live profile is ~/.multi-e2e-profile, which is what live-signed-in-check.ts uses. I copied that one. Its app session was expired, so I re-drove the real OAuth round trip and landed at /?signed-in=github with GET /api/auth/session -> {"login":"codeplanesmithers","allowlisted":true,"admin":true,"scopes":["read:user"]}. codeplanesmithers IS an admin on this deploy, so §25 and §26 were graded from a genuine admin session.

=== 25.2 FAIL — /admin.queue.approve <login> is a total silent no-op ===
Repro: sign in as an admin at https://canary.smithers.sh. Type `/admin.queue.approve r3-nobody-xyz-9` in the composer and press Enter.
Observed: the composer clears (inputValue goes from "/admin.queue.approve r3-nobody-xyz-9" to ""), and then nothing happens. document.body.innerText is byte-identical before and after — length 24727 -> 24727 across a 12 s wait. There is no echoed user message, no card, no toast, no error, no console output and no network request. Repeated twice with two different logins, same result.
Expected: the same honesty the sibling flow already gives. `/admin.allowlist.remove neverwasthere-zzz9` answers "neverwasthere-zzz9 was already off the allowlist — nothing changed.", and `/admin.queue.approve` with NO argument correctly answers "/admin.queue.approve didn't run" / "admin.queue.approve needs a login". Approving a login that is not in the queue should say so; today the flow swallows the command entirely.
What passed on this row: `/admin.requests` rendered a request-queue card headed "Request-access queue — 0 waiting" with body "The queue is empty — nobody is waiting.", matching GET /api/admin/requests -> {"requests":[]}.
Still BLOCKED inside this row: the row's real end-to-end (approve an entry, then the approved user signs in) needs a queued request, and enqueuing one needs a second GitHub account. /auth.request-access from a clean profile redirects to GitHub's login page for the SmithersPreviewRelease OAuth app, and codeplanesmithers is already allowlisted so it cannot enqueue itself. Only the owner can supply a second GitHub identity.

=== 25.4 FAIL — admin.grant.confirm and admin.grant.cancel are registered but inert ===
Repro (confirm): as admin, send `/admin.grant 4 codeplanesmithers`. A grant-confirm card appears, state WAITING FOR APPROVAL, headed "Grant $4 to codeplanesmithers?" with body "Grant $4 of promotional balance to codeplanesmithers. The grant is recorded with your login as the requester and a fresh timestamp; the billing service answers before anything is treated as done." and buttons "Post the grant" / "Cancel". Read the balance (GET /api/billing/balance -> balance.totalUsd = "547"). Now send `/admin.grant.confirm`.
Observed: the flow emits nothing at all — no card update, no message, no toast. The card stays WAITING FOR APPROVAL. Balance after: totalUsd "547", unchanged. Sending it again changes nothing.
Expected: "admin.grant.confirm credits exactly once" — the pending card should resolve to DONE and the balance should move to 548.
Repro (cancel): send `/admin.grant 1 codeplanesmithers`, then `/admin.grant.cancel`. Observed: no output, and the card is still WAITING FOR APPROVAL afterwards (three such orphaned $1 cards accumulated across the run). Expected: the card resolves to a cancelled state.
Both flows ARE registered — they appear in the shell's data-flows as admin.grant.confirm and admin.grant.cancel — so this is a broken registered flow, not a gate.
The card path is fine and is what I used to grade 25.5: clicking "Post the grant" moved totalUsd 545 -> 547 for a $2 grant, flipped the card to DONE and appended "Granted — admin:product-mt1qqkkp-89963786." Side note: "Post the grant" and "Cancel" carry no data-flow attribute, so the only working path to confirm a grant is unaddressable by name.
STATE LEFT BEHIND: this row and 25.5 credited codeplanesmithers's promotional balance by $17 total ($2 + $4 + $5 + $6), taking totalUsd from 545 to 564. Test-only account on canary; flagging it so the number is not a surprise.

=== 25.8 FAIL — every admin flow stays REGISTERED for a non-admin identity ===
Method (stated plainly, because it is not a second real account): I intercepted GET /api/auth/session and rewrote only the admin field to false, leaving login and allowlisted untouched. To rule out a cached registry from an earlier admin load, I then cleared localStorage, sessionStorage, every IndexedDB database and every OPFS entry (smithers-mvp.sqlite, -wal, -journal were present and removed) and reloaded.
Observed: the app read {"login":"codeplanesmithers","allowlisted":true,"admin":false,...} and the shell's data-flows attribute still contained all 18 gated names — reset, admin.devtools, debug.backend, debug.snapshot, debug.events, debug.chain, debug.net, debug.grants.reset, debug.seams, admin.allowlist.add, admin.allowlist.remove, admin.grant, admin.grant.confirm, admin.grant.cancel, admin.requests, admin.queue.approve, admin.feedback, admin.health. The corner "Reset conversation" button still rendered (count 1). Typing /admin.health still produced a full admin-health card with real service detail.
Expected: for admin:false the registry should not contain admin.* / debug.* at all — the row's words are "unregistered, not merely refused".
CAVEAT, so this is not over-read: the client registry is built from that session payload, and it demonstrably does not gate on it. But the underlying cookie is still an admin cookie, so the server happily served /api/admin/health; I have NOT shown what the server does for a genuinely non-admin caller. Confirming the server-side refusal needs a second GitHub account (owner-supplied). The client-registry half of the row is what fails here.

=== 26.1 FAIL — /debug.backend with an argument is not answered, it falls through to chat ===
Repro: as admin, send `/debug.backend` -> correct: "agent backend: chain (in-browser Agent Chain over /api/model/stream)".
Now send `/debug.backend openai`. Observed: the literal text "/debug.backend openai" is echoed into the transcript as an ordinary user message and NOTHING answers it — no sentence, no refusal, no card.
Now send `/debug.backend switch to /api/agent/turn`. Observed: the text is echoed as an ordinary user message and the model answers it in free prose: "I can't switch the backend directly. The system is configured to use the default backend." /debug.chain confirms this came from the model, not the flow — the authored script for that lineage is `await ctx.call("say", { text: "I can't switch the backend directly. The system is configured to use the default backend." });`.
Expected: "an argument is answered with that sentence, never obeyed" — an argument should get the backend-reporting sentence back from the flow itself, deterministically. Today a one-word argument gets silence and a longer one gets whatever the model decides to say, which never names the one backend.
The other half of 26.1 passes: I sent a normal turn and it spent its model on POST /api/model/stream (200) and on nothing else. The only other /api/ request in the turn was GET /api/billing/balance. /api/agent/turn was never touched, in this or any turn all lane.

=== 27.7 FAIL — the updater is not configured ===
Graded from the build I ran here, which is the surface for this row. `bun run build:canary` (exit 0) printed, verbatim: "baseUrl:" (empty) / "generating a patch from the previous version..." / "No baseUrl configured, skipping patch generation" / "To enable patch generation, configure baseUrl in your electrobun.config". artifacts/canary-macos-arm64-update.json was emitted but is 76 bytes, and no patch was produced. apps/ui/electrobun.config.ts declares app/build/copy/mac/linux/win but no baseUrl.
Expected: the row asks to "confirm it is configured". It is not — with no baseUrl there is no update feed to point a shipped build at, so a canary user who installs the dmg has no upgrade path. Whether to exercise the updater before the alpha is the owner's call; whether it is configured is answerable now, and the answer is no.

=== 28.2 FAIL — an empty state that names no next step ===
Repro: as admin, send `/admin.requests`. Observed card: title "Request-access queue — 0 waiting", state DONE, body exactly "The queue is empty — nobody is waiting." and nothing else — no action, no link, no next step.
Expected per the row ("Every empty state names the next step"): something that tells the admin what to do from here, e.g. "The queue is empty — nobody is waiting. Add someone directly with /admin.allowlist.add <login>." That sibling flow exists and is registered, so the next step is real and nameable.
Scope note: this is the empty state I drove inside my own sections. I did not sweep every empty state in the app; the connectors and flow-list surfaces belong to other lanes, and one counterexample is enough to fail an "every" bar.

=== 28.5 FAIL — a literal "undefined" is rendered to the user ===
Repro: as a signed-in user, ask "List the open issues in codeplanesmithers/canary-sandbox." Observed in the transcript: chips "Smithers adjusted its approach" x2, then "Smithers ran /issues.list", then an assistant bubble reading:
  Open issues in codeplanesmithers/canary-sandbox:
  undefined
Expected: the issue list, or an honest "I could not read the issues" — never the string "undefined".
Confirmed structurally, not just by regex: a DOM TreeWalker over document.body found the text node "undefined" at DIV.sui-msg-scroller-content > ARTICLE.sui-chat-message > DIV.sui-chat-bubble > DIV.sui-md > P.sui-md-p — i.e. it is prose inside a rendered assistant message, not JSON inside a debug card. (The only other placeholder-shaped hits on the page were the word "null" inside the /debug.snapshot and /debug.events JSON payloads, which is legitimate JSON and not counted.)

=== 28.12 FAIL — two distinct 5xx during ordinary use ===
(a) 501 on GET https://canary.smithers.sh/api/user/byok-keys. Repro: as a signed-in user, send `/keys.list`. The request returns 501 and the browser logs "Failed to load resource: the server responded with a status of 501 ()". Reproduced on two separate runs. A not-implemented endpoint is an honest status, but it is still a 5xx raised by a registered, user-reachable flow during a normal session.
(b) 502 on POST https://canary.smithers.sh/api/model/stream. Repro: during an ordinary chat turn (the third "Create an issue titled ..." turn), the model stream returned 502 and the browser logged "Failed to load resource: the server responded with a status of 502 ()". One occurrence; other turns in the same session returned 200. Transient, but it is the model call, so a user hitting it loses their turn.
Expected: no 4xx/5xx during a normal session. Everything else was clean — cold load, hydration, first-run digest, /api/reco/watched, /api/reco/first-run, /api/billing/balance, /api/admin/health, /api/admin/requests and every model turn but one returned 200 across the whole lane.

=== OBSERVATIONS OUTSIDE MY ROWS (for the owners of §1, §2, §5, §6) ===
1. The signed-out "Sign in with GitHub" button is dead. Clicking [data-flow="auth.sign-in"] on https://canary.smithers.sh issues ZERO network requests and causes no navigation; the page is unchanged after 9 s. Three such buttons render and the first is also pointer-intercepted by the transcript scroller (Playwright reports the message-scroller-viewport intercepting the click, so I had to force it). The endpoint itself is fine — navigating directly to /api/auth/github/start returns 302 and completes the OAuth round trip, and the server-rendered shell links to /api/auth/sign-in — so this is a client wiring break, not a backend one. This is how I had to sign in for the whole lane.
2. The signed-out page states "The identity service isn't configured on this deployment, so sign-in may not work yet." That is false on this deploy: /admin.health reports "identity — healthz ok — requestedScopes: [\"read:user\"] · admin: true · serviceToken: true" and OAuth completes. A user-facing string that misreports a healthy service.
3. The corner "Reset conversation" button (data-flow="reset", aria-label "Reset conversation") does nothing. Clicked it three times across two runs: no confirmation dialog appears, and the transcript is unchanged — .sui-chat-message count 44 before and 44 after, body length 24611 -> 24745 (only a card's own live re-read). `/clear` likewise left the transcript intact. A destructive-sounding affordance that neither confirms nor acts.
4. Turn thrash. Two write turns ended with 4 and 17 consecutive identical "Smithers adjusted its approach" chips and no result, no error and no approval card — the turn simply stopped. The approval card for the first of them appeared minutes later, out of band. A third card was later found in a FAILED state reading "That approval is no longer pending." / "Submission failed — check the connection and try again."
5. Cross-lane interference is real on this shared account: the watched-repo set changed under me mid-run ("across 3 repos" -> "across 1 repo", with the digest correctly explaining "you changed which repositories Smithers watches"). Anything another lane reports about watched repos or issue counts on codeplanesmithers should be read with that in mind.

Artifacts: screenshots and logs under /tmp/r3admin/ (a-*.png admin cards, u-worlddelete.png confirm modal, v-loading-*.png loading frames, z-nextday.png day boundary, build.log). Scratch scripts were written under apps/ui/scripts/.r3admin/ and deleted; build/, dist/ and artifacts/ are gitignored; the desktop app was force-quit; both allowlist probe logins were removed.
```

### `lane-flow-sweep`

```
A.2: Type /world unexpected. Observed only "Smithers adjusted its approach" with no invalid-argument refusal; expected a direct statement that /world takes no arguments and the valid next step /world. A.8: While idle, type /chat.stop unexpected. Observed "Chat stopped as requested"; expected rejection of the argument or an honest statement that no response was active. A.9: Type /stop unexpected. Observed the submitted message and a completed chain but no answer; expected an honest no-arguments refusal. A.11: Type /repos.watch no-such-owner/no-such-repo. Observed the normal chooser with known repositories and no mention of the bad target; expected repository-not-found plus a choice next step. A.13: Type /repos.watch.all unexpected. Observed the model invoke /repos.watch and change the chooser to "Watch 1 repository"; expected argument rejection and no selection mutation. A.14: Type /repos.watch.none unexpected. Observed model adjustment with no terminal explanation; expected argument rejection. A.15: Type /repos.watch.confirm unexpected. Observed a model chain with no direct refusal; expected argument rejection. A.16: Type /clear unexpected. Observed unrelated recall/model work; expected argument rejection and no conversation sweep. A.27: Type /approval.approve no-such-card. Observed only command.ran transitions; expected "no pending approval with that card id" and a next step. A.28: Type /approval.deny no-such-card. Observed only command.ran transitions; expected the same honest missing-approval response. A.32: Type /world.new-note unexpected. Observed the model run /remember and the world-document count increase; expected rejection with no note created. A.37: Type /auth.sign-out, reload, and read /api/auth/session plus body text. Observed {"status":"signed-out"} while the SPA still rendered GitHub codeplanesmithers, repository chooser and balance and continued dispatching signed-in flows; expected a signed-out shell with sign-in as the next step and no authenticated data. A.39: Type /toast.dismiss no-such-toast. Observed only command.ran; expected an honest missing-toast refusal. A.40: Type /billing.balance unexpected. Observed a real balance followed by "Unable to retrieve balance right now"; expected the bad argument to be rejected without executing or contradicting the successful read. A.45: Type /repos.import no-such-owner/no-such-repo. Observed HTTP 202 and a RUNNING import card for the nonexistent repository, with no terminal explanation during observation; expected repository-not-found and a corrective next step. A.61: Sign out, reload, confirm /api/auth/session is signed-out, then type /notifications.list. Observed no sign-in refusal; expected "sign in with GitHub" and no notification read. A.62: Repeat signed out with /notifications.read. Observed no sign-in refusal; expected authentication guidance and no mutation. A.66: Type /files.list . codeplanesmithers/canary-sandbox, then /files.list. Observed "File paths must stay inside the repository" for the explicit form and a multiple-repository choice refusal for the bare form; expected a root-directory card for the explicitly named repository. A.70: Send "Use the commands tool with action list... Do not execute any flow." Observed "Smithers ran /flows" and a catalog containing theme, dark-mode, auth.sign-out, prs.land, billing.portal and other user-only names; expected the actual model-callable catalog with user-only flows absent. The shell data-flows manifest itself contained 90 unique names exactly matching current Flows.ts; the source includes hidden world.delete.confirm and world.delete.cancel in addition to the checklist's stated 88. A.73: Type /debug.backend proxy. Observed "there is no debug.backend capability available"; expected the documented backend report or guidance to use bare /debug.backend, which separately worked and reported chain. A.82: Type /admin.grant -1 flow-sweep-nonexistent-user-zz. Observed no rendered response; expected rejection of the negative amount and the valid syntax. A.83: Create /admin.grant 0.01 flow-sweep-nonexistent-user-zz and inspect the visible "Post the grant" affordance. Observed no data-flow and no cardId anywhere on the card; /admin.grant.confirm no-such-card only said the confirmation was gone. Expected a data-flow=admin.grant.confirm affordance with a usable cardId so the named success path can run. A.84: On the same card inspect Cancel. Observed no data-flow and no cardId; expected data-flow=admin.grant.cancel with a usable cardId. A.86: With /admin.requests showing "0 waiting", type /admin.queue.approve flow-sweep-nonexistent-user-zz. Observed HTTP 201 POST /api/admin/allowlist plus GET /api/admin/requests and no rendered answer; expected refusal that the login was not in the queue. The unintended allowlist entry was removed afterward.
```

## 8. BLOCKED-ON-HUMAN rows

11 rows need a credential or account only the owner can supply. They are not failures and not passes.

- **1.4** (`access`) — Needs a signed-in NON-allowlisted GitHub account; the only credential available (codeplanesmithers) is allowlisted:true, admin:true. Partial evidence driven: /auth.request-access on the allowlisted account refuses honestly ("/auth.request-a
- **1.5** (`access`) — Needs a signed-in NON-allowlisted account. Only partial evidence driven: signed OUT, typing /admin.requests answers "There is no /admin.requests flow. Type / to see everything Smithers can do." — absent, not present-and-refusing. The signed
- **3.4** (`access`) — Needs an account whose grant is untouched. The line renders only while chargeCount === 0; the balance card on codeplanesmithers reads "$564 left. $0 spent across 4547 turns so far.", so the intro line is legitimately suppressed and appeared
- **3.9** (`access`) — Needs a GitHub account with zero repositories. codeplanesmithers owns 3. Setting the watched selection to zero is a different state and is handled honestly ("You chose to watch zero repositories, so there is nothing to summarize. Ask Smithe
- **3.10** (`access`) — Needs a GitHub account with 200+ repositories. codeplanesmithers owns 3, so pagination, scroll and frame-lock could not be exercised. The chooser does ship a working filter input ("Type to filter repositories…", verified narrowing 3 rows to
- **14.4** (`github`) — Comment and request-changes persisted and rendered correctly. Approve was honestly refused because codeplanesmithers authored the PR; completing the eligible-approval case requires a PR authored by a second GitHub identity.
- **17.5** (`money`) — Not drivable by this lane. The graded account (codeplanesmithers) sits at $564 with state "ok" and allowedToStartWork true, so the pause path never engages, and there is no product surface that can zero a balance (grants only add). Checklis
- **17.7** (`money`) — Two of three clauses driven, one unreachable without a credential, so the row cannot be closed. (a) NO TOKEN -> 401: driven from a page on https://billing.smithers.sh, POST /api/billing/admin/grants with no admin header answered 401 {"error
- **21.1** (`appearance`) — The supplied profile path was absent, so testing used a copied sanctioned long-lived codeplanesmithers profile. OAuth was keyboard-driven, but this established account cannot exercise the complete fresh-account first-run journey; a fresh Gi
- **27.1** (`admin`) — I ran `bun run build:canary` here and it exited 0, producing a complete bundle: build/canary-macos-arm64/Smithers-canary.app with Contents/MacOS/launcher, Contents/Resources/AppIcon.icns (115166 B), Contents/Info.plist (CFBundleIdentifier s
- **A.38** (`flow-sweep`) — The supplied account is already allowlisted and admin, so it can only render "You already have access". A non-allowlisted GitHub account is required to grade successful request creation.

## 9. NOT-APPLICABLE rows

20 rows target surfaces this web origin does not have. Per the grading rules these are **not folded into failures** and do not drag the verdict down. The surfaces that would grade them are named below.

- **2.7** (`access`) — Desktop-only row. The surface that would grade it is the Electrobun desktop build. On this web origin /api/auth/native/start and /api/auth/native/claim both return 404, so there is no native handoff to drive here.
- **11.3** (`surfaces`) — Not applicable to this web origin; grade on the Electrobun desktop build (§27). Verified live rather than assumed: with the connectors pane open on canary.smithers.sh there are 0 elements matching [data-flow^="connector"] anywhere in the DO
- **11.4** (`surfaces`) — Not applicable to this web origin; grade on the Electrobun desktop build (§27). connector.downgrade has no DOM binding here (0 [data-flow^="connector"] elements) and there is no connector to downgrade - 0 .connected-repository-card in the D
- **11.5** (`surfaces`) — Not applicable to this web origin; grade on the Electrobun desktop build (§27). 0 button[aria-label^="Remove"] and 0 .connected-repository-card in the DOM. I did not just re-assert the round-1/2 note: I ran /repos.import codeplanesmithers/c
- **11.7** (`surfaces`) — Not applicable to this web origin; grade on the Electrobun desktop build (§27). The row needs an existing connector whose backing repo has disappeared, and no connector can exist on web - 0 [data-flow^="connector"] elements, 0 .connected-re
- **18.1** (`money`) — This origin has no provider key store, and the product says so. GET /api/keys, POST /api/keys, DELETE /api/keys/anthropic all answer 404. /keys.list in the composer produces a failure toast: "/keys.list didn't run — Bring-your-own provider 
- **18.2** (`money`) — There is no surface anywhere in the product that adds a provider key, so validation-before-save has nothing to grade. The 10-surface input sweep (home, /connect, /world, /theme, /surfaces, /billing.balance, /keys.list, /flow.list, /env.view
- **18.3** (`money`) — /keys.remove anthropic produces the failure toast "/keys.remove didn't run — Bring-your-own provider keys aren't part of this preview. Smithers Cloud has no key store yet, so there is nothing to list, add, or remove — turns run on the inclu
- **18.4** (`money`) — An invalid or revoked provider key cannot be installed on this origin (no key store, POST /api/keys -> 404), so no turn can fail on one. Turns on this account run on the included allowance; the chat turn I drove completed normally. Would be
- **18.5** (`money`) — Drove /keys.remove anthropic and /keys.remove openai — neither provider has a key (none can). Both answered with the same honest, readable failure toast naming why ("Bring-your-own provider keys aren't part of this preview. Smithers Cloud h
- **27.2** (`admin`) — Not applicable to the surface this lane graded (the web origin https://canary.smithers.sh). Window size, title and icon are properties of the Electrobun macOS window, which I could not drive (see 27.1: no assistive access). The surface that
- **27.3** (`admin`) — Not applicable to the web origin this lane graded. Native sign-in handoff and its persistence across a restart can only be graded in the Electrobun macOS app; not driven here.
- **27.4** (`admin`) — Not applicable to the web origin this lane graded. nativeOpenExternal only exists in the Electrobun host; in a browser every link is already a browser link. Grading surface: the Smithers-canary.app window, checking GitHub, Stripe and docs l
- **27.5** (`admin`) — Not applicable to the web origin this lane graded. LocalRepository reads the host filesystem and has no web counterpart. Grading surface: the Electrobun macOS app.
- **27.6** (`admin`) — Not applicable to the web origin this lane graded. The local CloudAgent tool loop is the desktop agent path; the web build runs the in-browser Agent Chain over /api/model/stream instead (verified separately in 26.1). Grading surface: the El
- **27.8** (`admin`) — Not applicable to the web origin this lane graded. Quit-and-relaunch-mid-turn is a desktop lifecycle test. Grading surface: the Electrobun macOS app. (The web build's equivalent is honest — reloading mid-turn produced 'That turn was interru
- **27.9** (`admin`) — Not applicable to the web origin this lane graded. Window resize, minimize, fullscreen and multi-display are native window-manager behaviours. Grading surface: the Electrobun macOS app on a session with assistive access.
- **A.29** (`flow-sweep`) — Native-only local-repository connector. Web invocation recorded connector.local.failed; the Electrobun/Desktop surface must grade success.
- **A.30** (`flow-sweep`) — Native-only local connector management. The canary web origin has no local connector to downgrade.
- **A.31** (`flow-sweep`) — Native-only local connector management. The canary web origin has no local connector to remove.

## 10. Method and its limits

Every graded row was driven in headless Chromium via Playwright under `bun`, against the live origin, asserting on rendered text (`page.locator("body").innerText()`) rather than on source code.

Two method problems are worth recording because they affect how much weight the grades carry:

1. **The sanctioned browser profile does not exist.** Multiple lanes (`access`, `admin`) independently reported that `apps/ui/.playwright-profile-codeplanesmithers` — the path named in the brief — is absent from the tree. Lanes substituted surviving signed-in profiles (`~/.multi-e2e-profile`, `/tmp/canary-access-profile`) copied to private per-lane directories, and the `admin` lane re-drove the real GitHub OAuth round trip when its session proved expired, landing at `/?signed-in=github` with `GET /api/auth/session` returning `allowlisted:true, admin:true`. Sign-in was therefore genuine, but the profile referenced by the brief needs to be restored or the brief corrected before round 4.
2. **Lanes invented a fifth status.** 38 rows were returned as `not-reachable` rather than being forced into one of the four sanctioned outcomes. This aggregator reclassified them as UNTESTED (§5). Round 4's lane schema should make UNTESTED an explicit, first-class option so this reclassification is not needed.

## 11. What certification would require

1. Close the 85 failing rows, or justify each one as NOT-APPLICABLE with the surface named.
2. Restore Smithers Cloud workspace capacity and re-drive the 38 untested rows — section 16 above all, which is currently 70% ungraded.
3. Restore the sanctioned Playwright profile, or update the brief to name the real one.
4. Re-run all eleven lanes against the resulting build.

Until then the honest statement is: **the current canary deploy is materially better than round 1 — 59 previously-failing rows now pass — but it is NOT-CERTIFIED.**
