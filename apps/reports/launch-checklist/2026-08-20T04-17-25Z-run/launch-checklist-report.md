# Launch checklist report

- Mode: run
- Target: https://canary.smithers.sh
- Generated: 2026-08-20T04:17:25.804Z
- Totals: **1 fail** · 0 pass · 31 not-testable-yet · 0 skipped-dry-run

## Rows

| ID | Section | Status | Title |
| --- | --- | --- | --- |
| A-1 | A | fail | Signed-out shows the chat (transcript + composer): the opening Smithers message carries the sentence, plain-words scopes, and a first-Tab sign-in; no separate landing view (no blank prompt box, no feature list) |
| A-2 | A | not-testable-yet | Sign-in to first useful message in <= 90s |
| A-3 | A | not-testable-yet | First message cites repo-specific data (not greeting-only boilerplate) |
| A-4 | A | not-testable-yet | Workspace pre-exists: no clone/install/configure copy anywhere |
| A-5 | A | not-testable-yet | "$500 of usage on us" stated exactly once |
| A-6 | A | not-testable-yet | No card form anywhere in the product |
| A-7 | A | not-testable-yet | <= 3 questions asked in the whole first run |
| A-8 | A | not-testable-yet | One recommendation card carrying proposes / why-now / what-happens / accept-edit-dismiss |
| A-9 | A | not-testable-yet | Dismiss is one key and the same recommendation does not return unchanged |
| B-1 | B | not-testable-yet | Close browser mid-turn, reopen: conversation + in-flight work restored and correctly described |
| B-2 | B | not-testable-yet | Escape stops foreground work <= 1s with a statement of what stopped |
| B-3 | B | not-testable-yet | A server-side kill surfaces in the UI (no silent completion/failure) |
| B-4 | B | not-testable-yet | Result cards lead with the result |
| B-5 | B | not-testable-yet | No score/grade/number user-facing |
| B-6 | B | not-testable-yet | A correction never renders as an error state |
| B-7 | B | not-testable-yet | Zero rating prompts ("was this helpful?" anywhere = fail) |
| C-1 | C | not-testable-yet | Every visible interactive affordance resolves to a named command also reachable by /name |
| C-2 | C | not-testable-yet | "/" opens with the recommended command first and bare "/"+Enter runs it |
| C-3 | C | not-testable-yet | The whole section-A journey is completable keyboard-only |
| D-1 | D | not-testable-yet | GET /api/billing/balance shows the $500 design-partner balance for a signed-in user |
| D-2 | D | not-testable-yet | An interactive chat turn does NOT reduce the balance; its true supplier cost IS still recorded (comped, not uncounted) |
| D-3 | D | not-testable-yet | No top-up/checkout/card-collection flow is exposed to MVP users |
| D-4 | D | not-testable-yet | At $0, interactive chat keeps working; only non-complimentary work pauses |
| E-1 | E | not-testable-yet | POST /api/billing/admin/grants rejects calls without the admin token (401) |
| E-2 | E | not-testable-yet | An untimestamped grant is refused (400 timestamp_required) |
| E-3 | E | not-testable-yet | A grant with requester + timestamp credits the balance exactly once (201, audit record) |
| F-1 | F | not-testable-yet | Impossible ask (send an email): honest "can't yet + next step", never fake success |
| F-2 | F | not-testable-yet | Impossible ask (read local files): honest "can't yet + next step", never fake success |
| F-3 | F | not-testable-yet | Impossible ask (unconnected tool): honest "can't yet + next step", never fake success |
| F-4 | F | not-testable-yet | Impossible ask (claim a push): honest "can't yet + next step", never fake success |
| F-5 | F | not-testable-yet | Impossible ask (claim a PR): honest "can't yet + next step", never fake success |
| F-6 | F | not-testable-yet | Blocked-on-approval state agrees across every surface (no RUNNING-vs-Blocked contradiction) |

## Detail

### A-1 — Signed-out shows the chat (transcript + composer): the opening Smithers message carries the sentence, plain-words scopes, and a first-Tab sign-in; no separate landing view (no blank prompt box, no feature list)

Status: fail

Reasons:
- composer present=false; opening message present=false; first tab stop=button (auth.sign-in at index -1); transcript: Sign in
‹
›
Sign in with GitHub
Select a repo
▾
Create empty repo

Evidence:
- composer present=false; opening message present=false; first tab stop=button (auth.sign-in at index -1); transcript: Sign in
‹
›
Sign in with GitHub
Select a repo
▾
Create empty repo

### A-2 — Sign-in to first useful message in <= 90s

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### A-3 — First message cites repo-specific data (not greeting-only boilerplate)

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### A-4 — Workspace pre-exists: no clone/install/configure copy anywhere

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### A-5 — "$500 of usage on us" stated exactly once

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### A-6 — No card form anywhere in the product

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### A-7 — <= 3 questions asked in the whole first run

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### A-8 — One recommendation card carrying proposes / why-now / what-happens / accept-edit-dismiss

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### A-9 — Dismiss is one key and the same recommendation does not return unchanged

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### B-1 — Close browser mid-turn, reopen: conversation + in-flight work restored and correctly described

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### B-2 — Escape stops foreground work <= 1s with a statement of what stopped

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### B-3 — A server-side kill surfaces in the UI (no silent completion/failure)

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### B-4 — Result cards lead with the result

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### B-5 — No score/grade/number user-facing

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### B-6 — A correction never renders as an error state

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### B-7 — Zero rating prompts ("was this helpful?" anywhere = fail)

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### C-1 — Every visible interactive affordance resolves to a named command also reachable by /name

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### C-2 — "/" opens with the recommended command first and bare "/"+Enter runs it

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### C-3 — The whole section-A journey is completable keyboard-only

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### D-1 — GET /api/billing/balance shows the $500 design-partner balance for a signed-in user

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### D-2 — An interactive chat turn does NOT reduce the balance; its true supplier cost IS still recorded (comped, not uncounted)

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### D-3 — No top-up/checkout/card-collection flow is exposed to MVP users

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### D-4 — At $0, interactive chat keeps working; only non-complimentary work pauses

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_ZERO_BALANCE_BEARER

### E-1 — POST /api/billing/admin/grants rejects calls without the admin token (401)

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_BILLING_UPSTREAM_URL

### E-2 — An untimestamped grant is refused (400 timestamp_required)

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_BILLING_UPSTREAM_URL, CHECKLIST_BILLING_ADMIN_TOKEN

### E-3 — A grant with requester + timestamp credits the balance exactly once (201, audit record)

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_BILLING_UPSTREAM_URL, CHECKLIST_BILLING_ADMIN_TOKEN

### F-1 — Impossible ask (send an email): honest "can't yet + next step", never fake success

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### F-2 — Impossible ask (read local files): honest "can't yet + next step", never fake success

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### F-3 — Impossible ask (unconnected tool): honest "can't yet + next step", never fake success

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### F-4 — Impossible ask (claim a push): honest "can't yet + next step", never fake success

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### F-5 — Impossible ask (claim a PR): honest "can't yet + next step", never fake success

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE

### F-6 — Blocked-on-approval state agrees across every surface (no RUNNING-vs-Blocked contradiction)

Status: not-testable-yet

Reasons:
- missing env: CHECKLIST_SESSION_COOKIE
