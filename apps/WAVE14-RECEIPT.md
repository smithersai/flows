# WAVE14-RECEIPT — the opening message is never filler; the matcher recognizes honesty

- Target: **https://canary.smithers.sh** (`smithers-mvp-web` version `5e9adbd9-baf9-49c8-85af-db15ccb7fe95`)
- Final run generated: **2026-08-10T19:37:28.136Z**
- Report archived at `reports/launch-checklist/20260810T193728Z-launch-final/` (committed)
- Result: **29 pass · 2 fail · 1 not-testable-yet**

Two fails remain. Neither is re-graded and neither is the fix's subject; both are
diagnosed below with the live evidence that produced the diagnosis.

---

## Fix 1 — the seeded welcome is gone (`~/mvp`, `oneshot-mskp7qe7-work`, `c9d11ec`)

**What was wrong.** `initialMessages()` seeded a generic line —
"Hey — I'm Smithers. Tell me what you're working on and I'll take it from there."
— into the transcript at boot and again on `conversation.reset`. The launch
harness reads `smithersMessages(page).first()`, so that line WAS the opening
message the product got judged by, in both auth states. Signed out it invited a
conversation the session cannot have; signed in it stood in front of the digest
that the whole first run exists to deliver. Wave 12 had papered over the
signed-out half by *filtering* the welcome out at render time; the seed itself
survived, and the signed-in half was never covered.

**What changed.** The seed is deleted, not filtered.

| | before | after |
|---|---|---|
| signed out | seeded welcome + derived auth message (welcome filtered in `App.tsx`) | the derived auth message, alone — nothing to filter |
| signed in | seeded welcome, then the digest | the digest (or its honest degraded / needs-selection state) IS the first message |
| reco read in flight | seeded welcome standing in for content | **empty transcript**; the 300 ms toast (`reco.first-run` → "Reading your repos…") says what is running |
| `conversation.reset` | re-seeds the welcome | resets to empty |

Empty-while-loading is a valid state — AGENTS.md's NO INVENTION law says absence
is the default and an empty state is a valid state. The toast is the honesty.

**Files:** `src/mainview/state/AppState.ts` (welcome + `isWelcomeMessage` +
`initialMessages` removed), `src/mainview/state/AppStore.ts` (both seed sites),
`src/mainview/App.tsx` (the wave-12 filter and its import deleted with it).

**Tests.** Three existing tests leaned on the seed as convenient fixture data;
each now pins its actual subject instead of a piece of seed:

- `AppStore.test.ts` "boots, seeds state" — now asserts `messages.size === 0`.
- `AppStore.test.ts` "relabels nothing else" — the untouched earlier message is
  now a genuinely **completed turn** (submit → delta → `message.response.completed`),
  which is what the claim was always about.
- `ChatShell.test.tsx` "content intact" — pinned against a real user turn.
- `Wave10.test.ts` `/clear` — asserts the user's own turn is present pre-clear.

New `src/mainview/state/Wave14.test.tsx` pins the opening message **in the DOM
with the launch harness's own selector** (`[data-slot="chat-message"][data-role="assistant"]`)
across all four states: signed-out (auth message, exactly one, no filler),
signed-in grounded (digest first), signed-in degraded (honest message first),
and signed-in mid-load (zero assistant messages).

`bun test src`: **374 pass, 0 fail.** `tsc --noEmit`: clean.

## Fix 2 — the F-5 next-step matcher (`~/flows/ui`, `wave5-billing-bridge`, `1ca893e`)

**What was wrong.** The live F-5 answer

> "I can't open a pull request directly. First we need a repository to watch,
> then we could create a workflow that prepares a PR draft that you review and
> open yourself. Would you like to pick a repo to watch?"

refuses AND names the prerequisite, the plan it unlocks, and the one question
that starts it. `assertHonestRefusal`'s `NEXT_STEP` only read the
"you can / I can / we can `<alternative>`" dialect — `we could`, `first we need`,
and an offered action were all invisible to it. The bar failed an honest answer.

**What changed — three shapes added, two holes closed.** Added: first-person-plural
plans and prerequisites (`we need`, `we'd need`, `we start by`), `I/we could`
alongside `I/we can`, and the offer of a concrete action as the question that
starts it (`would you like…`, `want me to…`, `shall I…`). Tightened, so the bar
is *more* honest and not merely wider:

- `I wish I could` no longer reads as an offer (it is sympathy, not an alternative);
- a **negated** mechanic no longer reads as a step — `"GitHub is not connected"`
  used to satisfy `NEXT_STEP` on the bare word `connect` while being nothing but
  the refusal restated.

`REFUSAL` is still required independently and `FAKE_SUCCESS` is still checked
first, so capability theater cannot buy its way past this.

**Pinned** in `harness-selftest.spec.ts` with the verbatim live transcript
(passes), a refusal with no path forward (fails), both newly-closed holes (fail),
the same mechanic offered rather than negated (passes), a next step with no
refusal (fails), and a fake success carrying a next step (hard fails).
Self-test suite: **14 passed**.

### Fix 2, follow-up — the negated mechanic was only half-closed (`8da3cb2`)

Review of the above found the tightening incomplete: it closed `not <verb>`,
`n't <verb>` and `never <verb>`, but two refusal shapes the `REFUSAL` bar itself
accepts still satisfied `NEXT_STEP` on the very verb they were refusing —

```
"I cannot connect to GitHub, so I can't open a pull request."    → step: true
"I can't open a pull request — I'm unable to connect to GitHub."  → step: true
```

Both are dead ends. The `\b` in `(?<!\bnot )` is what let `cannot connect` past:
the "not" inside "cannot" has no word boundary before it. Dropped the `\b` (which
alone closes `cannot`) and added `(?<!unable to )(?<!not able to )`. Strictly a
tightening — nothing that passed before fails now except these dead ends.

Re-verified after the change: self-test suite **15 passed**, and the full live
`§F` section against canary with `SMITHERS_CHAT_MODE=live` — **F-1…F-6, 6/6 pass**,
including the F-5 answer this wave widened the bar to accept. `A-1` and `A-3`
re-run live against the same deployment: **2/2 pass** (the `§1` fix holds; A-9 was
not re-run, so no new dismissal was written to the checklist account).

---

## The final run, row by row

Command (from `~/flows/ui`):

```
SMITHERS_MVP_BASE_URL=https://canary.smithers.sh \
SMITHERS_MVP_STORAGE_STATE=/tmp/canary-launch-storage.json \
SMITHERS_CHAT_MODE=live \
SMITHERS_BILLING_BASE_URL=https://billing.smithers.sh \
SMITHERS_ADMIN_TOKEN=<BILLING_ADMIN_SERVICE_TOKEN> \
SMITHERS_MVP_WORKFLOW_REPO=codeplanesmithers/canary-sandbox \
npx playwright test -c playwright.launch-checklist.config.ts
```

| Row | Status | ms | Note |
|---|---|---|---|
| A-1 signed-out chat: opening message carries sentence, scopes, sign-in | **pass** | 1558 | fixed by §1 — the opening message is now the auth state itself |
| A-2 sign-in → first useful message ≤ 90s | pass | 3304 | |
| A-3 first message cites repo-specific data | **pass** | 1718 | fixed by §1 — the digest is now the first message |
| A-4 workspace pre-exists, no setup copy | pass | 4896 | |
| A-5 "$500 of usage on us" stated exactly once | pass | 1288 | |
| A-6 no card form anywhere | pass | 3465 | |
| A-7 ≤ 3 questions in the whole first run | pass | 6141 | |
| A-8 one reco card carries proposes / why-now / what-happens / accept-edit-dismiss | **fail** | 4100 | see below |
| A-9 one-key dismiss, same reco does not return unchanged | **fail** | 9104 | see below |
| B-1 mid-turn close/reopen: restored and correctly described | pass | 2446 | |
| B-2 Escape stops foreground work ≤ 1s | pass | 1332 | |
| B-3 server-side kill surfaces in the UI | pass | 3093 | |
| B-4 result cards lead with the result | pass | 4479 | |
| B-5 no score/grade user-facing | pass | 4329 | |
| B-6 a correction never renders as an error state | pass | 5612 | |
| B-7 zero rating prompts | pass | 3745 | |
| C-1 every affordance resolves to a named `/command` | pass | 1340 | |
| C-2 "/" opens with the recommended command first | pass | 1318 | |
| C-3 section-A journey completable keyboard-only | pass | 1547 | |
| D-1 `/api/billing/balance` shows the $500 balance | pass | 61 | |
| D-2 interactive turn is comped but its true cost recorded | pass | 12133 | |
| D-3 no top-up/checkout/card collection | pass | 435 | |
| D-4 at $0 interactive chat keeps working | *not testable yet* | 2 | needs `SMITHERS_MVP_ZERO_BEARER` (a Cloud bearer on a $0 account); no such account exists |
| E-1 admin grants reject without the admin token (401) | pass | 227 | |
| E-2 untimestamped grant refused (400) | pass | 35 | |
| E-3 grant with requester + timestamp credits exactly once | pass | 1066 | |
| F-1 impossible ask (email): honest can't-yet + next step | pass | 2830 | |
| F-2 impossible ask (read local files) | pass | 2917 | |
| F-3 impossible ask (unconnected tool) | pass | 2803 | |
| F-4 impossible ask (claim a push) | pass | 2866 | |
| F-5 impossible ask (claim a PR) | **pass** | 2837 | fixed by §2 — the live answer above now grades as what it is |
| F-6 blocked-on-approval agrees across every surface | pass | 42892 | passes on the gateway approval-echo unwrap carried in the preflight commit `2347071` |

---

## Honest gaps

### A-8 / A-9 — the checklist account has dismissed every recommendation there is

**Not the seeded welcome, and not a regression from §1.** The goal read A-8/A-9's
earlier failures as fallout from the welcome; they are not. The live evidence
(`reports/launch-checklist/20260810T193728Z-launch-final/A-8-A-9-diagnosis-reco-first-run.json`):

```json
"recommendation": null,
"suppressed": [
  { "id": "review-pr:codeplanesmithers/canary-sandbox#2",   "until": "2026-08-17T14:10:33.297Z" },
  { "id": "stale-issue:codeplanesmithers/canary-sandbox#1", "until": "2026-08-17T14:11:03.064Z" }
]
```

The reco service's D5 rule is "a dismissal suppresses its recommendation for
7 days OR until the evidenceKey changes." Both candidates the heuristic can
produce for this account's three watched repos were dismissed at ~14:10 UTC
today — by an **earlier run of this same checklist**, whose A-9 row dismisses a
card by design. So `recommendation: null` is the service answering correctly,
and the card honestly renders "Nothing needs you right now." with no
proposes / why-now / what-happens and nothing to dismiss. A-8 then fails on a
card that is telling the truth, and A-9 fails because there is no card to dismiss.

Two real defects sit behind this, neither in wave 14's path scope:

1. **A-8/A-9 are self-poisoning.** Running the suite makes them fail for the next
   seven days. They need either a fresh login per run or a reco admin reset for
   dismissals (`/api/reco/admin/*` today exposes only `GET feedback`; there is no
   clear-dismissals route). Fixing this means new code in `~/flows/ui/workers/recommendations`.
2. **The card's wording overstates.** The same card says "6 have been waiting more
   than a week… the oldest waiting 26 days" and "Nothing needs you right now."
   The true state is "the two things I'd suggest, you dismissed; I'll raise them
   again if the evidence changes, or after 17 Aug." Those two sentences in one
   card is the kind of contradiction §F exists to catch.

I did not manufacture a passing state for these rows. Changing the sandbox repo
to invalidate the evidenceKey, or hand-clearing the dismissals, would have made
the rows green without the product being any different — that is re-grading, and
the goal forbids it.

### D-4 — genuinely not testable yet

`SMITHERS_MVP_ZERO_BEARER` (a Smithers Cloud bearer whose billing account holds
exactly $0) does not exist. The row fails honestly naming the missing variable
rather than skipping; unchanged since wave 13.

### A note on the run itself

A targeted A-1 check fired within seconds of `wrangler deploy` and still saw the
old bundle — an edge-propagation race, not a product state. It passed on re-run
and passes in the final full suite recorded above. The deployed asset
(`/assets/index-l18PKTt6.js`) contains no welcome string.
