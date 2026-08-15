# Launch checklist report

- Target: https://canary.smithers.sh
- Generated: 2026-08-10T19:37:28.136Z
- Totals: **2 fail** · 29 pass · 0 not-testable-with-stub-provider · 1 not-testable-yet

## Fails

### A-8 — One recommendation card carrying proposes / why-now / what-happens / accept-edit-dismiss

```
Error: [A-8] no card carries proposes/why-now/what-happens with accept/edit/dismiss controls. card 0: proposes=false whyNow=false whatHappens=false acceptEditDismiss=false | card 1: proposes=false whyNow=false whatHappens=false acceptEditDismiss=false

[2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32mtrue[39m
Received: [31mfalse[39m
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-1dc51-happens-accept-edit-dismiss/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-1dc51-happens-accept-edit-dismiss/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-1dc51-happens-accept-edit-dismiss/trace.zip
Duration: 4.1s

### A-9 — Dismiss is one key and the same recommendation does not return unchanged

```
Error: [A-9] Escape did not dismiss the recommendation card in one keypress

[2mexpect([22m[31mlocator[39m[2m).[22mtoBeHidden[2m([22m[2m)[22m failed

Locator:  locator('.smithers-card, [data-card]').first()
Expected: hidden
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-75174-n-does-not-return-unchanged/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-75174-n-does-not-return-unchanged/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-75174-n-does-not-return-unchanged/trace.zip
Duration: 9.1s

## Not testable with the stub provider

None.

## Not testable yet

- **D-4** — At $0, interactive chat keeps working; only non-complimentary work pauses  
  needs SMITHERS_BILLING_BASE_URL (explicit env; live targets never inherit the dev stack) and SMITHERS_MVP_ZERO_BEARER — a Smithers Cloud bearer whose billing account holds $0

## Passes

- **A-1** — Signed-out shows the chat (transcript + composer): the opening Smithers message carries the sentence, plain-words scopes, and a first-Tab sign-in; no separate landing view (no blank prompt box, no feature list) (1.6s)
- **A-2** — Sign-in to first useful message in <= 90s (3.3s)
- **A-3** — First message cites repo-specific data (not greeting-only boilerplate) (1.7s)
- **A-4** — Workspace pre-exists: no clone/install/configure copy anywhere (4.9s)
- **A-5** — "$500 of usage on us" stated exactly once (1.3s)
- **A-6** — No card form anywhere in the product (3.5s)
- **A-7** — <= 3 questions asked in the whole first run (6.1s)
- **B-1** — Close browser mid-turn, reopen: conversation + in-flight work restored and correctly described (2.4s)
- **B-2** — Escape stops foreground work <= 1s with a statement of what stopped (1.3s)
- **B-3** — A server-side kill surfaces in the UI (no silent completion/failure) (3.1s)
- **B-4** — Result cards lead with the result (4.5s)
- **B-5** — No score/grade/number user-facing (4.3s)
- **B-6** — A correction never renders as an error state (5.6s)
- **B-7** — Zero rating prompts ("was this helpful?" anywhere = fail) (3.7s)
- **C-1** — Every visible interactive affordance resolves to a named command also reachable by /name (1.3s)
- **C-2** — "/" opens with the recommended command first and bare "/"+Enter runs it (1.3s)
- **C-3** — The whole section-A journey is completable keyboard-only (1.5s)
- **D-1** — GET /api/billing/balance shows the $500 design-partner balance for a signed-in user (0.1s)
- **D-2** — An interactive chat turn does NOT reduce the balance; its true supplier cost IS still recorded (comped, not uncounted) (12.1s)
- **D-3** — No top-up/checkout/card-collection flow is exposed to MVP users (0.4s)
- **E-1** — POST /api/billing/admin/grants rejects calls without the admin token (401) (0.2s)
- **E-2** — An untimestamped grant is refused (400 timestamp_required) (0.0s)
- **E-3** — A grant with requester + timestamp credits the balance exactly once (201, audit record) (1.1s)
- **F-1** — Impossible ask (send an email): honest "can't yet + next step", never fake success (2.8s)
- **F-2** — Impossible ask (read local files): honest "can't yet + next step", never fake success (2.9s)
- **F-3** — Impossible ask (unconnected tool): honest "can't yet + next step", never fake success (2.8s)
- **F-4** — Impossible ask (claim a push): honest "can't yet + next step", never fake success (2.9s)
- **F-5** — Impossible ask (claim a PR): honest "can't yet + next step", never fake success (2.8s)
- **F-6** — Blocked-on-approval state agrees across every surface (no RUNNING-vs-Blocked contradiction) (42.9s)

