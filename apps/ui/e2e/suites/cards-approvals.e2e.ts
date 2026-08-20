/*
 * E4.1, E4.10 and E4.11 — the card-frame contract, the decided approval, and
 * the embed law, asserted against the rendered page.
 *
 * Everything here is driven by NDJSON frames the chat double streams, so the
 * whole path under test is the deployed one: the double's line, the Worker's
 * `tagRunId` pass-through, `WebAgent`'s stream reader, `AppController`'s
 * per-patch validation, the `AppStore` reducers, and finally the DOM. The
 * assertions read the DOM the product actually renders — `.smithers-card`,
 * `[data-slot="confirmation"]`, `[data-flow="card.maximize"]` — because a
 * rename of any of those is exactly the regression this suite exists to catch.
 *
 *   E4.1  invalid and unknown frames are dropped mid-stream and the turn still
 *         completes: the surviving cards render, the text on both sides of the
 *         bad frames arrives, and the composer accepts the next message.
 *   E4.10 a decided approval freezes: acted status, the mono "Approved — HH:MM"
 *         stamp, no decision buttons left, exactly one submitApproval on the
 *         seam, and no later frame can reopen it for a second decision.
 *   E4.11 an agent's surface invocation renders the EMBEDDED card and its
 *         card.maximize is refused out loud; only the human's click maximizes.
 */
import { defineSuite } from "../Suite.ts";
import { waitUntil } from "../Assert.ts";
import { sendPrompt, waitForText } from "../../src/launch-checklist/Probes.ts";
import type { ProbePage } from "../../src/launch-checklist/Types.ts";

/** `waitForText` takes its clock and its sleep, so a suite can bound both. */
const now = (): number => Date.now();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A streamed turn is short here; every frame gap is the double's default 10ms. */
const TURN_BUDGET_MS = 30_000;

/** Expression source: every card on the page, by the two attributes it renders. */
const CARDS = `(() => {
	const cards = Array.from(document.querySelectorAll(".smithers-card[data-kind]"));
	return {
		kinds: cards.map((card) => card.getAttribute("data-kind")),
		labels: cards.map((card) => card.getAttribute("aria-label")),
		maximized: cards.filter((card) => card.getAttribute("data-maximized") === "true").length,
		backdrops: document.querySelectorAll(".card-maximize-backdrop").length,
		pane: document.querySelector(".chat-frame").getAttribute("data-pane"),
		composer: document.querySelector('[data-slot="chat-composer"]').getAttribute("data-status"),
		busy: document.querySelector('[role="log"]').getAttribute("aria-busy"),
		text: document.body.innerText,
	};
})()`;

interface CardsSnapshot {
	readonly kinds: ReadonlyArray<string | null>;
	readonly labels: ReadonlyArray<string | null>;
	readonly maximized: number;
	readonly backdrops: number;
	readonly pane: string | null;
	readonly composer: string | null;
	readonly busy: string | null;
	readonly text: string;
}

/** Expression source: one card of `kind`, read the way a reader sees it. */
const cardOfKind = (kind: string): string => `(() => {
	const cards = Array.from(document.querySelectorAll('section[data-kind=${JSON.stringify(kind)}]'));
	const card = cards[0];
	if (card === undefined) return null;
	const pill = card.querySelector(".smithers-card-header [data-status]");
	return {
		count: cards.length,
		label: card.getAttribute("aria-label"),
		status: card.getAttribute("data-status"),
		maximized: card.getAttribute("data-maximized"),
		pillStatus: pill === null ? null : pill.getAttribute("data-status"),
		pillText: pill === null ? null : pill.textContent.trim(),
		body: card.querySelector(".smithers-card-body").innerText,
		maximizeButtons: card.querySelectorAll('[data-flow="card.maximize"]').length,
		minimizeButtons: card.querySelectorAll('[data-flow="card.minimize"]').length,
	};
})()`;

interface CardSnapshot {
	readonly count: number;
	readonly label: string | null;
	readonly status: string | null;
	readonly maximized: string | null;
	readonly pillStatus: string | null;
	readonly pillText: string | null;
	readonly body: string;
	readonly maximizeButtons: number;
	readonly minimizeButtons: number;
}

/*
 * Expression source: the approval card's decision surface. `ConfirmationActions`
 * renders null outside "requested"/"failed-submission", so `actions` is the
 * structural answer to "can this still be decided?" and `stampFont` proves the
 * stamp really wears --font-mono rather than merely being wrapped in the class.
 */
const APPROVAL = `(() => {
	const card = document.querySelector('section[data-kind="approval"]');
	if (card === null) return null;
	const confirm = card.querySelector('[data-slot="confirmation"]');
	const stamp = card.querySelector('[data-slot="confirmation-accepted"]');
	const live = confirm === null ? null : confirm.querySelector('[role="status"]');
	return {
		cardStatus: card.getAttribute("data-status"),
		confirmState: confirm === null ? null : confirm.getAttribute("data-state"),
		confirmStatus: confirm === null ? null : confirm.getAttribute("data-status"),
		actions: card.querySelectorAll('[data-slot="confirmation-action"]').length,
		requests: card.querySelectorAll('[data-slot="confirmation-request"]').length,
		live: live === null ? null : live.textContent.trim(),
		stampText: stamp === null ? null : stamp.textContent.trim(),
		stampFont: stamp === null ? null : getComputedStyle(stamp).fontFamily,
	};
})()`;

interface ApprovalSnapshot {
	readonly cardStatus: string | null;
	readonly confirmState: string | null;
	readonly confirmStatus: string | null;
	readonly actions: number;
	readonly requests: number;
	readonly live: string | null;
	readonly stampText: string | null;
	readonly stampFont: string | null;
}

/** Click one element by selector, as a real bubbling click React's root sees. */
const click = (selector: string): string =>
	`(() => {
		const target = document.querySelector(${JSON.stringify(selector)});
		if (target === null) return false;
		target.click();
		return true;
	})()`;

/** The chat double repeats its last script, so every scenario ends with this. */
const ACK = {
	frames: [
		{ type: "delta", kind: "text", text: "Still here." },
		{ type: "done", reason: "stop" },
	],
};

/** The one approval under test. No `repo`, so the Worker takes the static gateway seam. */
const APPROVAL_CARD = {
	id: "e4-approval",
	kind: "approval",
	title: "Approve the production deploy",
	status: "active",
	createdAt: 1_700_000_005_000,
	ordinal: 5,
	payload: {
		capability: "deploy:production",
		detail: "Deploy the canary Worker.",
		runId: "run-e4-approval",
		nodeId: "approve",
		iteration: 0,
	},
};

const settled = (text: string, marker: string): boolean => text.includes(marker);

export default defineSuite({
	id: "E4.1/E4.10/E4.11",
	title: "card frames drop safely, a decided approval freezes, and only the human maximizes",
	browser: true,
	order: 40,
	run: async ({ stack, report, browser }) => {
		const cookie = await stack.signedInCookie();
		const session = await browser.open(cookie);
		const page: ProbePage = session.page;

		/** Wait for the page to say the turn is over, then read it. */
		const readAfter = async (marker: string): Promise<CardsSnapshot> => {
			const arrived = await waitForText(page, (text) => settled(text, marker), TURN_BUDGET_MS, now, sleep);
			if (!arrived.ok) {
				report.fail(`the turn never rendered ${JSON.stringify(marker)}: ${arrived.text.slice(-400)}`);
			}
			await waitUntil(
				report,
				"the composer never returned to ready after the turn",
				async () =>
					(await page.evaluate<string | null>(
						`document.querySelector('[data-slot="chat-composer"]').getAttribute("data-status")`,
					)) === "ready",
			);
			return page.evaluate<CardsSnapshot>(CARDS);
		};

		/** How many decisions the engine gateway has actually been told about. */
		const submitted = (): ReadonlyArray<string> =>
			stack.fronts.gateway
				.requests()
				.filter((entry) => entry.method === "POST" && entry.path === "/v1/rpc/submitApproval")
				.map((entry) => entry.body);

		/** A missing element is a product failure, never an optional chain to skip past. */
		const need = <T>(value: T | null, what: string): T => (value === null ? report.fail(what) : value);

		await waitUntil(report, "the SPA never mounted its composer", async () =>
			(await page.evaluate<boolean>(`document.querySelector("textarea") !== null`)) === true,
		);
		report.ok("the signed-in SPA mounted with a composer.");

		/* ------------------------------------------------------------------ */
		/* E4.1 — invalid dropped, unknown ignored, the turn unbroken          */
		/* ------------------------------------------------------------------ */

		stack.chat.script([
			{
				frames: [
					{ type: "delta", kind: "text", text: "Here is the plan. " },
					{
						type: "card",
						card: {
							id: "e4-plan",
							kind: "plan",
							title: "Ship the MVP",
							status: "active",
							createdAt: 1_700_000_001_000,
							ordinal: 1,
							payload: { items: [{ id: "i1", title: "Wave 1 skeleton", status: "active" }] },
						},
					},
					// Invalid payload: a declared kind whose payload fails CardSchema.
					{
						type: "card",
						card: {
							id: "e4-bad-payload",
							kind: "plan",
							title: "Malformed plan",
							status: "active",
							createdAt: 1_700_000_002_000,
							ordinal: 2,
							payload: { items: "not-an-array" },
						},
					},
					// Unknown kind: no member of the CardSchema union claims it.
					{
						type: "card",
						card: {
							id: "e4-unknown-kind",
							kind: "telemetry",
							title: "Unknown kind",
							status: "active",
							createdAt: 1_700_000_003_000,
							ordinal: 3,
							payload: {},
						},
					},
					// Unknown FRAME type: ignoring it must not remove the card it names.
					{ type: "card.remove", id: "e4-plan" },
					// A patch for a card that does not exist.
					{ type: "card.update", id: "e4-missing", patch: { title: "Ghost card" } },
					// A patch that fails CardPatchSchema.
					{ type: "card.update", id: "e4-plan", patch: { status: "nonsense" } },
					// A patch that parses but whose merge fails CardSchema.
					{ type: "card.update", id: "e4-plan", patch: { payload: { items: "not-an-array" } } },
					{
						type: "card",
						card: {
							id: "e4-status",
							kind: "status",
							title: "Analyzing repository",
							status: "active",
							createdAt: 1_700_000_004_000,
							ordinal: 4,
							payload: { progress: 1, note: "Halfway there" },
						},
					},
					{ type: "delta", kind: "text", text: "And the status." },
					{ type: "done", reason: "stop" },
				],
			},
			ACK,
		]);

		await sendPrompt(page, "show me the plan and the status");
		const dropped = await readAfter("And the status.");

		for (const ghost of ["Malformed plan", "Unknown kind", "Ghost card"]) {
			report.check(
				!dropped.labels.includes(ghost),
				`a dropped frame still rendered a card titled ${JSON.stringify(ghost)}: ${dropped.labels.join(" | ")}`,
			);
		}
		const plan = need(
			await page.evaluate<CardSnapshot | null>(cardOfKind("plan")),
			"the valid plan card never rendered, so the drops took a live card with them",
		);
		report.equals(plan.count, 1, "an invalid card frame rendered a second plan card");
		report.equals(plan.label, "Ship the MVP", "the surviving plan card is not the valid one");
		report.equals(plan.status, "active", "an invalid patch mutated the plan card's status");
		report.includes(plan.body, "Wave 1 skeleton", "an unknown frame type removed the live plan card's content");
		report.ok("invalid card payloads, an unknown kind, an unknown frame type and two bad patches all left no trace.");

		const status = need(
			await page.evaluate<CardSnapshot | null>(cardOfKind("status")),
			"the card streamed after the invalid frames never rendered",
		);
		report.equals(status.label, "Analyzing repository", "the card after the invalid frames is not the streamed one");
		report.includes(status.body, "Halfway there", "the card after the invalid frames rendered without its body");
		report.includes(dropped.text, "Here is the plan.", "the text before the dropped frames never reached the transcript");
		report.equals(dropped.composer, "ready", "the turn never settled after a dropped frame");
		report.equals(dropped.busy, "false", "the transcript still claims Smithers is working after a dropped frame");
		report.ok("the turn streamed on through the drops: both text halves and the later card arrived, and it settled.");

		await sendPrompt(page, "are you still there");
		const acked = await readAfter("Still here.");
		report.equals(acked.composer, "ready", "the composer did not accept the message after the dropped frames");
		report.ok("the session stayed usable: the next message went through after the dropped frames.");

		/* ------------------------------------------------------------------ */
		/* E4.11 — the agent embeds, the human maximizes                       */
		/* ------------------------------------------------------------------ */

		stack.chat.script([
			{
				requireTools: true,
				frames: [
					{
						type: "tool_call",
						call_id: "e4-connect",
						name: "commands",
						arguments: JSON.stringify({ action: "execute", name: "connect" }),
					},
					{ type: "done", reason: "tool_call" },
				],
			},
			{
				requireTools: true,
				frames: [
					{
						type: "tool_call",
						call_id: "e4-maximize",
						name: "commands",
						arguments: JSON.stringify({
							action: "execute",
							name: "card.maximize",
							args: "connect-embedded",
						}),
					},
					{ type: "done", reason: "tool_call" },
				],
			},
			{
				requireTools: true,
				frames: [
					{ type: "delta", kind: "text", text: "The connect card is in the chat above." },
					{ type: "done", reason: "stop" },
				],
			},
		]);

		await sendPrompt(page, "connect my work to smithers");
		const embedded = await readAfter("The connect card is in the chat above.");
		const connect = need(
			await page.evaluate<CardSnapshot | null>(cardOfKind("connect")),
			"the agent's /connect invocation rendered no embedded card in the transcript",
		);
		report.equals(connect.label, "Connect work to Smithers", "the embedded connect card is not the one the agent path builds");
		report.equals(connect.maximized, "false", "the agent's invocation rendered a maximized card");
		report.equals(embedded.maximized, 0, "an agent invocation maximized a card");
		report.equals(embedded.backdrops, 0, "an agent invocation opened the maximize backdrop");
		report.equals(embedded.pane, null, "the agent's invocation moved the surface into a takeover pane");
		report.ok("the agent's surface command rendered the embedded card and never moved the surface.");

		/*
		 * On the chain, card.maximize is simply NOT in the model's catalog
		 * (user-only), so the refusal is the gate's: the visible line is the
		 * in-character course change, and the row's DETAIL names the call it
		 * reached for (will, 2026-08-19: act rows carry their detail).
		 */
		report.includes(
			embedded.text,
			"Smithers adjusted its approach",
			"the refused card.maximize left no visible course-change row",
		);
		const refusalDetails = await page.evaluate<string>(
			`(() => Array.from(document.querySelectorAll(".tool-act-line .tool-act-toggle")).map((node) => node.getAttribute("title") ?? "").join(" | "))()`,
		);
		report.includes(refusalDetails, "card.maximize", "no act row's detail names the refused card.maximize");
		report.ok("the agent's card.maximize was refused in character, the act row's detail naming the call.");

		report.equals(connect.maximizeButtons, 1, "the embedded card offers the human no maximize affordance");
		report.equals(connect.minimizeButtons, 0, "the embedded card is already offering minimize, so it is not embedded");
		report.check(
			(await page.evaluate<boolean>(click('section[data-kind="connect"] [data-flow="card.maximize"]'))) === true,
			"the embedded card's maximize button was not clickable",
		);
		await waitUntil(
			report,
			"the human's click never maximized the card",
			async () =>
				(await page.evaluate<string | null>(
					`document.querySelector('section[data-kind="connect"]').getAttribute("data-maximized")`,
				)) === "true",
		);
		const maximized = await page.evaluate<CardsSnapshot>(CARDS);
		report.equals(maximized.maximized, 1, "the human's maximize did not take");
		report.equals(maximized.backdrops, 1, "the maximized card rendered without its backdrop");
		report.equals(maximized.pane, null, "maximizing a card opened a pane instead of morphing the card in place");
		const maximizedConnect = need(
			await page.evaluate<CardSnapshot | null>(cardOfKind("connect")),
			"the connect card vanished when the human maximized it",
		);
		report.equals(maximizedConnect.minimizeButtons, 1, "the maximized card offers no way back");
		report.equals(maximizedConnect.maximizeButtons, 0, "the maximized card still offers maximize");
		report.ok("the same card maximizes on the human's click, with the backdrop and the way back.");

		await page.evaluate(click('section[data-kind="connect"] [data-flow="card.minimize"]'));
		await waitUntil(
			report,
			"the human's minimize never took",
			async () =>
				(await page.evaluate<string | null>(
					`document.querySelector('section[data-kind="connect"]').getAttribute("data-maximized")`,
				)) === "false",
		);
		report.equals(
			await page.evaluate<number>(`document.querySelectorAll(".card-maximize-backdrop").length`),
			0,
			"minimizing left the backdrop on screen",
		);
		report.ok("the human's minimize returns the card to the transcript.");

		/* ------------------------------------------------------------------ */
		/* E4.10 — the decided approval freezes                                */
		/* ------------------------------------------------------------------ */

		stack.chat.script([
			{
				frames: [
					{ type: "delta", kind: "text", text: "This deploy needs your approval." },
					{ type: "card", card: APPROVAL_CARD },
					{ type: "done", reason: "stop" },
				],
			},
			ACK,
		]);

		await sendPrompt(page, "show me what is waiting on me");
		await readAfter("This deploy needs your approval.");
		const pending = need(await page.evaluate<ApprovalSnapshot | null>(APPROVAL), "the approval card never rendered");
		report.equals(pending.cardStatus, "active", "the undecided approval card is not active");
		report.equals(pending.confirmState, "requested", "the undecided approval is not in the requested state");
		report.equals(pending.confirmStatus, "waiting-approval", "the undecided approval does not read as waiting");
		report.equals(pending.actions, 2, "the undecided approval does not offer both decisions");
		report.equals(pending.live, "Waiting for approval", "the approval's live region does not announce the wait");
		report.equals(pending.stampText, null, "an undecided approval already carries a decision stamp");
		report.ok("the streamed approval card renders undecided, with both decisions and a waiting live region.");

		const before = submitted().length;
		report.check(
			(await page.evaluate<boolean>(
				click('section[data-kind="approval"] [data-slot="confirmation-action"][data-decision="approve"]'),
			)) === true,
			"the approval card's Approve button was not clickable",
		);
		await waitUntil(
			report,
			"the approval card never froze after the engine echoed the decision",
			async () =>
				(await page.evaluate<string | null>(
					`document.querySelector('section[data-kind="approval"]').getAttribute("data-status")`,
				)) === "acted",
		);

		const frozen = need(
			await page.evaluate<ApprovalSnapshot | null>(APPROVAL),
			"the approval card vanished when it was decided",
		);
		report.equals(frozen.confirmState, "approved", "the decided approval did not settle to the approved state");
		report.equals(frozen.actions, 0, "the decided approval still renders decision buttons");
		report.equals(frozen.requests, 0, "the decided approval still renders the request body");
		report.equals(frozen.live, "Approved", "the decided approval's live region does not announce the decision");
		report.check(
			/^Approved — \d{1,2}:\d{2}/.test(frozen.stampText ?? ""),
			`the decision stamp does not read "Approved — HH:MM": ${JSON.stringify(frozen.stampText)}`,
		);
		report.check(
			/IBM Plex Mono|ui-monospace|monospace/.test(frozen.stampFont ?? ""),
			`the decision stamp is not rendered in the mono face: ${JSON.stringify(frozen.stampFont)}`,
		);
		const approvalPill = need(
			await page.evaluate<CardSnapshot | null>(cardOfKind("approval")),
			"the decided approval card vanished from the transcript",
		);
		report.equals(approvalPill.pillStatus, "approved", "the decided card's pill does not read approved");
		report.includes(approvalPill.pillText ?? "", "Approved", "the decided card's pill does not say Approved");
		report.ok("the decided approval froze: acted, approved, no buttons left, and a mono Approved — HH:MM stamp.");

		const afterClick = submitted();
		report.equals(afterClick.length - before, 1, "the click sent the engine gateway the wrong number of decisions");
		const decision = JSON.parse(afterClick[afterClick.length - 1] ?? "{}") as {
			runId?: string;
			nodeId?: string;
			iteration?: number;
			decision?: { approved?: boolean };
		};
		report.equals(decision.runId, "run-e4-approval", "the decision named the wrong run");
		report.equals(decision.nodeId, "approve", "the decision named the wrong node");
		report.equals(decision.iteration, 0, "the decision named the wrong iteration");
		report.equals(decision.decision?.approved, true, "the decision the engine received was not an approval");
		report.ok("exactly one submitApproval reached the engine gateway, naming this run's gate.");

		/* ------------------------------------------------------------------ */
		/* E4.10 — and it cannot be re-decided                                 */
		/* ------------------------------------------------------------------ */

		const stamp = frozen.stampText;
		stack.chat.script([
			{
				frames: [
					{ type: "card.update", id: APPROVAL_CARD.id, patch: { status: "active" } },
					{ type: "delta", kind: "text", text: "Patched that approval." },
					{ type: "done", reason: "stop" },
				],
			},
			{
				frames: [
					{ type: "card", card: { ...APPROVAL_CARD, status: "active" } },
					{ type: "delta", kind: "text", text: "Re-sent that approval." },
					{ type: "done", reason: "stop" },
				],
			},
			ACK,
		]);

		await sendPrompt(page, "patch that approval back open");
		await readAfter("Patched that approval.");
		const patched = need(
			await page.evaluate<ApprovalSnapshot | null>(APPROVAL),
			"the decided approval card vanished after a card.update frame",
		);
		report.equals(
			patched.cardStatus,
			"acted",
			"a card.update frame reopened a decided approval, so it can be decided a second time",
		);
		report.equals(patched.actions, 0, "a card.update frame brought the decision buttons back on a decided approval");
		report.equals(patched.stampText, stamp, "a card.update frame changed the decision stamp on a decided approval");

		await sendPrompt(page, "send that approval again");
		await readAfter("Re-sent that approval.");
		const resent = need(
			await page.evaluate<ApprovalSnapshot | null>(APPROVAL),
			"the decided approval card vanished after a re-upserted card frame",
		);
		report.equals(
			resent.cardStatus,
			"acted",
			"re-upserting the card frame reopened a decided approval, so it can be decided a second time",
		);
		report.equals(resent.actions, 0, "re-upserting the card frame brought the decision buttons back");
		report.equals(resent.stampText, stamp, "re-upserting the card frame changed the decision stamp");
		report.equals(
			submitted().length - before,
			1,
			"the engine gateway was told about the decision more than once",
		);
		report.ok("no later frame reopens a decided approval, and the engine hears exactly one decision.");

		session.close();
	},
});
