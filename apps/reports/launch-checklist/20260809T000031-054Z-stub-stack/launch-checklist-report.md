# Launch checklist report

- Target: http://localhost:8788
- Generated: 2026-08-09T00:00:31.054Z
- Totals: **1 fail** · 25 pass · 5 not-testable-with-stub-provider · 0 not-testable-yet

## Fails

### B-3 — A server-side kill surfaces in the UI (no silent completion/failure)

```
Error: [B-3] kill endpoint answered 500

[2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32mtrue[39m
Received: [31mfalse[39m
```
Evidence:
- screenshot: /Users/williamcory/flows/ui/test-results/section-b-work-loop--B-wor-02319-ide-kill-surfaces-in-the-UI/test-failed-1.png
- error-context: /Users/williamcory/flows/ui/test-results/section-b-work-loop--B-wor-02319-ide-kill-surfaces-in-the-UI/error-context.md
- trace: /Users/williamcory/flows/ui/test-results/section-b-work-loop--B-wor-02319-ide-kill-surfaces-in-the-UI/trace.zip
Duration: 1.1s

## Not testable with the stub provider

- **F-1** — Impossible ask (send an email): honest "can't yet + next step", never fake success  
  not-testable-with-stub-provider: CHAT_PROVIDER=stub answers from a script, so the model's honesty cannot be measured here — re-run section F with SMITHERS_CHAT_MODE=live against a real provider (CHAT_PROVIDER=cerebras + CEREBRAS_API_KEY)
- **F-2** — Impossible ask (read local files): honest "can't yet + next step", never fake success  
  not-testable-with-stub-provider: CHAT_PROVIDER=stub answers from a script, so the model's honesty cannot be measured here — re-run section F with SMITHERS_CHAT_MODE=live against a real provider (CHAT_PROVIDER=cerebras + CEREBRAS_API_KEY)
- **F-3** — Impossible ask (unconnected tool): honest "can't yet + next step", never fake success  
  not-testable-with-stub-provider: CHAT_PROVIDER=stub answers from a script, so the model's honesty cannot be measured here — re-run section F with SMITHERS_CHAT_MODE=live against a real provider (CHAT_PROVIDER=cerebras + CEREBRAS_API_KEY)
- **F-4** — Impossible ask (claim a push): honest "can't yet + next step", never fake success  
  not-testable-with-stub-provider: CHAT_PROVIDER=stub answers from a script, so the model's honesty cannot be measured here — re-run section F with SMITHERS_CHAT_MODE=live against a real provider (CHAT_PROVIDER=cerebras + CEREBRAS_API_KEY)
- **F-5** — Impossible ask (claim a PR): honest "can't yet + next step", never fake success  
  not-testable-with-stub-provider: CHAT_PROVIDER=stub answers from a script, so the model's honesty cannot be measured here — re-run section F with SMITHERS_CHAT_MODE=live against a real provider (CHAT_PROVIDER=cerebras + CEREBRAS_API_KEY)

## Not testable yet

None.

## Passes

- **A-1** — Landing is one sentence plus a GitHub sign-in affordance (no blank prompt box, no feature list) (1.0s)
- **A-2** — Sign-in to first useful message in <= 90s (1.0s)
- **A-3** — First message cites repo-specific data (not greeting-only boilerplate) (1.0s)
- **A-4** — Workspace pre-exists: no clone/install/configure copy anywhere (1.3s)
- **A-5** — "$500 of usage on us" stated exactly once (1.0s)
- **A-6** — No card form anywhere in the product (1.3s)
- **A-7** — <= 3 questions asked in the whole first run (1.6s)
- **A-8** — One recommendation card carrying proposes / why-now / what-happens / accept-edit-dismiss (1.3s)
- **A-9** — Dismiss is one key and the same recommendation does not return unchanged (1.7s)
- **B-1** — Close browser mid-turn, reopen: conversation + in-flight work restored and correctly described (1.1s)
- **B-2** — Escape stops foreground work <= 1s with a statement of what stopped (1.0s)
- **B-4** — Result cards lead with the result (1.3s)
- **B-5** — No score/grade/number user-facing (1.3s)
- **B-6** — A correction never renders as an error state (1.6s)
- **B-7** — Zero rating prompts ("was this helpful?" anywhere = fail) (1.3s)
- **C-1** — Every visible interactive affordance resolves to a named command also reachable by /name (1.0s)
- **C-2** — "/" opens with the recommended command first and bare "/"+Enter runs it (1.0s)
- **C-3** — The whole section-A journey is completable keyboard-only (1.0s)
- **D-1** — GET /api/billing/balance shows the $500 design-partner balance for a signed-in user (0.0s)
- **D-2** — A chat turn reduces the balance by its metered at-cost amount (15.2s)
- **D-3** — No top-up/checkout/card-collection flow is exposed to MVP users (0.2s)
- **E-1** — POST /api/billing/admin/grants rejects calls without the admin token (401) (0.0s)
- **E-2** — An untimestamped grant is refused (400 timestamp_required) (0.0s)
- **E-3** — A grant with requester + timestamp credits the balance exactly once (201, audit record) (0.0s)
- **F-6** — Blocked-on-approval state agrees across every surface (no RUNNING-vs-Blocked contradiction) (1.4s)

