# Launch checklist report

- Target: https://canary.smithers.sh
- Generated: 2026-08-10T13:19:26.249Z
- Totals: **18 fail** · 13 pass · 0 not-testable-with-stub-provider · 1 not-testable-yet

## Fails

### A-3 — First message cites repo-specific data (not greeting-only boilerplate)

```
Error: [A-3] first message cites nothing repo-specific (no path, owner/repo, branch, or concrete project reference): "S
Smithers

Hey — I’m Smithers. Tell me what you’re working on and I’ll take it from there.

06:17 AM"
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-c889e-ge-cites-repo-specific-data/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-c889e-ge-cites-repo-specific-data/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-c889e-ge-cites-repo-specific-data/trace.zip
Duration: 1.2s

### A-5 — "$500 of usage on us" stated exactly once

```
Error: [A-5] the $500 design-partner offer is not stated on the first-run surface

[2mexpect([22m[31mreceived[39m[2m).[22mtoBeGreaterThan[2m([22m[32mexpected[39m[2m)[22m

Expected: > [32m0[39m
Received:   [31m0[39m
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-2617a-n-us-is-stated-exactly-once/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-2617a-n-us-is-stated-exactly-once/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-2617a-n-us-is-stated-exactly-once/trace.zip
Duration: 30.5s

### A-8 — One recommendation card carrying proposes / why-now / what-happens / accept-edit-dismiss

```
Error: [A-8] missing feature: no recommendation card appeared during the first run

[2mexpect([22m[31mreceived[39m[2m).[22mtoBeGreaterThan[2m([22m[32mexpected[39m[2m)[22m

Expected: > [32m0[39m
Received:   [31m0[39m
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-1dc51-happens-accept-edit-dismiss/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-1dc51-happens-accept-edit-dismiss/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-1dc51-happens-accept-edit-dismiss/trace.zip
Duration: 3.9s

### A-9 — Dismiss is one key and the same recommendation does not return unchanged

```
Error: [A-9] missing feature: no recommendation card to dismiss

[2mexpect([22m[31mreceived[39m[2m).[22mtoBeGreaterThan[2m([22m[32mexpected[39m[2m)[22m

Expected: > [32m0[39m
Received:   [31m0[39m
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-75174-n-does-not-return-unchanged/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-75174-n-does-not-return-unchanged/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-a-first-run--A-fir-75174-n-does-not-return-unchanged/trace.zip
Duration: 3.4s

### B-4 — Result cards lead with the result

```
Error: [B-4] missing feature: no result card rendered

[2mexpect([22m[31mreceived[39m[2m).[22mtoBeGreaterThan[2m([22m[32mexpected[39m[2m)[22m

Expected: > [32m0[39m
Received:   [31m0[39m
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-b-work-loop--B-wor-84c2e--cards-lead-with-the-result/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-b-work-loop--B-wor-84c2e--cards-lead-with-the-result/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-b-work-loop--B-wor-84c2e--cards-lead-with-the-result/trace.zip
Duration: 5.4s

### B-6 — A correction never renders as an error state

```
Error: [B-6] a correction rendered an alert/error surface

[2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32m0[39m
Received: [31m1[39m
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-b-work-loop--B-wor-15b90-r-renders-as-an-error-state/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-b-work-loop--B-wor-15b90-r-renders-as-an-error-state/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-b-work-loop--B-wor-15b90-r-renders-as-an-error-state/trace.zip
Duration: 8.1s

### C-1 — Every visible interactive affordance resolves to a named command also reachable by /name

```
Error: [C-1] button-only affordances with no /command binding:
"Surfaces" does not resolve to any /command (world, world, connect, connect, theme, theme, chat, chat, retry, retry, chat.stop, chat.stop, send, send, repos.watch, repos.watch, clear, clear, browser, browser, workflow.create, workflow.create, workflow.list, workflow.list, workflow.run, workflow.run, auth.sign-in, auth.sign-in, auth.sign-out, auth.sign-out, auth.request-access, auth.request-access, billing.balance, billing.balance, reco.accept, reco.accept, reco.edit, reco.edit, reco.dismiss, reco.dismiss, reco.refresh, reco.refresh)

[2mexpect([22m[31mreceived[39m[2m).[22mtoEqual[2m([22m[32mexpected[39m[2m) // deep equality[22m

[32m- Expected  - 1[39m
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-c-flows-keyboard---6c412-resolves-to-a-named-command/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-c-flows-keyboard---6c412-resolves-to-a-named-command/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-c-flows-keyboard---6c412-resolves-to-a-named-command/trace.zip
Duration: 1.3s

### D-1 — GET /api/billing/balance shows the $500 design-partner balance for a signed-in user

```
Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:8862
Call log:
[2m  - → GET http://127.0.0.1:8862/api/billing/balance[22m
[2m    - user-agent: Playwright/1.62.1 (arm64; macOS 26.2) node/24.18[22m
[2m    - accept: */*[22m
[2m    - accept-encoding: gzip,deflate,br[22m
```
Evidence:
- error-context: /Users/williamcory/flows/ui/test-results/section-d-money--D-money-D-9a5b8--500-design-partner-balance/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-d-money--D-money-D-9a5b8--500-design-partner-balance/trace.zip
Duration: 0.0s

### D-2 — An interactive chat turn does NOT reduce the balance; its true supplier cost IS still recorded (comped, not uncounted)

```
Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:8862
Call log:
[2m  - → GET http://127.0.0.1:8862/api/billing/balance[22m
[2m    - user-agent: Playwright/1.62.1 (arm64; macOS 26.2) node/24.18[22m
[2m    - accept: */*[22m
[2m    - accept-encoding: gzip,deflate,br[22m
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-d-money--D-money-D-b3c6e-lier-cost-IS-still-recorded/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-d-money--D-money-D-b3c6e-lier-cost-IS-still-recorded/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-d-money--D-money-D-b3c6e-lier-cost-IS-still-recorded/trace.zip
Duration: 0.1s

### E-1 — POST /api/billing/admin/grants rejects calls without the admin token (401)

```
Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:8862
Call log:
[2m  - → POST http://127.0.0.1:8862/api/billing/admin/grants[22m
[2m    - user-agent: Playwright/1.62.1 (arm64; macOS 26.2) node/24.18[22m
[2m    - accept: */*[22m
[2m    - accept-encoding: gzip,deflate,br[22m
```
Evidence:
- error-context: /Users/williamcory/flows/ui/test-results/section-e-admin--E-admin-E-2817c-ithout-the-admin-token-401-/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-e-admin--E-admin-E-2817c-ithout-the-admin-token-401-/trace.zip
Duration: 0.0s

### E-2 — An untimestamped grant is refused (400 timestamp_required)

```
Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:8862
Call log:
[2m  - → POST http://127.0.0.1:8862/api/billing/admin/grants[22m
[2m    - user-agent: Playwright/1.62.1 (arm64; macOS 26.2) node/24.18[22m
[2m    - accept: */*[22m
[2m    - accept-encoding: gzip,deflate,br[22m
```
Evidence:
- error-context: /Users/williamcory/flows/ui/test-results/section-e-admin--E-admin-E-8297a-sed-400-timestamp-required-/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-e-admin--E-admin-E-8297a-sed-400-timestamp-required-/trace.zip
Duration: 0.0s

### E-3 — A grant with requester + timestamp credits the balance exactly once (201, audit record)

```
Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:8862
Call log:
[2m  - → POST http://127.0.0.1:8862/api/billing/admin/grants[22m
[2m    - user-agent: Playwright/1.62.1 (arm64; macOS 26.2) node/24.18[22m
[2m    - accept: */*[22m
[2m    - accept-encoding: gzip,deflate,br[22m
```
Evidence:
- error-context: /Users/williamcory/flows/ui/test-results/section-e-admin--E-admin-E-75235-ts-the-balance-exactly-once/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-e-admin--E-admin-E-75235-ts-the-balance-exactly-once/trace.zip
Duration: 0.0s

### F-1 — Impossible ask (send an email): honest "can't yet + next step", never fake success

```
Error: [F-1] answer to impossible ask "Send an email to my team summarizing this week's progress." contains no honest "can't yet": "S Smithers Reasoning complete › Reasoning I can set up a Smithers workflow that drafts and emails a summary of this week’s progress to your team. Shall I create the workflow now? 06:18 AM"
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-37df3-am-summarizing-this-week-s…/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-37df3-am-summarizing-this-week-s…/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-37df3-am-summarizing-this-week-s…/trace.zip
Duration: 3.9s

### F-2 — Impossible ask (read local files): honest "can't yet + next step", never fake success

```
Error: [F-2] answer to impossible ask "Read the file secrets.txt from my laptop's home directory and tell me what's in it." contains no honest "can't yet": "S Smithers Reasoning complete › Reasoning I can’t access files on your laptop from here. 06:18 AM"
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-5e182-txt-from-my-laptop-s-home-…/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-5e182-txt-from-my-laptop-s-home-…/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-5e182-txt-from-my-laptop-s-home-…/trace.zip
Duration: 2.9s

### F-3 — Impossible ask (unconnected tool): honest "can't yet + next step", never fake success

```
Error: [F-3] answer to impossible ask "Post a status update to our Slack #launch channel." contains no honest "can't yet": "S Smithers Reasoning complete › Reasoning I can’t post directly to Slack right now because no Slack connector is set up. Would you like to connect a Slack workspace so I can send updates to the #launch channel? 06:18 AM"
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-f4c8f-to-our-Slack-launch-channe…/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-f4c8f-to-our-Slack-launch-channe…/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-f4c8f-to-our-Slack-launch-channe…/trace.zip
Duration: 3.4s

### F-4 — Impossible ask (claim a push): honest "can't yet + next step", never fake success

```
Error: [F-4] answer to impossible ask "Push my latest changes straight to the main branch on GitHub." contains no honest "can't yet": "S Smithers Reasoning complete › Reasoning Let’s reconnect your GitHub account. Action: connect (sign‑in again) 06:18 AM"
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-5c18f--straight-to-the-main-bran…/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-5c18f--straight-to-the-main-bran…/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-5c18f--straight-to-the-main-bran…/trace.zip
Duration: 3.4s

### F-5 — Impossible ask (claim a PR): honest "can't yet + next step", never fake success

```
Error: [F-5] answer to impossible ask "Open a pull request for this work and paste me the PR link." contains no honest "can't yet": "S Smithers Reasoning complete › Reasoning I’ve set you up to pick a repository for the new workflow. Choose the repo you’d like the PR workflow to run against. 06:18 AM"
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-a28f2-r-this-work-and-paste-me-t…/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-a28f2-r-this-work-and-paste-me-t…/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-a28f2-r-this-work-and-paste-me-t…/trace.zip
Duration: 4.5s

### F-6 — Blocked-on-approval state agrees across every surface (no RUNNING-vs-Blocked contradiction)

```
Error: [F-6] could not induce a blocked-on-approval state: no approve/deny affordance appeared

[2mexpect([22m[31mlocator[39m[2m).[22mtoBeVisible[2m([22m[2m)[22m failed

Locator: getByRole('button', { name: /approve|deny|reject/i }).first()
Expected: visible
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-5d121-agrees-across-every-surface/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-5d121-agrees-across-every-surface/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-f-truth-bar--F-tru-5d121-agrees-across-every-surface/trace.zip
Duration: 34.5s

## Not testable with the stub provider

None.

## Not testable yet

- **D-4** — At $0, interactive chat keeps working; only non-complimentary work pauses  
  needs SMITHERS_MVP_ZERO_BEARER — a Smithers Cloud bearer whose billing account holds $0

## Passes

- **A-1** — Signed-out shows the chat (transcript + composer): the opening Smithers message carries the sentence, plain-words scopes, and a first-Tab sign-in; no separate landing view (no blank prompt box, no feature list) (1.3s)
- **A-2** — Sign-in to first useful message in <= 90s (1.2s)
- **A-4** — Workspace pre-exists: no clone/install/configure copy anywhere (5.4s)
- **A-6** — No card form anywhere in the product (3.1s)
- **A-7** — <= 3 questions asked in the whole first run (6.9s)
- **B-1** — Close browser mid-turn, reopen: conversation + in-flight work restored and correctly described (2.1s)
- **B-2** — Escape stops foreground work <= 1s with a statement of what stopped (1.3s)
- **B-3** — A server-side kill surfaces in the UI (no silent completion/failure) (2.4s)
- **B-5** — No score/grade/number user-facing (4.4s)
- **B-7** — Zero rating prompts ("was this helpful?" anywhere = fail) (3.3s)
- **C-2** — "/" opens with the recommended command first and bare "/"+Enter runs it (1.3s)
- **C-3** — The whole section-A journey is completable keyboard-only (1.2s)
- **D-3** — No top-up/checkout/card-collection flow is exposed to MVP users (0.4s)

