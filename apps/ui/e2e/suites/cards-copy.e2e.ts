/*
 * Card copy laws and blocked-on-approval agreement — checklist rows B-4, B-5,
 * B-6, B-7 and F-6 (E4.6, E4.7, E4.8, E4.9, E4.5).
 *
 * All five rows were live-only because they need cards on screen and the live
 * canary only has whatever cards a real session happened to produce. Here the
 * chat double emits the card frames, so every law is measured against cards
 * this suite named: a settled run card, a plan, a status, a world card, a
 * recommendation, a corrected plan, and a run parked on an approval gate.
 *
 * Every assertion reads the rendered DOM, never the store. A card that stops
 * rendering its result first, a card that grows a score badge or a rating
 * prompt, a correction that flips a card into error chrome, and a run card
 * that wears a Running pill while its gate blocks it all turn one of these
 * checks red.
 */
import { SuiteFailure } from "../Assert.ts";
import { defineSuite } from "../Suite.ts";
import {
	CARD_LEADS,
	ERROR_STATE_COPY,
	RATING_COPY,
	SCORE_COPY,
	hasSmithersMessage,
	replyRegion,
	sendPrompt,
	waitForText,
} from "../../src/launch-checklist/Probes.ts";
import type { ProbePage } from "../../src/launch-checklist/Types.ts";

/*
 * The exact words the product renders for a run's state. Quoted from
 * ChatCards.tsx WORKFLOW_RUN_PHASE_WORDS and @smthrs/ui formatStatus /
 * approvalStateLabel, so a copy change upstream shows up here as a failure
 * rather than as a check that quietly stops matching anything.
 */
const PHASE_WORD_RUNNING = "Running on your workspace.";
const PHASE_WORD_WAITING = "Waiting for your approval below.";
const PHASE_WORD_COMPLETED = "Finished.";
const PILL_LABEL_WAITING = "Waiting for approval";
const PILL_LABEL_RUNNING = "Running";
const LIVE_LABEL_WAITING = "Waiting for approval";
const LIVE_LABEL_APPROVED = "Approved";

/** The pill `data-status` values that claim the run is executing right now. */
const RUNNING_STATUSES: ReadonlyArray<string> = ["running", "active", "in-progress"];

const RUN_RESULT = "Created summarize-open-issues on will/flows.";

/*
 * Row B-5's missing spelling. The shared SCORE_COPY bar recognises
 * "confidence: 0.8" and "80% confident" but not the bare "80%" badge the world
 * card actually renders, so this restates the row locally over any percentage.
 * See the B-5 block below for why a percentage here can only be a score.
 */
const SCORE_PERCENT_COPY = /\b\d{1,3}\s*%/;

/** How long a scripted turn has to reach the page. Generous: wrangler is cold. */
const TURN_BUDGET_MS = 30_000;

const now = (): number => Date.now();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface CardFact {
	readonly kind: string;
	readonly label: string;
	readonly status: string;
	readonly pill: string | null;
	readonly pillText: string;
	readonly lead: string;
	readonly body: string;
	readonly note: string;
	readonly steps: ReadonlyArray<string>;
	readonly errorChrome: number;
}

/*
 * Expression source: one record per rendered card, read from the card's own
 * body rather than from the whole section. The header carries the title, the
 * pill and the `kind · HH:MM` meta, so a lead read off the section would be
 * chrome for every card and row B-4 could never fail.
 */
const CARD_FACTS = `(() => {
	const lines = (element) => (element === null ? [] : (element.innerText ?? "")
		.split("\\n").map((line) => line.trim()).filter((line) => line.length > 0));
	return Array.from(document.querySelectorAll(".smithers-card[data-kind]")).map((card) => {
		const body = card.querySelector(".smithers-card-body");
		const pill = card.querySelector(".smithers-card-header [data-status]");
		const note = card.querySelector(".smithers-card-body .smithers-card-note");
		const bodyLines = lines(body);
		return {
			kind: card.getAttribute("data-kind") ?? "",
			label: card.getAttribute("aria-label") ?? "",
			status: card.getAttribute("data-status") ?? "",
			pill: pill === null ? null : pill.getAttribute("data-status"),
			pillText: pill === null ? "" : (pill.textContent ?? "").trim(),
			lead: bodyLines[0] ?? "",
			body: bodyLines.join(" | "),
			note: note === null ? "" : (note.textContent ?? "").trim(),
			steps: Array.from(card.querySelectorAll(".flow-run-steps li")).map((step) => (step.textContent ?? "").trim()),
			errorChrome: card.querySelectorAll("[data-state='error'], [data-state='failed-submission'], [role='alert'], .error").length,
		};
	});
})()`;

interface ConfirmationFact {
	readonly label: string;
	readonly state: string | null;
	readonly status: string | null;
	readonly live: string;
	readonly actions: number;
	readonly requests: number;
	readonly accepted: number;
}

/** Expression source: the approval anatomy each approval card renders. */
const CONFIRMATION_FACTS = `(() => {
	return Array.from(document.querySelectorAll('.smithers-card[data-kind="approval"]')).map((card) => {
		const confirm = card.querySelector('[data-slot="confirmation"]');
		const live = confirm === null ? null : confirm.querySelector('[role="status"]');
		return {
			label: card.getAttribute("aria-label") ?? "",
			state: confirm === null ? null : confirm.getAttribute("data-state"),
			status: confirm === null ? null : confirm.getAttribute("data-status"),
			live: live === null ? "" : (live.textContent ?? "").trim(),
			actions: card.querySelectorAll('[data-slot="confirmation-action"]').length,
			requests: card.querySelectorAll('[data-slot="confirmation-request"]').length,
			accepted: card.querySelectorAll('[data-slot="confirmation-accepted"]').length,
		};
	});
})()`;

/*
 * Expression source: the error chrome the whole page renders. Wider than row
 * B-6's own selector on purpose — the app's failure states are
 * `data-state="failed-submission"` on a Confirmation and `data-status="error"`
 * on a card section, and neither is `data-state="error"`.
 */
const PAGE_ERROR_CHROME = `document.querySelectorAll("[data-state='error'], [data-state='failed-submission'], .smithers-card[data-status='error'], [role='alert'], .error").length`;

/** Expression source: the composer and transcript lifecycle, for the F-6 scoping rule. */
const SESSION_FACTS = `(() => ({
	composer: document.querySelector('[data-slot="chat-composer"]')?.getAttribute("data-status") ?? null,
	busy: document.querySelector('[role="log"]')?.getAttribute("aria-busy") ?? null,
}))()`;

const cardTitled = (facts: ReadonlyArray<CardFact>, label: string): CardFact | undefined =>
	facts.find((fact) => fact.label === label);

/** A lookup that must have matched. Fails the suite by name when it did not. */
const required = <T>(value: T | undefined, reason: string): T => {
	if (value === undefined) throw new SuiteFailure(reason);
	return value;
};

/*
 * The F-6 detector. A run parked on a human decision has two cards and one
 * confirmation; every one of them is a pure function of the same store state,
 * so any disagreement between them is a rendering bug, not a race.
 *
 * Scoped to the run's own surfaces. An unrelated card elsewhere in the
 * transcript may legitimately read Running, and F-6 is about one run's state
 * being told two ways — not about the word appearing on the page.
 */
const disagreements = (run: CardFact, approval: CardFact, confirmation: ConfirmationFact): ReadonlyArray<string> => {
	const found: Array<string> = [];
	const blocked = confirmation.state === "requested";
	if (blocked) {
		if (run.pill !== null && RUNNING_STATUSES.includes(run.pill)) {
			found.push(`the run pill reads ${run.pill} while the gate is still open`);
		}
		if (run.pillText.includes(PILL_LABEL_RUNNING)) {
			found.push(`the run pill is labelled ${JSON.stringify(run.pillText)} while the gate is still open`);
		}
		if (run.note === PHASE_WORD_RUNNING) {
			found.push("the run card body claims the run is on your workspace while the gate is still open");
		}
		if (run.pill !== "waiting-approval") {
			found.push(`the run pill is ${run.pill}, not waiting-approval, while the gate is still open`);
		}
		if (approval.pill !== "waiting-approval") {
			found.push(`the approval pill is ${approval.pill}, not waiting-approval, while the gate is still open`);
		}
		if (confirmation.status !== "waiting-approval") {
			found.push(`the confirmation status is ${confirmation.status}, not waiting-approval`);
		}
		if (confirmation.live !== LIVE_LABEL_WAITING) {
			found.push(`the approval live region announces ${JSON.stringify(confirmation.live)}`);
		}
		return found;
	}
	// The gate is settled: nothing may still be telling the human to decide.
	for (const [what, value] of [
		["the run pill", run.pillText],
		["the run card body", run.note],
		["the approval pill", approval.pillText],
		["the approval live region", confirmation.live],
	] as ReadonlyArray<readonly [string, string]>) {
		if (value.includes(PILL_LABEL_WAITING) || value === PHASE_WORD_WAITING) {
			found.push(`${what} still reads ${JSON.stringify(value)} after the gate settled`);
		}
		if (value.includes(PILL_LABEL_RUNNING) || value === PHASE_WORD_RUNNING) {
			found.push(`${what} still reads ${JSON.stringify(value)} after the gate settled`);
		}
	}
	return found;
};

const card = (payload: Record<string, unknown>): Record<string, unknown> => ({ type: "card", card: payload });
const update = (id: string, patch: Record<string, unknown>): Record<string, unknown> => ({
	type: "card.update",
	id,
	patch,
});
const say = (text: string): Record<string, unknown> => ({ type: "delta", kind: "text", text });
const DONE: Record<string, unknown> = { type: "done", reason: "stop" };

const RUN_DONE_TITLE = "create-workflow on will/flows";
const RUN_BLOCKED_TITLE = "deploy-canary on will/flows";
const APPROVAL_TITLE = "Approve the production deploy";
const PLAN_FIX_TITLE = "The corrected plan";

/** Send a prompt and wait for the sentence the scripted turn ends with. */
const turn = async (page: ProbePage, prompt: string, expected: string): Promise<string> => {
	/*
	 * A chain turn runs one authored link per upstream round-trip, so the
	 * PREVIOUS turn can still be settling its later links while this suite
	 * reads the page. A send into a live turn is refused by design — wait for
	 * the composer to say ready before speaking.
	 */
	const deadline = now() + TURN_BUDGET_MS;
	for (;;) {
		const status = await page.evaluate<string | null>(
			`document.querySelector('[data-slot="chat-composer"]')?.getAttribute("data-status") ?? null`,
		);
		if (status === "ready") break;
		if (now() >= deadline) throw new SuiteFailure(`the composer never returned to ready before ${JSON.stringify(prompt)}`);
		await sleep(150);
	}
	const before = await sendPrompt(page, prompt);
	const seen = await waitForText(page, (text) => text.includes(expected), TURN_BUDGET_MS, now, sleep);
	if (!seen.ok) {
		throw new SuiteFailure(
			`the scripted turn never reached the page: expected ${JSON.stringify(expected)}; the transcript ended ` +
				JSON.stringify(replyRegion(before, seen.text).trim().slice(-400)),
		);
	}
	return before;
};

export default defineSuite({
	id: "E4.5-E4.9",
	title: "card copy laws and blocked-on-approval agreement (B-4, B-5, B-6, B-7, F-6)",
	browser: true,
	order: 40,
	run: async ({ stack, report, browser }) => {
		/*
		 * Product defects this suite proves, raised at the very bottom of run().
		 * The measurement and the judgement both happen where the row is checked
		 * and each one prints a `defect:` line there; only the THROW is deferred,
		 * so one open product defect cannot stop the four rows that come after it
		 * from being measured. The suite still fails — nothing here is optional.
		 */
		const openDefects: Array<string> = [];
		const cookie = await stack.signedInCookie();
		const session = await browser.open(cookie);
		const page = session.page;
		const mounted = await waitForText(page, hasSmithersMessage, TURN_BUDGET_MS, now, sleep);
		report.check(mounted.ok, "the app never rendered a transcript, so no card law could be read.");

		/* ---------------------------------------------------------------- *
		 * B-4 — a settled card leads with its result, never with process
		 * chrome. The cards are the ones a finished run really produces.
		 * ---------------------------------------------------------------- */
		stack.chat.script({
			frames: [
				say("Here is what finished."),
				card({
					id: "copy-run-done",
					kind: "flow-run",
					title: RUN_DONE_TITLE,
					status: "acted",
					createdAt: 1_700_000_000_000,
					ordinal: 10,
					payload: {
						repo: "will/flows",
						runId: "copy_run_done",
						workflow: "create-workflow",
						phase: "completed",
						steps: ["Started create-workflow on will/flows.", "Wrote the workflow file."],
						result: RUN_RESULT,
						lastSeq: 4,
					},
				}),
				card({
					id: "copy-plan-done",
					kind: "plan",
					title: "What the run did",
					status: "acted",
					createdAt: 1_700_000_000_001,
					ordinal: 11,
					payload: {
						items: [
							{ id: "p1", title: "Read the watched repositories.", status: "done" },
							{ id: "p2", title: "Wrote the workflow file.", status: "done" },
						],
					},
				}),
				card({
					id: "copy-status",
					kind: "status",
					title: "The read",
					status: "acted",
					createdAt: 1_700_000_000_002,
					ordinal: 12,
					payload: { progress: 1, note: "Read four repositories." },
				}),
				card({
					id: "copy-world",
					kind: "world",
					title: "What I know",
					status: "acted",
					createdAt: 1_700_000_000_003,
					ordinal: 13,
					payload: { documents: [{ path: "world/goals.md", title: "Goals", confidence: 0.8 }] },
				}),
				card({
					id: "copy-reco",
					kind: "reco",
					title: "What I would do next",
					status: "acted",
					createdAt: 1_700_000_000_004,
					ordinal: 14,
					payload: {
						sentence: "Four repositories read.",
						digest: {
							computedAt: "2026-08-18T00:00:00.000Z",
							reposConsidered: 4,
							openIssues: 7,
							openPullRequests: 2,
							staleCount: 1,
							mostActiveRepo: "will/flows",
							oldestWaiting: null,
							untriagedInMostActive: 0,
						},
						recommendation: {
							id: "r1",
							title: "Summarise the open issues in will/flows",
							proposes: "Read every open issue and write one summary.",
							whyNow: "Seven issues are open and none has been triaged.",
							whatHappens: "A workflow runs on your workspace and writes a summary.",
							subjectUrl: "https://github.test/will/flows/issues",
							evidenceKey: "e-1",
						},
					},
				}),
				say("That is everything I finished."),
				DONE,
			],
		});
		await turn(page, "show me what you finished", "That is everything I finished.");

		const settled = await page.evaluate<ReadonlyArray<CardFact>>(CARD_FACTS);
		const runDone = required(
			cardTitled(settled, RUN_DONE_TITLE),
			`the settled run card never rendered; read ${settled.map((fact) => fact.label).join(" | ")}`,
		);
		report.equals(
			runDone.lead,
			RUN_RESULT,
			"the settled run card does not lead with its result (B-4: the result must come before the phase word)",
		);
		report.check(
			runDone.lead !== PHASE_WORD_COMPLETED,
			`the settled run card leads with the phase word ${JSON.stringify(PHASE_WORD_COMPLETED)} instead of its result`,
		);
		report.includes(runDone.body, PHASE_WORD_COMPLETED, "the settled run card dropped its phase word entirely");
		report.ok("a settled run card leads with its result and states the phase after it.");

		/*
		 * The general form of the same law: no card may open its body by
		 * repeating the process word its own pill already carries.
		 */
		const echoed = settled.filter(
			(fact) => fact.pillText !== "" && fact.lead.toLowerCase().startsWith(fact.pillText.toLowerCase()),
		);
		report.check(
			echoed.length === 0,
			`card(s) lead with the process word their pill already says: ${echoed.map((fact) => `${fact.kind}: ${fact.lead}`).join(" | ")}`,
		);
		report.check(settled.length >= 5, `only ${settled.length} card(s) rendered, so the lead law was barely measured.`);
		report.ok(`${settled.length} cards read; none leads with the process word its pill already carries.`);

		/*
		 * The shared instrument row B-4 itself uses. It selects
		 * `[data-card-kind], .card`; the app renders `.smithers-card[data-kind]`
		 * and nothing anywhere carries either, so the live row has always
		 * answered "not-testable-yet". Recorded, not asserted: fixing
		 * src/launch-checklist/Probes.ts belongs to whoever owns that file.
		 */
		const shared = await page.evaluate<ReadonlyArray<{ kind: string; lead: string }>>(CARD_LEADS);
		if (shared.length !== settled.length) {
			console.log(
				`note: E4.5-E4.9 — Probes.CARD_LEADS read ${shared.length} of the ${settled.length} rendered cards. ` +
					`Its selector "[data-card-kind], .card" matches nothing this app renders, so live row B-4 is undecidable.`,
			);
		}

		/* ---------------------------------------------------------------- *
		 * B-5 — no score, grade or quality number is user-facing.
		 * ---------------------------------------------------------------- */
		const galleryText = await page.text();
		const score = SCORE_COPY.exec(galleryText);
		report.check(
			score === null,
			`score/grade copy rendered across the card gallery: ${JSON.stringify(score?.[0] ?? "")}`,
		);
		/*
		 * The half of the row the shared bar cannot see. SCORE_COPY spells a
		 * confidence number as "confidence: 0.8" or "80% confident"; the product
		 * spells the same fact as a bare percentage badge — WorldCardBody in
		 * ChatCards.tsx renders <Badge>{Math.round(confidence * 100)}%</Badge>,
		 * and the world panel in App.tsx renders "80% confidence", which
		 * SCORE_COPY also misses because its alternative is the word
		 * "confident". So the app ships the exact number row B-5 forbids and the
		 * row's own regex reports clean.
		 *
		 * A percentage on this surface IS a confidence score: the only two `%`
		 * literals in src/mainview are those two badges, so the local bar cannot
		 * fire on anything else the gallery renders. Widening SCORE_COPY belongs
		 * to whoever owns src/launch-checklist/Probes.ts, and removing the badge
		 * belongs to whoever owns the card; both are in this lane's
		 * needsOtherLane note. Until then this suite grades the spelling that
		 * ships.
		 */
		const percent = SCORE_PERCENT_COPY.exec(galleryText);
		if (percent !== null) {
			const defect =
				`row B-5: the card gallery shows a confidence score as a bare percentage ${JSON.stringify(percent[0])} — ` +
				"WorldCardBody's confidence badge in src/mainview/ChatCards.tsx. The row forbids a user-facing score; " +
				"SCORE_COPY in src/launch-checklist/Probes.ts does not match this spelling, which is why the row read clean.";
			console.log(`defect: E4.5-E4.9 — ${defect}`);
			openDefects.push(defect);
		}
		if (openDefects.length === 0) {
			report.ok(
				"no score, grade or quality number is user-facing across a settled run, plan, status, world and reco card.",
			);
		}

		/* ---------------------------------------------------------------- *
		 * B-7 — zero rating prompts.
		 * ---------------------------------------------------------------- */
		const rating = RATING_COPY.exec(galleryText);
		report.check(rating === null, `a rating prompt is rendered: ${JSON.stringify(rating?.[0] ?? "")}`);
		report.ok("no rating prompt is rendered beside a finished run or its recommendation.");

		/* ---------------------------------------------------------------- *
		 * B-6 — a correction revises the card; it never becomes an error.
		 * A correction on this wire is a card.update that rewrites an earlier
		 * card, which is exactly what the user asking for the other repository
		 * produces.
		 * ---------------------------------------------------------------- */
		stack.chat.script([
			{
				frames: [
					card({
						id: "copy-plan-fix",
						kind: "plan",
						title: PLAN_FIX_TITLE,
						status: "active",
						createdAt: 1_700_000_000_005,
						ordinal: 15,
						payload: { items: [{ id: "f1", title: "Summarise open issues in will/mvp", status: "active" }] },
					}),
					say("Here is the plan for will/mvp."),
					DONE,
				],
			},
			{
				frames: [
					update("copy-plan-fix", {
						payload: { items: [{ id: "f1", title: "Summarise open issues in will/flows", status: "active" }] },
					}),
					say("Switched to will/flows; the plan now reads that repository."),
					DONE,
				],
			},
		]);
		await turn(page, "show me the plan", "Here is the plan for will/mvp.");
		const beforeCorrection = await turn(
			page,
			"actually the other repository",
			"Switched to will/flows; the plan now reads that repository.",
		);

		const corrected = await page.evaluate<ReadonlyArray<CardFact>>(CARD_FACTS);
		const plan = required(cardTitled(corrected, PLAN_FIX_TITLE), "the corrected plan card never rendered.");
		report.includes(plan.body, "will/flows", "the correction did not reach the plan card");
		report.excludes(plan.body, "will/mvp", "the corrected plan card still names the repository the user replaced");
		report.equals(plan.status, "active", "the corrected plan card flipped out of its active status");
		report.equals(plan.errorChrome, 0, "the corrected plan card rendered error chrome");
		const pageErrorChrome = await page.evaluate<number>(PAGE_ERROR_CHROME);
		report.equals(pageErrorChrome, 0, "the correction turn put error chrome on the page");
		const correctionReply = replyRegion(beforeCorrection, await page.text());
		const errorCopy = ERROR_STATE_COPY.exec(correctionReply);
		report.check(
			errorCopy === null,
			`the correction reply reads as an error: ${JSON.stringify(errorCopy?.[0] ?? "")}`,
		);
		report.ok("a correction revises the card in place: no error chrome, no error copy, the card stays active.");

		/* ---------------------------------------------------------------- *
		 * F-6 — a run parked on an approval gate says so on every surface.
		 * ---------------------------------------------------------------- */
		stack.chat.script({
			frames: [
				card({
					id: "copy-run-blocked",
					kind: "flow-run",
					title: RUN_BLOCKED_TITLE,
					status: "active",
					createdAt: 1_700_000_000_006,
					ordinal: 16,
					payload: {
						repo: "will/flows",
						runId: "copy_run_blocked",
						workflow: "deploy-canary",
						phase: "waiting-approval",
						steps: ["Started deploy-canary on will/flows.", "Reached the approve gate."],
						result: null,
						lastSeq: 2,
					},
				}),
				card({
					id: "copy-approval",
					kind: "approval",
					title: APPROVAL_TITLE,
					status: "active",
					createdAt: 1_700_000_000_007,
					ordinal: 17,
					payload: {
						capability: "deploy:production",
						detail: "The run cannot go further until you answer.",
						runId: "copy_run_blocked",
						nodeId: "approve",
						iteration: 0,
					},
				}),
				say("That run is waiting on your decision."),
				DONE,
			],
		});
		await turn(page, "show me the run waiting on me", "That run is waiting on your decision.");

		const readSurfaces = async (): Promise<{
			run: CardFact;
			approval: CardFact;
			confirmation: ConfirmationFact;
		}> => {
			const facts = await page.evaluate<ReadonlyArray<CardFact>>(CARD_FACTS);
			const confirmations = await page.evaluate<ReadonlyArray<ConfirmationFact>>(CONFIRMATION_FACTS);
			return {
				run: required(cardTitled(facts, RUN_BLOCKED_TITLE), "the blocked run card never rendered."),
				approval: required(cardTitled(facts, APPROVAL_TITLE), "the approval card never rendered."),
				confirmation: required(
					confirmations.find((entry) => entry.label === APPROVAL_TITLE),
					"the approval card rendered no confirmation anatomy.",
				),
			};
		};

		const blocked = await readSurfaces();
		report.equals(blocked.confirmation.state, "requested", "the approval did not render as an open request");
		report.equals(blocked.run.note, PHASE_WORD_WAITING, "the run card body does not state the block");
		report.check(
			blocked.run.steps.length === 2 && blocked.run.steps[1] === "Reached the approve gate.",
			`the run card's step list does not end at the gate: ${blocked.run.steps.join(" | ")}`,
		);
		report.equals(blocked.approval.pillText, PILL_LABEL_WAITING, "the approval pill does not read the block");
		report.equals(blocked.run.pillText, PILL_LABEL_WAITING, "the run pill does not read the block");
		report.check(blocked.confirmation.actions === 2, `the open gate offers ${blocked.confirmation.actions} decisions, not 2.`);
		const blockedDisagreements = disagreements(blocked.run, blocked.approval, blocked.confirmation);
		report.check(
			blockedDisagreements.length === 0,
			`RUNNING-vs-Blocked contradiction: ${blockedDisagreements.join("; ")}`,
		);
		const sessionWhileBlocked = await page.evaluate<{ composer: string | null; busy: string | null }>(SESSION_FACTS);
		report.equals(
			sessionWhileBlocked.composer,
			"ready",
			"the composer claims the chat is still working while the block belongs to the run",
		);
		report.equals(sessionWhileBlocked.busy, "false", "the transcript still reads busy while the run waits on a human");
		report.ok(
			"a run parked on its gate reads waiting-approval on the run pill, the run body, the step list, the approval pill, the confirmation and its live region — and the composer stays ready.",
		);

		/*
		 * Calibration, not a product claim: seed the contradiction F-6 forbids
		 * and require the detector above to name it. A detector that cannot go
		 * red is the failure this whole suite exists to prevent.
		 */
		stack.chat.script({
			frames: [
				update("copy-run-blocked", {
					payload: {
						repo: "will/flows",
						runId: "copy_run_blocked",
						workflow: "deploy-canary",
						phase: "running",
						steps: ["Started deploy-canary on will/flows.", "Reached the approve gate."],
						result: null,
						lastSeq: 3,
					},
				}),
				say("Checked the run."),
				DONE,
			],
		});
		await turn(page, "check on that run", "Checked the run.");
		const seeded = await readSurfaces();
		const seededDisagreements = disagreements(seeded.run, seeded.approval, seeded.confirmation);
		report.check(
			seededDisagreements.length > 0,
			"the surface-agreement detector stayed silent on a run card wearing Running while its gate is open, so its silence proves nothing",
		);
		report.ok(
			`the detector names a seeded RUNNING-vs-Blocked contradiction (${seededDisagreements[0]}), so its silence above is evidence.`,
		);

		/* ---------------------------------------------------------------- *
		 * F-6, the other direction: once the gate settles, no surface may
		 * still be asking. B-7 again, because a decision is the classic place
		 * a product bolts a rating prompt onto.
		 * ---------------------------------------------------------------- */
		stack.chat.script({
			frames: [
				update("copy-run-blocked", {
					payload: {
						repo: "will/flows",
						runId: "copy_run_blocked",
						workflow: "deploy-canary",
						phase: "completed",
						steps: ["Started deploy-canary on will/flows.", "Deployed."],
						result: "Deployed deploy-canary on will/flows.",
						lastSeq: 6,
					},
				}),
				update("copy-approval", {
					status: "acted",
					payload: {
						capability: "deploy:production",
						runId: "copy_run_blocked",
						nodeId: "approve",
						iteration: 0,
						decision: "approved",
						decidedAt: 1_700_000_050_000,
					},
				}),
				say("The gate is settled."),
				DONE,
			],
		});
		await turn(page, "that gate is settled now", "The gate is settled.");

		const settledGate = await readSurfaces();
		report.equals(settledGate.confirmation.state, "approved", "the settled gate did not render as approved");
		report.equals(settledGate.confirmation.actions, 0, "the settled gate still offers decision buttons");
		report.equals(settledGate.confirmation.requests, 0, "the settled gate still renders its request body");
		report.equals(settledGate.confirmation.live, LIVE_LABEL_APPROVED, "the settled gate announces the wrong state");
		report.equals(settledGate.run.pill, "done", "the run pill did not settle with its gate");
		report.equals(settledGate.approval.pill, "approved", "the approval pill did not settle");
		const settledDisagreements = disagreements(settledGate.run, settledGate.approval, settledGate.confirmation);
		report.check(
			settledDisagreements.length === 0,
			`a surface still asks for a decision after the gate settled: ${settledDisagreements.join("; ")}`,
		);
		report.ok("once the gate settles every surface settles with it: no pill, body or live region still asks.");

		const afterDecision = await page.text();
		const ratingAfter = RATING_COPY.exec(afterDecision);
		report.check(
			ratingAfter === null,
			`a rating prompt appeared after the decision: ${JSON.stringify(ratingAfter?.[0] ?? "")}`,
		);
		const scoreAfter = SCORE_COPY.exec(afterDecision);
		report.check(
			scoreAfter === null,
			`score/grade copy appeared after the decision: ${JSON.stringify(scoreAfter?.[0] ?? "")}`,
		);
		const percentAfter = SCORE_PERCENT_COPY.exec(afterDecision);
		if (percentAfter !== null) {
			const defect =
				`row B-5, after the decision: a confidence score is still on screen as a bare percentage ${JSON.stringify(percentAfter[0])}.`;
			console.log(`defect: E4.5-E4.9 — ${defect}`);
			openDefects.push(defect);
		}
		if (openDefects.length === 0) report.ok("a decided approval draws neither a rating prompt nor a score.");

		session.close();

		/*
		 * The deferred raise. Every row above has been measured by the time this
		 * runs, so the output names all of the open defects at once instead of
		 * the first one.
		 */
		report.check(
			openDefects.length === 0,
			`${openDefects.length} product defect(s) this suite proved: ${openDefects.join(" | ")}`,
		);
	},
});
