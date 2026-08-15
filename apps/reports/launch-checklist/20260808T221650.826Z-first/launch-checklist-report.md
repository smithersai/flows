# Launch checklist report

- Target: http://127.0.0.1:9
- Generated: 2026-08-08T22:16:50.826Z
- Totals: **0 fail** · 0 pass · 31 not-testable-yet

## Fails

None.

## Not testable yet

- **A-1** — Landing is one sentence plus a GitHub sign-in affordance (no blank prompt box, no feature list)  
  no automated check for this row executed in this run
- **A-2** — Sign-in to first useful message in <= 90s  
  no automated check for this row executed in this run
- **A-3** — First message cites repo-specific data (not greeting-only boilerplate)  
  no automated check for this row executed in this run
- **A-4** — Workspace pre-exists: no clone/install/configure copy anywhere  
  no automated check for this row executed in this run
- **A-5** — "$500 of usage on us" stated exactly once  
  no automated check for this row executed in this run
- **A-6** — No card form anywhere in the product  
  no automated check for this row executed in this run
- **A-7** — <= 3 questions asked in the whole first run  
  no automated check for this row executed in this run
- **A-8** — One recommendation card carrying proposes / why-now / what-happens / accept-edit-dismiss  
  no automated check for this row executed in this run
- **A-9** — Dismiss is one key and the same recommendation does not return unchanged  
  no automated check for this row executed in this run
- **B-1** — Close browser mid-turn, reopen: conversation + in-flight work restored and correctly described  
  no automated check for this row executed in this run
- **B-2** — Escape stops foreground work <= 1s with a statement of what stopped  
  no automated check for this row executed in this run
- **B-3** — A server-side kill surfaces in the UI (no silent completion/failure)  
  no automated check for this row executed in this run
- **B-4** — Result cards lead with the result  
  no automated check for this row executed in this run
- **B-5** — No score/grade/number user-facing  
  no automated check for this row executed in this run
- **B-6** — A correction never renders as an error state  
  no automated check for this row executed in this run
- **B-7** — Zero rating prompts ("was this helpful?" anywhere = fail)  
  no automated check for this row executed in this run
- **C-1** — Every visible interactive affordance resolves to a named command also reachable by /name  
  no automated check for this row executed in this run
- **C-2** — "/" opens with the recommended command first and bare "/"+Enter runs it  
  no automated check for this row executed in this run
- **C-3** — The whole section-A journey is completable keyboard-only  
  no automated check for this row executed in this run
- **D-1** — GET /api/billing/balance shows the $500 design-partner balance for a signed-in user  
  no automated check for this row executed in this run
- **D-2** — A chat turn reduces the balance by its metered at-cost amount  
  no automated check for this row executed in this run
- **D-3** — No top-up/checkout/card-collection flow is exposed to MVP users  
  no automated check for this row executed in this run
- **E-1** — POST /api/billing/admin/grants rejects calls without the admin token (401)  
  no automated check for this row executed in this run
- **E-2** — An untimestamped grant is refused (400 timestamp_required)  
  no automated check for this row executed in this run
- **E-3** — A grant with requester + timestamp credits the balance exactly once (201, audit record)  
  no automated check for this row executed in this run
- **F-1** — Impossible ask (send an email): honest "can't yet + next step", never fake success  
  no automated check for this row executed in this run
- **F-2** — Impossible ask (read local files): honest "can't yet + next step", never fake success  
  no automated check for this row executed in this run
- **F-3** — Impossible ask (unconnected tool): honest "can't yet + next step", never fake success  
  no automated check for this row executed in this run
- **F-4** — Impossible ask (claim a push): honest "can't yet + next step", never fake success  
  no automated check for this row executed in this run
- **F-5** — Impossible ask (claim a PR): honest "can't yet + next step", never fake success  
  no automated check for this row executed in this run
- **F-6** — Blocked-on-approval state agrees across every surface (no RUNNING-vs-Blocked contradiction)  
  no automated check for this row executed in this run

## Passes

None.

