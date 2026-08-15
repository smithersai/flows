# Wave 12 — Result claims are deterministic; the last first-run polish

You are working in `/Users/williamcory/mvp` on branch `oneshot-mskp7qe7-work`. Read `AGENTS.md` top laws + `WAVE11-RECEIPT.md` (§5 gaps — this wave closes the product-side ones). Deploy + live-verify authorized as before.

## 1. The model may not narrate run state (will's §2a lesson, generalized to claims)
Live failure despite pinned tool-result warnings: beside a card truthfully saying *Running*, the model wrote "the workflow 'summarize-open-issues' has been created and is now running" — invented name, false completion. Prompt discipline does not hold; make the claim surface deterministic:
- The tool result for run-launching commands returns a MINIMAL machine acknowledgment; the client renders the deterministic act line + the card, and **the model's prose about a launched run is post-processed**: statements the model makes about run state/creation in the same turn as a run-launch tool call are replaced by/reduced to the deterministic line (simplest honest mechanism: after a run-launch tool call, the client renders the model's remaining text for that turn ONLY if it contains no run-state claims — detect via the run/workflow vocabulary — else substitutes the deterministic "I started a create-workflow run — the card below shows its real progress."). Blunt is fine; a suppressed hallucination is invisible, a shipped one is a truth-bar failure. Pin with tests: the wave-11 exact transcript replayed → the rendered turn contains no "has been created".
- Keep strengthening the system prompt too (belt and braces), but the test asserts the RENDERED output, not the model's intent.
## 2. `workflow.create` asks which watched repo when there is more than one
Accept `owner/repo` as an argument (agent + slash); with >1 watched repos and no argument, the chooser-among-watched renders (embedded, keyboard-complete, one confirm) — this is a genuine user choice (≤3-questions law permits it). One watched repo → no question.
## 3. A run the workspace never finishes gets a bounded client stance
After a generous bound with no event progress (e.g. 10 min stale), the card states plainly that the run has gone quiet and offers stop/retry affordances (registered commands); the pump stops hammering. Honest, not silent.
## 4. Residuals
- Signed-out chat still renders the old "Hey — tell me what you're working on" welcome + suggestion invitation AFTER the auth message (live check earlier today) — signed-out shows ONLY the auth conversation state (§2a″); fix + pin.
- The watched-set/Cloud-repo mismatch state: a watched repo with no Smithers Cloud counterpart gets a purpose-built honest line ("this repo isn't on Smithers Cloud yet") rather than the raw provision failure.
## 5. Proofs + receipt
Tests green, typecheck, worker e2e extended (the replayed-transcript truth test, repo-argument journeys, quiet-run stance), deploy, live signed-out + signed-in browser checks re-run, screenshots archived. `WAVE12-RECEIPT.md`.
