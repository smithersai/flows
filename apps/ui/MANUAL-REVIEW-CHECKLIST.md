# Manual review checklist — Smithers UI

Scope: `apps/ui` (the React renderer served as the web app and wrapped by
Electrobun), the `apps/server` Worker it calls, and the nine backing Cloudflare
Workers. Built from the code at `ceb784b6`: 88 registered flows (65 listed in
the slash menu, 23 hidden id-scoped actions, 30 user-only), 30 card kinds,
3 surfaces, 9 color themes.

Legend:

- `[auto]` — an automated launch-checklist row already asserts this. Run
  `pnpm --filter smithers-ui checklist -- --target <origin>` and read the
  report before testing by hand; only re-test by hand what the row cannot see
  (visual polish, copy tone, motion).
- `[gap]` — a known open defect. Expect the failure; the check is whether it
  is fixed, not whether it reproduces.
- Everything else is unverified by any automation. These are the rows that
  decide the release.

Record each row as pass / fail / not-reachable, with the origin and the commit
you tested. A row you could not reach is a finding, not a blank.

---

## §0 Before you start

- [x] **0.1** RESOLVED 2026-08-19. The canary served a pre-rename bundle
      (`assets/index-Dwyun-Xv.js`, `data-flow` absent) until it was redeployed;
      it now serves `assets/index-BHHXuMoZ.js` with 40 `data-flow` attributes,
      zero `data-command`, and `data-flows` on the shell. Re-confirm before any
      future run: fetch `/`, extract the `assets/index-*.js` name, and check the
      bundle contains `data-flow`. A browser row run against a stale bundle
      grades nothing, however many rows the runner claims to have checked.
- [ ] **0.2** Decide the surface under test and note it: local web
      (`bun run web`, port 5173), local worker (`bun run serve:local`),
      deployed canary, or the Electrobun desktop build. The nine backing
      workers are not deployed by `apps-deploy.yml`; if you test against a
      deployment, confirm which worker versions are live.
- [ ] **0.3** Run the automated pass and keep its report next to you:
      `pnpm --filter smithers-ui checklist -- --target <origin>`. `--dry-run`
      enumerates the rows without a target.
- [ ] **0.4** Provision two accounts: one fresh GitHub login that has never
      signed in (for onboarding and first-run), and one long-lived account
      with real repos, issues, and PRs.
- [ ] **0.5** Provision a third account parked at `$0` balance, or the
      `CHECKLIST_ZERO_BALANCE_BEARER` cookie, for the zero-balance rows.
- [ ] **0.6** `[gap]` Reserve a fresh login for the recommendation rows.
      Dismissing a recommendation suppresses it for 7 days and there is no
      reset route (`live-store-reset.ts` clears browser storage only), so a
      second pass on the same account grades nothing.
- [ ] **0.7** Test in both light and dark mode, and in at least one non-default
      theme. Several rows below only fail in one of them.

---

## §1 Signed-out state and access

- [ ] **1.1** Load the app signed out. The one offered next step is sign-in;
      nothing else is presented as available.
- [ ] **1.2** `/` while signed out lists `auth.sign-in` first and nothing that
      cannot work signed out.
- [ ] **1.3** Submitting a prompt while signed out produces the honest
      sign-in step, not a silent failure or a spinner that never resolves.
- [ ] **1.4** `/auth.request-access` from a signed-in, non-allowlisted account
      files a request and says so. Confirm it lands in `/admin.requests`.
- [ ] **1.5** A non-allowlisted account cannot reach admin flows. `/admin.*`
      is unregistered for them (the flow is absent, not present-and-refusing).
- [ ] **1.6** Signed-out copy carries no card-collection or pricing language.
      `[auto A-6]`

## §2 Sign-in

- [ ] **2.1** `/auth.sign-in` opens the GitHub OAuth start route and returns to
      the app signed in.
- [ ] **2.2** The scopes GitHub asks for match what the app claims it needs
      (`/api/auth/scopes`).
- [ ] **2.3** Cancel the OAuth consent screen halfway. The app returns to a
      clean signed-out state with an honest message, not a stuck spinner.
- [ ] **2.4** `/auth.sign-out` clears the session; a reload stays signed out;
      no stale name, balance, or repo list survives.
- [ ] **2.5** Sign in again in a second tab. Both tabs agree on identity
      without a manual reload.
- [ ] **2.6** Expire or delete the session cookie mid-session. The next action
      surfaces the sign-in step instead of failing opaquely.
- [ ] **2.7** Desktop only: `/api/auth/native/start` + `native/claim` hands off
      the browser sign-in back to the app window.

## §3 First run and onboarding

- [ ] **3.1** Sign-in to a first useful message in ≤ 90s on a fresh account.
      `[auto A-2]` Time it by hand too — the automated budget is a ceiling, not
      a target.
- [ ] **3.2** The first message cites something specific about the user's
      repos, not greeting boilerplate. `[auto A-3]`
- [ ] **3.3** No clone, install, or configure copy appears anywhere in the
      first run. `[auto A-4]`
- [ ] **3.4** "$500 of usage on us" appears exactly once. `[auto A-5]`
      The `fresh`/`established` persona path grades product behavior as
      `verified-via-mock`; a live-GitHub first sign-in remains an optional,
      separate check.
- [ ] **3.5** The whole first run asks 3 questions or fewer. `[auto A-7]`
- [ ] **3.6** The repo chooser (`repos.watch`) appears as the one onboarding
      question. Toggling, `repos.watch.all`, `repos.watch.none`, and confirm
      all behave; the confirmed selection survives a reload.
- [ ] **3.7** A flow that needs repos (`flow.create`, `flow.run`) run before
      selection defers, runs the chooser, then resumes the original flow.
      Verify the resumed flow actually completes, with its original arguments.
- [ ] **3.8** A flow that needs sign-in run signed-out defers the same way
      through `auth.sign-in`.
- [ ] **3.9** An account with zero GitHub repos gets an honest empty state, not
      an empty chooser with a confirm button. The `zeroRepos` persona grades
      product behavior as `verified-via-mock`; optionally confirm the live
      GitHub seam with a real zero-repository account.
- [ ] **3.10** An account with 200+ repos: the chooser is usable, searchable
      or scrollable, and does not lock the frame. The `manyRepos200` persona
      grades product pagination as `verified-via-mock`; live GitHub remains a
      separate optional check.

## §4 The chat turn loop

- [ ] **4.1** Send a prompt. Streaming starts promptly; the first token is
      visible well before the turn ends.
- [ ] **4.2** Markdown renders: headings, lists, tables, links, inline code,
      fenced code with a language, and a very long unbroken token (no
      horizontal page scroll).
- [ ] **4.3** Reasoning blocks collapse and expand, and are collapsed by
      default.
- [ ] **4.4** Tool calls render as work, not as raw JSON echo. Check
      `scrubToolEcho` actually catches the echo in a real turn.
- [ ] **4.5** Copy on a message copies the rendered text; the button shows
      "Copied" and reverts.
- [ ] **4.6** `/retry` re-runs the last turn and does not duplicate the user
      message.
- [ ] **4.7** `/clear` clears the conversation and states what it kept.
- [ ] **4.8** Escape stops the turn in ≤ 1s and says what stopped. `[auto B-2]`
      Confirm by hand that the stopped turn is not silently resumed.
- [ ] **4.9** A server-side kill surfaces in the UI. `[auto B-3]` Verify the
      message names the cause, not just "failed".
- [ ] **4.10** A turn that fails mid-stream leaves a readable partial answer
      plus an honest note, not a blank bubble.
- [ ] **4.11** Send a second prompt while one is streaming. The behavior is
      defined and legible (queued or refused), never two interleaved streams.
- [ ] **4.12** Scroll position: the transcript follows new output when you are
      at the bottom and stays put when you have scrolled up.
- [ ] **4.13** A very long turn (50+ messages) still scrolls smoothly and the
      composer stays responsive.
- [ ] **4.14** A correction from the model never renders as an error state.
      `[auto B-6]`
- [ ] **4.15** No score, grade, or number is shown to the user. `[auto B-5]`
- [ ] **4.16** No "was this helpful?" rating prompt anywhere. `[auto B-7]`
- [ ] **4.17** `[gap]` There is no rate limit on the turn seam. Send turns
      rapidly and confirm the app degrades honestly rather than stacking work.

## §5 Composer and slash menu

- [ ] **5.1** `/` opens the menu with the recommended flow first, and bare `/`
      + Enter runs it. `[auto C-2]`
- [ ] **5.2** The recommendation order changes with state: typing →
      `chat.stop`; signed out → `auth.sign-in`; a waiting recommendation →
      `reco.accept` first; off the chat surface → `chat` first.
- [ ] **5.3** ArrowDown / ArrowUp move the highlight and wrap around; Enter
      runs the highlighted flow; Escape closes the menu without clearing the
      draft.
- [ ] **5.4** Filtering matches both name and summary, case-insensitively.
- [ ] **5.5** `[gap]` Exact-name precedence. Type `/stop` and `/chat` and
      `/world`. An exact name match should lead its own listing; today the
      listing is recommendation-then-registry order, so verify whether the
      exact match is reachable without arrowing.
- [ ] **5.6** With more than 8 matches, the listing caps at 8 and ranks the
      remainder by your recent commands. Verify recency actually reorders it.
- [ ] **5.7** Hidden flows (`repos.watch.toggle`, `card.maximize`,
      `approval.approve`, …) never appear in the menu but still run when typed.
- [ ] **5.8** `/stop` (alias) executes `chat.stop`.
- [ ] **5.9** A slash token that is not a registered flow goes to the agent as
      a prompt. Try `/hello there`, `/not-a-flow`, `/`, and `/ ` (slash space).
- [ ] **5.10** `/name <args>` only parses as a flow when the flow declares an
      args hint. `/clear now` should be a prompt; `/browser https://…` should
      be a flow.
- [ ] **5.11** Malformed arguments produce a readable error naming what was
      expected, not a schema dump. Try `/issues.view abc`,
      `/admin.grant xyz will`, `/env.set NOEQUALS`.
- [ ] **5.12** Shift+Enter inserts a newline; Enter submits; a multi-line draft
      grows the composer and then scrolls.
- [ ] **5.13** Paste a very long block and a code block into the composer.
- [ ] **5.14** The draft survives switching surfaces and returning.
- [ ] **5.15** The composer menu (surfaces dropdown): ArrowDown opens, arrows
      move, Enter invokes, Escape closes, a pointer press outside dismisses it
      without moving focus.

## §6 Flow dispatch and honesty of failure

- [ ] **6.1** Every visible interactive affordance resolves to a named flow
      that is also reachable by `/name`. `[auto C-1]` Sweep the UI by hand for
      buttons with no `data-flow`.
- [ ] **6.2** A user-invoked flow with an unmet requirement defers and resumes.
      An agent-invoked flow with an unmet requirement fails honestly with the
      reason and does not enqueue anything.
- [ ] **6.3** The 30 user-only flows are absent from the model's tool catalog.
      Ask the model to sign you out, change your theme, or send the composer;
      it should say it cannot rather than claim it did.
- [ ] **6.4** `/flows` lists everything a person can ask for, and the list
      matches the VISIBLE half of `data-flows` on the app shell. `data-flows`
      is the whole registry manifest, hidden id-scoped actions included, and
      §5.7 requires those never be listed to a person — so the two lists are
      the same list minus exactly that hidden set. Read as "matches
      `data-flows` outright" the two rows contradict each other; the hidden
      set is the difference, and any OTHER difference is the failure.
- [ ] **6.5** Every flow in Appendix A runs at least once. Use the appendix
      table as the tally.

## §7 Cards — shared chrome

- [ ] **7.1** Result cards lead with the result, not with the process.
      `[auto B-4]`
- [ ] **7.2** `card.maximize` / `card.minimize`: a card maximizes, Escape
      minimizes it, and focus returns somewhere sensible.
- [ ] **7.3** Card status pills are correct for each state: waiting, running,
      waiting-approval, done, failed. Check that no card sits on "running"
      after its work ended.
- [ ] **7.4** A blocked-on-approval state agrees across every surface — no
      RUNNING-vs-Blocked contradiction. `[auto F-6]`
- [ ] **7.5** Cards interleave with messages in the right order after a reload
      (ordinal and createdAt both).
- [ ] **7.6** A card whose upstream data is empty renders an empty state, not
      an empty box.
- [ ] **7.7** A card whose upstream call failed says what failed and offers the
      next step.
- [ ] **7.8** Long content inside a card scrolls inside the card; the page body
      never scrolls horizontally.

## §8 Cards — one row per kind

Run the flow, read the card, resize the window, switch theme, and reload.

- [ ] **8.1** `plan`
- [ ] **8.2** `approval` — approve and deny both, and confirm the decision
      reaches `/api/approvals/decision`
- [ ] **8.3** `status`
- [ ] **8.4** `balance` (`/billing.balance`)
- [ ] **8.5** `reco` — see §9
- [ ] **8.6** `grant-confirm` — confirm and cancel
- [ ] **8.7** `request-queue` — approve an entry
- [ ] **8.8** `reco-log`
- [ ] **8.9** `admin-health`
- [ ] **8.10** `repo-chooser`
- [ ] **8.11** `connect`
- [ ] **8.12** `world`
- [ ] **8.13** `browser` (`/browser <url>`) — a normal page, a 404, a page that
      blocks fetching, and a very large page
- [ ] **8.14** `flow-run` — including stop and retry
- [ ] **8.15** `workflow-list` — run a workflow from the card
- [ ] **8.16** `workflow-repo`
- [ ] **8.17** `issue-list`
- [ ] **8.18** `issue`
- [ ] **8.19** `pr-list`
- [ ] **8.20** `pr`
- [ ] **8.21** `keys`
- [ ] **8.22** `notifications`
- [ ] **8.23** `env`
- [ ] **8.24** `repo-import`
- [ ] **8.25** `branches`
- [ ] **8.26** `file-list`
- [ ] **8.27** `file` — a text file, a large file, a binary file, a missing file
- [ ] **8.28** `theme-picker`

## §9 Recommendations

- [ ] **9.1** One recommendation card carries proposes / why-now /
      what-happens / accept-edit-dismiss. `[auto A-8]`
- [ ] **9.2** Dismiss is one key, and the same recommendation does not return
      unchanged. `[auto A-9]` `[gap]` Use a fresh login; a dismissal suppresses
      for 7 days with no reset route.
- [ ] **9.3** Escape dismisses the recommendation from the composer (focus
      elsewhere) and from the card itself (focus on it) — one keypress, same
      flow, both times.
- [ ] **9.4** `reco.accept` runs the proposed work and the card moves to
      "acted".
- [ ] **9.5** `reco.edit` lets you change the proposal before it runs, and the
      edited version is what runs.
- [ ] **9.6** `reco.refresh` re-reads the recommendation.
- [ ] **9.7** Feedback reaches `/api/reco/feedback` and shows up in
      `/admin.feedback`.
- [ ] **9.8** A first-run recommendation appears for a fresh account
      (`/api/reco/first-run`) and is about that account's repos. The persona
      path grades the never-chosen chooser/product behavior as
      `verified-via-mock`; a live GitHub recommendation remains optional and
      separate.

## §10 World surface

- [ ] **10.1** `/world` opens the pane; `/chat` returns; the pane header's
      back button is clickable (it used to sit under the corner chrome).
- [ ] **10.2** `world.new-note` creates a note and focuses it.
- [ ] **10.3** The sidebar file tree lists notes and selects on click.
- [ ] **10.4** The markdown editor: typing, formatting, undo, paste, and a very
      long document.
- [ ] **10.5** Edits persist across a reload and across a surface switch.
- [ ] **10.6** `world.delete` shows the confirm dialog with the note's title,
      cancels cleanly, and deletes on confirm.
- [ ] **10.7** Zero notes renders the empty state with a working "Create a
      note" button.
- [ ] **10.8** The world content actually reaches the model — ask about
      something only a note says.

## §11 Connectors surface

> **Surface note (found live 2026-08-19).** Connectors are a NATIVE-only
> capability. The "Local repository" row renders only when
> `controller.nativeRepositories` exists, so on the web origin
> (`canary.smithers.sh`) no connector can be created — which makes 11.3, 11.4,
> 11.5 and 11.7 ungradeable there, with 0 `.connected-repository-card` and 0
> `button[aria-label^="Remove"]` in the DOM. Those rows are **not applicable to
> the web surface**, not failures: grade them on the Electrobun build (§27) and
> record them as N/A for web. 11.1, 11.2 and 11.6 DO apply to web — 11.6 is a
> real failure there (the empty state names no next step).


- [ ] **11.1** `/connect` opens the pane and lists connectors with the right
      state.
- [ ] **11.2** Keyboard navigation across connector rows works.
- [ ] **11.3** `connector.add` in both `read` and `read-write` modes.
- [ ] **11.4** `connector.downgrade` makes a connector read-only, and the
      change is visible immediately and after a reload.
- [ ] **11.5** `connector.remove` disconnects, with the aria-labelled remove
      control per connector.
- [ ] **11.6** Zero connectors renders an empty state that names the next step.
- [ ] **11.7** A connector whose backing repo disappeared renders honestly.

## §12 Repos and the GitHub App

- [ ] **12.1** `/repos.import` with and without an explicit `owner/repo`.
- [ ] **12.2** Import a large repo: progress is legible and the card ends in a
      terminal state.
- [ ] **12.3** Import a repo you do not have access to: honest refusal.
- [ ] **12.4** Import the same repo twice.
- [ ] **12.5** `/repos.app` reports the GitHub App's real installation state
      and links to the fix when it is not installed.
- [ ] **12.6** `/repos.watch <repo>` with an argument selects that repo.

## §13 Issues

- [ ] **13.1** `/issues.list`, and with `open`, `closed`, `all`.
- [ ] **13.2** `/issues.list` on a repo with zero issues.
- [ ] **13.3** `/issues.view <n>` renders the body and comments, including
      markdown and images.
- [ ] **13.4** `/issues.view` on a number that does not exist.
- [ ] **13.5** `/issues.create <title>` — the created issue exists on GitHub
      and the card links to it.
- [ ] **13.6** `/issues.close`, `/issues.reopen`, `/issues.comment`.
- [ ] **13.7** Every issues flow against a repo the user cannot write to:
      honest refusal, no fake success. `[auto F-*]`
- [ ] **13.8** The `[owner/repo]` argument works on all of them, and omitting
      it uses a sensible default the card names.

## §14 Pull requests and landings

- [ ] **14.1** `/prs.list`, including a repo with zero PRs.
- [ ] **14.2** `/prs.view <n>` shows reviews and checks with correct states
      (pending, passing, failing).
- [ ] **14.3** `/prs.create <title> [from:<bookmark>]` — with and without the
      bookmark argument.
- [ ] **14.4** `/prs.review <n> approve|request-changes|comment [text]` — all
      three verbs.
- [ ] **14.5** `/prs.land <n>` queues the merge and the card reflects the queue
      state, not a claimed merge. Confirm the claim matches GitHub.
- [ ] **14.6** Land a PR that cannot merge (conflicts, failing required
      checks): honest refusal naming the reason.
- [ ] **14.7** `[auto F-4] [auto F-5]` The model never claims a push or a PR it
      did not make. Ask it to push and to open a PR in a conversation with no
      write path.

## §15 Files, branches, environment

- [ ] **15.1** `/files.list` at the root and at a nested path.
- [ ] **15.2** `/files.list` on a path that does not exist.
- [ ] **15.3** `/files.read` on a plain text file, a README with markdown, a
      large file, a binary file, and a missing file. Each has its own honest
      rendering.
- [ ] **15.4** `/branches.list` shows bookmarks with their current heads.
- [ ] **15.5** `/env.view` masks secrets and says it is masking them.
- [ ] **15.6** `/env.set NAME=value` sets and confirms; the value never appears
      in plain text afterwards.
- [ ] **15.7** `/env.set` with a malformed argument.
- [ ] **15.8** `[auto F-2]` Ask the model to read a local file. It refuses
      honestly and names the next step.

## §16 Workflows, runs, and approvals

- [ ] **16.1** `/flow.create <description>` produces a workflow, and the
      created workflow is real on the workspace.
- [ ] **16.2** `flow.repo.choose` picks the owning repo when it is ambiguous.
- [ ] **16.3** `/flow.list` lists workspace workflows.
- [ ] **16.4** `/flow.run <name>` starts a run and the `flow-run` card follows
      it live (`/api/workflow/stream`, `/api/workflow/events`).
- [ ] **16.5** `flow.run.stop` stops watching, and says that is what it did
      (watching, not the run).
- [ ] **16.6** `flow.run.retry` re-checks the run.
- [ ] **16.7** A run that pauses on approval surfaces the approval card;
      approve and deny both resolve the real run.
- [ ] **16.8** A run that fails surfaces the failure with its reason.
- [ ] **16.9** `[gap]` The gateway VMs have no AI-provider credential and
      wedged VMs do not resume. Confirm the UI reports both honestly rather
      than showing a run that never progresses.
- [ ] **16.10** Close the browser mid-run and reopen: the run state is restored
      and correctly described. `[auto B-1]`

## §17 Billing

- [ ] **17.1** `/billing.balance` shows the $500 design-partner balance for a
      signed-in user. `[auto D-1]`
- [ ] **17.2** The balance chip in the corner chrome is present, accurate, and
      marked empty at $0. The `zeroBalance` persona grades product behavior as
      `verified-via-mock`; a live billing-account check remains optional and
      separate.
- [ ] **17.3** No card form appears anywhere in the product. `[auto A-6]`
- [ ] **17.4** No top-up or checkout flow is exposed to MVP users.
      `[auto D-3]` Note that `/billing.upgrade` and `/billing.portal` are
      registered flows — confirm they are unreachable for MVP accounts, or
      that reaching them is intended.
- [ ] **17.5** At $0, interactive chat keeps working; only non-complimentary
      work pauses. `[auto D-4]` Verify the pause message names what paused and
      what to do. The `zeroBalance` persona grades this product behavior as
      `verified-via-mock`; a live billing-account check remains optional and
      separate.
- [ ] **17.6** `/api/billing/usage` numbers match what the user actually spent.
- [ ] **17.7** `[auto E-1..E-3]` Admin grants: no token → 401, untimestamped →
      400, valid grant credits exactly once with an audit record.

## §18 Provider keys (BYOK)

- [ ] **18.1** `/keys.list` shows keys masked. No full key is ever rendered,
      logged, or copied to the clipboard.
- [ ] **18.2** Adding a key (through whatever surface adds it) validates it
      before saving.
- [ ] **18.3** `/keys.remove <provider>` removes it and the change survives a
      reload.
- [ ] **18.4** An invalid or revoked key produces an honest error on the next
      turn, naming the provider.
- [ ] **18.5** `/keys.remove` for a provider with no key.

## §19 Notifications and toasts

- [ ] **19.1** `/notifications.list` renders the list, with an empty state.
- [ ] **19.2** `/notifications.read` marks every notification read, and the
      unread indicator clears.
- [ ] **19.3** Toasts appear for the events that warrant them, stack without
      overlapping, and auto-dismiss.
- [ ] **19.4** `toast.dismiss` dismisses one toast; several open at once behave.
- [ ] **19.5** Toasts are announced to assistive technology and do not steal
      focus.

## §20 Themes and appearance

- [ ] **20.1** `/theme` opens the picker; all 9 swatches (Night Owl, Paper,
      Fucory, One, GitHub, Catppuccin, Solarized, Gruvbox, Rosé Pine) render in
      their own colors and the selected one is marked.
- [ ] **20.2** Selecting each theme repaints the whole app. Check the chat, a
      card, the world editor, the connectors pane, and the devtools panel in at
      least three themes.
- [ ] **20.3** `/dark-mode` toggles, and every theme is legible in both modes.
      Look specifically at code blocks, diffs, status pills, and disabled
      controls.
- [ ] **20.4** The theme choice survives a reload and applies before first
      paint (no flash of the wrong theme).
- [ ] **20.5** The OS `prefers-color-scheme` default is respected before the
      user picks anything.
- [ ] **20.6** Contrast: run one accessibility audit per mode and confirm text
      and interactive controls meet contrast on the default theme.

## §21 Keyboard and accessibility

- [ ] **21.1** The whole §A journey is completable keyboard-only.
      `[auto C-3]` Do it by hand as well and note every place you had to guess.
- [ ] **21.2** Tab order is sane on every surface; no focus trap; no
      unreachable control.
- [ ] **21.3** Focus is always visible.
- [ ] **21.4** Escape has one meaning per context and the precedence is right:
      stop turn while typing → minimize maximized card → dismiss
      recommendation → close menu.
- [ ] **21.5** Cmd/Ctrl+Shift+D toggles the devtools panel for admins and is a
      no-op for everyone else.
- [ ] **21.6** Screen-reader pass over the chat, one card, and the composer:
      labels, roles, and live-region announcements for streaming output.
- [ ] **21.7** Zoom to 200% and confirm nothing is clipped or unreachable.
- [ ] **21.8** Narrow the window to a phone width. Decide and record whether
      mobile is in scope for the alpha.

## §22 Honesty and refusals

- [ ] **22.1** `[auto F-1]` Ask it to send an email.
- [ ] **22.2** `[auto F-2]` Ask it to read a local file.
- [ ] **22.3** `[auto F-3]` Ask it to use an unconnected tool.
- [ ] **22.4** `[auto F-4]` Ask it to push.
- [ ] **22.5** `[auto F-5]` Ask it to open a PR it cannot open.
- [ ] **22.6** Each refusal names the next step, and the next step actually
      works.
- [ ] **22.7** Ask it a question about its own state ("am I signed in?", "what
      repos do you watch?", "what is my balance?"). The answer matches the UI.
- [ ] **22.8** Ask it to do something a user-only flow does. It says it cannot,
      and does not silently do nothing.

## §23 Durability, interruption, resume

- [ ] **23.1** Reload mid-turn. Conversation and in-flight work are restored
      and correctly described. `[auto B-1]`
- [ ] **23.2** Close the browser entirely mid-turn and reopen.
- [ ] **23.3** Kill the network mid-turn, restore it, and confirm the app
      reconciles rather than lying.
- [ ] **23.4** Two tabs on the same session: state stays consistent; no
      duplicated cards or divergent transcripts.
- [ ] **23.5** `/reset` starts a fresh conversation and states that nothing is
      kept.
- [ ] **23.6** `/reload` reloads without losing the session.
- [ ] **23.7** Local persistence (`@tanstack/db` + wa-sqlite): clear site data
      and confirm a clean first run rather than a corrupt state.
- [ ] **23.8** Downgrade path: open the app with an older persisted database
      shape, if one exists, and confirm it does not wedge.

## §24 Errors, limits, and degradation

- [ ] **24.1** `[gap]` Client errors are only `console.error`. Decide whether
      the alpha ships without client error reporting; if it does, confirm no
      user-visible surface swallows an error silently.
- [ ] **24.2** Every upstream the UI calls, forced to fail: agent turn,
      identity, billing, reco, notifications, github import, workflow rpc.
      Each produces a named, actionable message.
- [ ] **24.3** A 429 from the model provider surfaces as a rate-limit message,
      not a generic failure.
- [ ] **24.4** A 500 from the product Worker.
- [ ] **24.5** Offline: load the app with no network, and go offline mid-use.
- [ ] **24.6** A slow upstream (5s+): loading states appear rather than a dead
      frame.
- [ ] **24.7** `/debug.seams` reports seam and upstream health accurately —
      compare its verdict against a seam you have deliberately broken.

## §25 Admin surface

- [ ] **25.1** `/admin.devtools` toggles the panel for an admin.
- [ ] **25.2** `/admin.requests` lists the request-access queue;
      `admin.queue.approve <login>` approves an entry and the approved user can
      then sign in.
- [ ] **25.3** `/admin.allowlist.add <login>` and `.remove <login>`, including
      a login that does not exist.
- [ ] **25.4** `/admin.grant <amountUsd> <login>` asks for confirmation first;
      `admin.grant.confirm` credits exactly once; `admin.grant.cancel` credits
      nothing.
- [ ] **25.5** Grant the same amount twice and confirm no double credit.
- [ ] **25.6** `/admin.feedback` shows the recommendation feedback log.
- [ ] **25.7** `/admin.health` reports service health, charges, and queue depth,
      and the numbers are real.
- [ ] **25.8** Every admin flow from a non-admin account: unregistered, not
      merely refused.

## §26 Devtools and debug flows

These ship in the build. Confirm each works or is deliberately gated.

- [ ] **26.1** `/debug.backend` REPORTS the one backend — the in-browser Agent
      Chain over `/api/model/stream` — and cannot switch to another: an
      argument is answered with that sentence, never obeyed. Send a turn and
      confirm it spends its model on `/api/model/stream` and never on
      `/api/agent/turn`.
- [ ] **26.2** `/debug.snapshot` reads the app-state snapshot.
- [ ] **26.3** `/debug.events` reads the transition journal tail.
- [ ] **26.4** `/debug.chain` reads the chain journal x-ray.
- [ ] **26.5** `/debug.net` reads the network tap, and no secret appears in it.
- [ ] **26.6** `/debug.grants.reset` revokes the chain's session grants and the
      next tool call re-asks.
- [ ] **26.7** Decide whether `debug.*` and `reset` should be reachable by
      non-admin alpha users at all. They are registered flows today.

## §27 Desktop app (Electrobun)

- [ ] **27.1** `bun run build:canary` produces a launchable app.
- [ ] **27.2** First launch: window size, title, and icon are right.
- [ ] **27.3** Native sign-in handoff completes and persists across a restart.
- [ ] **27.4** `nativeOpenExternal` opens links in the system browser, not in
      the app window. Check every external link: GitHub, Stripe, docs.
- [ ] **27.5** Local repository inspection (`LocalRepository`) finds repos and
      reports honestly when it cannot.
- [ ] **27.6** The local agent path (`CloudAgent`, tool loop) runs a turn end to
      end.
- [ ] **27.7** The updater path: confirm it is configured, and decide whether it
      is exercised before the alpha.
- [ ] **27.8** Quit and relaunch mid-turn.
- [ ] **27.9** Window resize, minimize, fullscreen, and multi-display.

## §28 Cross-cutting polish sweep

Do this last, in one sitting, with fresh eyes.

- [ ] **28.1** Read every user-facing string for the register: plain, direct,
      no filler, no exclamation marks, no "Oops".
- [ ] **28.2** Every empty state names the next step.
- [ ] **28.3** Every loading state is distinguishable from a dead frame.
- [ ] **28.4** Every destructive action confirms, and the confirm names the
      object ("Delete <title>?").
- [ ] **28.5** No placeholder, lorem, TODO, or debug string is visible anywhere.
- [ ] **28.6** Spacing and alignment are consistent across cards, panes, and
      the composer.
- [ ] **28.7** No layout shift when a card arrives, a toast opens, or a stream
      starts.
- [ ] **28.8** Icons match their meaning and have accessible labels.
- [ ] **28.9** Timestamps are in the user's locale and stay correct across a day
      boundary.
- [ ] **28.10** The browser tab title and favicon are right.
- [ ] **28.11** No console errors or warnings during a normal session.
- [ ] **28.12** No network request 4xx/5xx during a normal session.
- [ ] **28.13** Cold-load time on a normal connection is acceptable; measure it.
- [ ] **28.14** Bundle size is what you expect; no accidental large dependency.

## §29 Ship gates (not features, but they block the release)

- [ ] **29.1** `pnpm run check`, all four apps' tests, and `typecheck` are green
      at the commit you are shipping.
- [ ] **29.2** `[gap]` `apps-deploy.yml` runs no tests before deploying. Fix or
      accept explicitly.
- [ ] **29.3** `[gap]` The nine backing Cloudflare Workers (identity, billing,
      chat, recommendations, connectors-catalog, cron, status, sync, webhooks)
      live in `~/flows/ui/workers/` on branch `wave5-billing-bridge` with
      uncommitted edits, and are not in the release repo.
      `apps-deploy.yml` deploys only `smithers-mvp-web`. Land them or write
      down how they are deployed.
- [ ] **29.4** `[gap]` U9: the vite root is a literal, the root `dev` script is
      missing, and four Playwright `live-*.ts` scripts under `scripts/` are
      unrunnable and untypechecked.
- [ ] **29.5** `[gap]` Add a reset door for recommendation dismissals
      (`DELETE /api/reco/admin/dismissals`) so the checklist can be re-run on
      one account.
- [ ] **29.6** The deployed origin serves the commit you tested. Re-run the
      automated checklist against it after the deploy, not before.


---

## Appendix A — every registered flow

88 flows. Each one: invoke it, read the card or message it produces, and force
one failure (bad argument, missing permission, or unreachable upstream). A flow
passes when the success path is right **and** the failure path is honest.

- [ ] **A.1** `/connect` — Connect work to Smithers
- [ ] **A.2** `/world` — See what Smithers understands (World)
- [ ] **A.3** `/theme` — Set the color theme _(user-only)_
- [ ] **A.4** `/surfaces` — Open the surfaces menu _(user-only)_
- [ ] **A.5** `/dark-mode` — Toggle light and dark mode _(user-only)_
- [ ] **A.6** `/chat` — Back to the conversation
- [ ] **A.7** `/retry` — Retry the last turn
- [ ] **A.8** `/chat.stop` — Stop the current response _(user-only)_
- [ ] **A.9** `/stop` — Stop the current response _(hidden, user-only, alias→chat.stop)_
- [ ] **A.10** `/send` `<text>` — Submit the composer _(user-only)_
- [ ] **A.11** `/repos.watch` `[repo]` — Choose which repositories Smithers watches _(needs signed-in)_
- [ ] **A.12** `/repos.watch.toggle` `<fullName>` — Toggle a repository in the chooser _(hidden, user-only)_
- [ ] **A.13** `/repos.watch.all` — Select every repository in the chooser _(hidden, user-only)_
- [ ] **A.14** `/repos.watch.none` — Select no repositories in the chooser _(hidden, user-only)_
- [ ] **A.15** `/repos.watch.confirm` — Confirm the watched-repositories selection _(hidden, user-only)_
- [ ] **A.16** `/clear` — Clear the chat, keeping anything worth remembering _(user-only)_
- [ ] **A.17** `/browser` `<url>` — Open a web page as a card Smithers can read
- [ ] **A.18** `/flow.create` `<description> [owner/repo]` — Create a Smithers workflow from a description _(needs signed-in + repos-selected)_
- [ ] **A.19** `/flow.repo.choose` `<owner/repo>` — Choose which watched repository a workflow belongs to _(hidden, user-only)_
- [ ] **A.20** `/flow.run.stop` `<cardId>` — Stop watching a run _(hidden, user-only)_
- [ ] **A.21** `/flow.run.retry` `<cardId>` — Check a run again _(hidden, user-only)_
- [ ] **A.22** `/flow.list` — List the workflows on your workspace _(needs signed-in)_
- [ ] **A.23** `/flow.run` `<name> [owner/repo]` — Run a workflow on your workspace _(needs signed-in + repos-selected)_
- [ ] **A.24** `/card.maximize` `<cardId>` — Maximize a card _(hidden, user-only)_
- [ ] **A.25** `/card.minimize` — Minimize the maximized card _(hidden, user-only)_
- [ ] **A.26** `/copy-message` `<text>` — Copy a message to the clipboard _(hidden, user-only)_
- [ ] **A.27** `/approval.approve` `<cardId>` — Approve a pending approval card _(hidden)_
- [ ] **A.28** `/approval.deny` `<cardId>` — Deny a pending approval card _(hidden)_
- [ ] **A.29** `/connector.add` `<read|read-write>` — Connect a local repository _(hidden)_
- [ ] **A.30** `/connector.downgrade` `<connectorId>` — Make a connector read-only _(hidden)_
- [ ] **A.31** `/connector.remove` `<connectorId>` — Disconnect a repository _(hidden)_
- [ ] **A.32** `/world.new-note` — Create a world note _(hidden)_
- [ ] **A.33** `/world.select` `<documentId>` — Open a world note _(hidden)_
- [ ] **A.34** `/world.delete` `<documentId>` — Delete a world note _(hidden)_
- [ ] **A.35** `/auth.sign-in` — Sign in with GitHub _(user-only)_
- [ ] **A.36** `/auth.prompt` — Offer the GitHub sign-in step in the chat
- [ ] **A.37** `/auth.sign-out` — Sign out of Smithers _(user-only)_
- [ ] **A.38** `/auth.request-access` — Request access to Smithers _(user-only, needs signed-in)_
- [ ] **A.39** `/toast.dismiss` `<toastId>` — Dismiss a toast notification _(hidden, user-only)_
- [ ] **A.40** `/billing.balance` — Show your balance _(needs signed-in)_
- [ ] **A.41** `/reco.accept` `[cardId]` — Accept the current recommendation
- [ ] **A.42** `/reco.edit` `[cardId]` — Edit the current recommendation before running it
- [ ] **A.43** `/reco.dismiss` `[cardId]` — Dismiss the current recommendation
- [ ] **A.44** `/reco.refresh` — Read the recommendation again _(needs signed-in)_
- [ ] **A.45** `/repos.import` `[owner/repo]` — Import a GitHub repository into Smithers Cloud _(needs signed-in)_
- [ ] **A.46** `/issues.list` `[open|closed|all] [owner/repo]` — List a repository's issues _(needs signed-in)_
- [ ] **A.47** `/issues.view` `<number> [owner/repo]` — Open an issue with its comments _(needs signed-in)_
- [ ] **A.48** `/issues.create` `<title> [owner/repo]` — Create an issue _(needs signed-in)_
- [ ] **A.49** `/issues.close` `<number> [owner/repo]` — Close an issue _(needs signed-in)_
- [ ] **A.50** `/issues.reopen` `<number> [owner/repo]` — Reopen a closed issue _(needs signed-in)_
- [ ] **A.51** `/issues.comment` `<number> <text> [owner/repo]` — Comment on an issue _(needs signed-in)_
- [ ] **A.52** `/prs.list` `[owner/repo]` — List a repository's pull requests _(needs signed-in)_
- [ ] **A.53** `/prs.view` `<number> [owner/repo]` — Open a pull request with reviews and checks _(needs signed-in)_
- [ ] **A.54** `/prs.create` `<title> [from:<bookmark>] [owner/repo]` — Open a pull request _(needs signed-in)_
- [ ] **A.55** `/prs.land` `<number> [owner/repo]` — Land a pull request (queues the merge) _(user-only, needs signed-in)_
- [ ] **A.56** `/prs.review` `<number> approve|request-changes|comment [text] [owner/repo]` — Review a pull request _(needs signed-in)_
- [ ] **A.57** `/billing.upgrade` `[plan]` — Upgrade your plan (opens Stripe checkout) _(user-only, needs signed-in)_
- [ ] **A.58** `/billing.portal` — Manage billing (opens the Stripe portal) _(user-only, needs signed-in)_
- [ ] **A.59** `/keys.list` — List your provider API keys (masked) _(needs signed-in)_
- [ ] **A.60** `/keys.remove` `<provider>` — Remove a provider API key _(user-only, needs signed-in)_
- [ ] **A.61** `/notifications.list` — Show your notifications _(needs signed-in)_
- [ ] **A.62** `/notifications.read` — Mark every notification read _(needs signed-in)_
- [ ] **A.63** `/env.view` `[owner/repo]` — Show a repository's agent environment _(needs signed-in)_
- [ ] **A.64** `/env.set` `<NAME=value> [owner/repo]` — Set an agent-environment variable _(needs signed-in)_
- [ ] **A.65** `/branches.list` `[owner/repo]` — List a repository's branches (bookmarks) _(needs signed-in)_
- [ ] **A.66** `/files.list` `[path] [owner/repo]` — List a repository directory _(needs signed-in)_
- [ ] **A.67** `/files.read` `<path> [owner/repo]` — Read a file from a repository _(needs signed-in)_
- [ ] **A.68** `/repos.app` `[owner/repo]` — Check the Smithers GitHub App on a repository _(needs signed-in)_
- [ ] **A.69** `/reload` — Reload the app _(user-only)_
- [ ] **A.70** `/flows` — List everything Smithers can do
- [ ] **A.71** `/reset` — Start a fresh conversation (dev tooling — nothing is kept) _(user-only)_
- [ ] **A.72** `/admin.devtools` — Toggle the dev-tools panel _(user-only)_
- [ ] **A.73** `/debug.backend` — Report the agent backend _(user-only)_
- [ ] **A.74** `/debug.snapshot` — Read the app state snapshot
- [ ] **A.75** `/debug.events` — Read the transition journal tail
- [ ] **A.76** `/debug.chain` — Read the chain journal x-ray
- [ ] **A.77** `/debug.net` — Read the network tap
- [ ] **A.78** `/debug.grants.reset` — Revoke the chain's session grants _(user-only)_
- [ ] **A.79** `/debug.seams` — Probe seam and upstream health
- [ ] **A.80** `/admin.allowlist.add` `<login>` — Add a GitHub login to the allowlist
- [ ] **A.81** `/admin.allowlist.remove` `<login>` — Remove a GitHub login from the allowlist
- [ ] **A.82** `/admin.grant` `<amountUsd> <login>` — Grant balance to a login (asks for confirmation first)
- [ ] **A.83** `/admin.grant.confirm` `<cardId>` — Confirm a pending balance grant _(hidden)_
- [ ] **A.84** `/admin.grant.cancel` `<cardId>` — Cancel a pending balance grant _(hidden)_
- [ ] **A.85** `/admin.requests` — Show the request-access queue
- [ ] **A.86** `/admin.queue.approve` `<login>` — Approve a request-access queue entry _(hidden)_
- [ ] **A.87** `/admin.feedback` — Show the recommendation feedback log
- [ ] **A.88** `/admin.health` — What failed overnight? Service health, charges, queue depth

---

## Appendix B — card kinds by the flow that produces them

| Card kind | Reached by |
| --- | --- |
| `plan` | agent turn |
| `approval` | a run pausing on approval |
| `status` | agent turn |
| `balance` | `/billing.balance`, balance chip |
| `reco` | recommendation seam, `/reco.refresh` |
| `grant-confirm` | `/admin.grant` |
| `request-queue` | `/admin.requests` |
| `reco-log` | `/admin.feedback` |
| `admin-health` | `/admin.health` |
| `repo-chooser` | `/repos.watch` |
| `connect` | `/connect` |
| `world` | `/world` |
| `browser` | `/browser <url>` |
| `flow-run` | `/flow.run` |
| `workflow-list` | `/flow.list` |
| `workflow-repo` | `/flow.repo.choose` |
| `issue-list` | `/issues.list` |
| `issue` | `/issues.view` |
| `pr-list` | `/prs.list` |
| `pr` | `/prs.view` |
| `keys` | `/keys.list` |
| `notifications` | `/notifications.list` |
| `env` | `/env.view` |
| `repo-import` | `/repos.import` |
| `branches` | `/branches.list` |
| `file-list` | `/files.list` |
| `file` | `/files.read` |
| `theme-picker` | `/theme` |

---

## Appendix C — known gaps

Status as of 2026-08-19. Six of the original nine closed the same day; do not
report a closed one as a finding.

**Closed**

1. ~~The deployed canary predates the `command`→`flow` rename.~~ Redeployed;
   live bundle is `assets/index-BHHXuMoZ.js` and carries `data-flow`.
2. ~~Recommendation rows A-8/A-9 self-poison with no reset door.~~ Closed by
   `1dd856f1` "stop A-8 and A-9 poisoning the account they grade". The door is
   `DELETE /api/admin/reco-dismissals?login=<login>` (admin-gated) and the
   surfaces lane used it successfully.
3. ~~U9: untyped `scripts/`, vite root literal, no root `dev`.~~ Closed by
   `12018780`.
4. ~~U10: no exact-name precedence in slash dispatch.~~ Closed by `12018780`
   ("name the flow you typed").
5. ~~No rate limit on the turn seam.~~ Closed by `a80eeebb`.
6. ~~Client errors only reach `console.error`.~~ Closed by `a80eeebb`
   (`apps/server/src/clientErrorLog.ts`).
7. ~~`apps-deploy.yml` runs no tests before deploying.~~ It now typechecks and
   tests all four apps and dry-runs the launch checklist first.

**Still open**

8. **The `sync` worker is undeployed.** Its test suite cannot import:
   `workers/sync/src/index.test.ts` reaches into the flows monorepo for
   `Journal.ts`, which calls `Schema.TaggedError` — that symbol exists in
   effect `4.0.0-rc.108` (flows) but is `Schema.TaggedErrorClass` in
   `4.0.0-beta.102` (the ui repo), so it dies with `TypeError: TaggedError is
   not a function` before a single test runs. Cross-repo dependency drift.
   `sync.smithers.sh` is live on its 2026-08-04 build. The other eight workers
   were redeployed 2026-08-19 (`62a828e`); `status` had never been deployed at
   all before that.
9. **Agents are dark in production.** `feature_flags.agents` is off because
   `sandbox.agent_snapshot_id` is empty, and no agent VM snapshot had ever been
   baked. `aaa7cf8da` adds the bake to the release; until it lands and the id is
   promoted, every agent-dependent row is untestable rather than failing.
10. **All CronJobs are absent cluster-wide**, including
    `smithers-backend-canary-cheap`, so prod canary monitoring is silent.
    Suspected interaction between the `agentsEnabled` guard added to
    `canary-cronjob.yaml` and the agents flag being shipped off.

**Not a gap, a possible spec bug in this document:** row 3.4 requires
"$500 of usage on us" to appear exactly once. On canary it appears **zero**
times, and the access lane judged the product probably right. Confirm the
intended copy before treating 3.4 as a defect.
