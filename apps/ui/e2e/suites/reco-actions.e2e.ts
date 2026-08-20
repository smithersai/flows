/*
 * The one recommendation's three actions, and the three-trigger law behind the
 * watched set — checklist E2.4 through E2.9.
 *
 * Every assertion here is about the PRODUCT, never about the double: what the
 * card renders, which command a pill is bound to, what reaches PUT
 * /api/reco/watched, what reaches POST /api/reco/feedback, and what text the
 * turn route receives. The doubles only record; a suite that asserted a
 * double's own answer would prove nothing.
 *
 * It drives a real headless Chrome because three of these rows are about
 * things only a rendered page has: the slash menu, one Escape keypress, and
 * the composer the edit path prefills.
 */
import { defineSuite } from "../Suite.ts";
import { waitUntil, wait } from "../Assert.ts";
import { DEFAULT_CHAT_SCRIPT, toolLoopScript, type ChatRequest } from "../ChatUpstream.ts";
import type { CdpSession } from "../Browser.ts";
import type { Stack } from "../Stack.ts";
import { asRecord, fetchInPage, type SeamAnswer } from "../../src/launch-checklist/Probes.ts";
import type { ProbePage } from "../../src/launch-checklist/Types.ts";

/** The reco card as the DOM renders it: ChatCards.tsx gives every card `data-kind`. */
const CARD = "section.smithers-card[data-kind='reco']";
const ACCEPT = `${CARD} [data-flow='reco.accept']`;
const EDIT = `${CARD} [data-flow='reco.edit']`;
const DISMISS = `${CARD} [data-flow='reco.dismiss']`;
/*
 * The derived suggestion row carries the SAME command name (App.tsx builds it
 * from the waiting recommendation), so an unscoped [data-flow='reco.accept']
 * count is 2 on a correct page. Every pill count below is card-scoped for that
 * reason, and the suggestion row is counted separately.
 */
const SUGGESTED_ACCEPT = ".smithers-suggestions [data-flow='reco.accept']";
/** The repository rows the recommendation-less landing shows in place of a button. */
const LANDING_ROW = `${CARD} .repo-chooser-row[data-flow="repo.open"]`;
/** The reco double's candidates, in the order it answers them. */
const RECO_CANDIDATES = ["will/flows", "will/smithers", "will/mvp"] as const;
const CHOOSER = ".repo-chooser";
const CONFIRM = "[data-flow='repos.watch.confirm']";

/** A page load plus React mount plus the first-run seam read; wrangler is not fast. */
const BOOT_MS = 30_000;

const quote = (value: string): string => JSON.stringify(value);

const count = (page: ProbePage, selector: string): Promise<number> =>
	page.evaluate<number>(`document.querySelectorAll(${quote(selector)}).length`);

const clickOn = (page: ProbePage, selector: string): Promise<boolean> =>
	page.evaluate<boolean>(`(() => {
		const element = document.querySelector(${quote(selector)});
		if (element === null) return false;
		element.click();
		return true;
	})()`);

const textOf = (page: ProbePage, selector: string): Promise<string> =>
	page.evaluate<string>(`document.querySelector(${quote(selector)})?.textContent ?? ""`);

const textsOf = (page: ProbePage, selector: string): Promise<ReadonlyArray<string>> =>
	page.evaluate<ReadonlyArray<string>>(
		`Array.from(document.querySelectorAll(${quote(selector)})).map((element) => element.textContent ?? "")`,
	);

/*
 * Drive the controlled composer through React's own value setter and a
 * bubbling input event. page.type() fabricates a key code for "/" and ".", and
 * every draft this suite writes contains both.
 */
const setComposer = (page: ProbePage, text: string): Promise<boolean> =>
	page.evaluate<boolean>(`(() => {
		const composer = document.querySelector("textarea");
		if (composer === null) return false;
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
		if (setter === undefined) return false;
		composer.focus();
		setter.call(composer, ${quote(text)});
		composer.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	})()`);

const composerValue = (page: ProbePage): Promise<string> =>
	page.evaluate<string>(`document.querySelector("textarea")?.value ?? ""`);

const activeTag = (page: ProbePage): Promise<string> =>
	page.evaluate<string>(`document.activeElement?.tagName ?? "NONE"`);

const clickRepoRow = (page: ProbePage, fullName: string): Promise<boolean> =>
	page.evaluate<boolean>(`(() => {
		const row = Array.from(document.querySelectorAll(".repo-chooser-row")).find(
			(element) => element.querySelector(".repo-chooser-name")?.textContent === ${quote(fullName)},
		);
		if (row === undefined) return false;
		row.click();
		return true;
	})()`);

interface FeedbackEntry {
	readonly at: string;
	readonly action: string;
	readonly recommendationId: string;
	readonly evidenceKey: string | null;
}

interface WatchedWrite {
	readonly at: string;
	readonly selected: ReadonlyArray<string>;
	readonly via: string;
}

const feedbackLog = async (stack: Stack): Promise<ReadonlyArray<FeedbackEntry>> => {
	const response = await stack.control("reco", "/stub/feedback");
	return ((await response.json()) as { entries?: ReadonlyArray<FeedbackEntry> }).entries ?? [];
};

const watchedWrites = async (stack: Stack): Promise<ReadonlyArray<WatchedWrite>> => {
	const response = await stack.control("reco", "/stub/watched-writes");
	return ((await response.json()) as { writes?: ReadonlyArray<WatchedWrite> }).writes ?? [];
};

const recoControl = (stack: Stack, path: string, body?: unknown): Promise<Response> =>
	stack.control("reco", path, {
		method: "POST",
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

/** The last thing the user said in a turn the Worker forwarded, verbatim. */
const lastUserContent = (request: ChatRequest | undefined): string => {
	const spoken = (request?.messages ?? []).filter((message) => message.role === "user");
	const last = spoken[spoken.length - 1]?.content;
	return typeof last === "string" ? last : "";
};

export default defineSuite({
	id: "E2.4-E2.9",
	title: "the watched set's three triggers, and the recommendation card's accept / edit / dismiss",
	browser: true,
	run: async ({ stack, report, browser }) => {
		const cookie = await stack.signedInCookie();
		// The real reco worker withholds a dismissed recommendation for 7 days.
		// The double models it; arming it is what makes "it does not come back"
		// an observable answer rather than an assumption (checklist CN-17 still
		// tracks the real admin door).
		await recoControl(stack, "/stub/dismissal-suppression", { enabled: true });

		let session: CdpSession | undefined;
		/*
		 * Storage.clearDataForOrigin wipes localStorage for the whole origin, so
		 * a page left open would keep writing its own persisted transcript back
		 * over the next one. Retire each page before opening the next.
		 */
		const freshPage = async (): Promise<ProbePage> => {
			if (session !== undefined) {
				await session.send("Page.navigate", { url: "about:blank" });
				session.close();
			}
			session = await browser.open(cookie);
			return session.page;
		};

		try {
			/* ---------------------------------------------------------- */
			/* E2.4 — one command, one write, three triggers.              */
			/* ---------------------------------------------------------- */
			const page = await freshPage();
			await waitUntil(
				report,
				"the repo chooser never opened for a signed-in user with no watched selection",
				async () => (await count(page, CHOOSER)) === 1,
				BOOT_MS,
			);
			report.equals(
				await count(page, CARD),
				0,
				"a digest card rendered before the user chose anything to watch",
			);

			// Trigger 1 — the onboarding chooser's own confirm.
			report.check(await clickRepoRow(page, "will/flows"), "the chooser never listed will/flows");
			report.check(await clickOn(page, CONFIRM), "the chooser rendered no confirm affordance");
			await waitUntil(
				report,
				"the chooser confirm never wrote the selection to PUT /api/reco/watched",
				async () => (await watchedWrites(stack)).length === 1,
				20_000,
			);
			await waitUntil(
				report,
				"the chooser stayed open after its selection saved",
				async () => (await count(page, CHOOSER)) === 0,
				20_000,
			);

			// Trigger 2 — the slash invocation. This is the leg nothing tested.
			const beforeSlash = stack.chat.requests().length;
			report.check(await setComposer(page, "/repos.watch"), "the composer textarea never mounted");
			await waitUntil(
				report,
				"typing /repos.watch opened no slash menu",
				async () => (await count(page, ".slash-menu-item")) > 0,
				10_000,
			);
			const offered = await textsOf(page, ".slash-menu-item .slash-menu-name");
			report.equals(
				offered.join(","),
				"/repos.watch",
				"the slash menu did not resolve /repos.watch to exactly the one visible command",
			);
			await page.press("Enter");
			await waitUntil(
				report,
				"Enter on the /repos.watch menu entry never reopened the chooser",
				async () => (await count(page, CHOOSER)) === 1,
				20_000,
			);
			report.equals(
				await composerValue(page),
				"",
				"the slash invocation left its own text in the composer instead of running a command",
			);
			report.equals(
				stack.chat.requests().length,
				beforeSlash,
				"typing /repos.watch posted a model turn — the invocation is being treated as a prompt, not a command",
			);
			// Reopening pre-fills from the saved selection, so the label counts
			// the repo already watched plus the one just toggled on.
			report.check(await clickRepoRow(page, "will/smithers"), "the reopened chooser never listed will/smithers");
			report.includes(
				await textOf(page, CONFIRM),
				"Watch 2 repositories",
				"the reopened chooser did not carry the already-watched selection",
			);
			report.check(await clickOn(page, CONFIRM), "the reopened chooser rendered no confirm affordance");
			await waitUntil(
				report,
				"the slash-opened chooser's confirm never wrote the selection",
				async () => (await watchedWrites(stack)).length === 2,
				20_000,
			);
			await waitUntil(
				report,
				"the slash-opened chooser stayed open after its selection saved",
				async () => (await count(page, CHOOSER)) === 0,
				20_000,
			);

			// Trigger 3 — the agent's own tool call, with a repo argument.
			stack.chat.script(
				toolLoopScript(
					{ callId: "reco-actions-repos", name: "repos.watch", args: "will/mvp" },
					(output) => `The chooser is open (${output}).`,
				),
			);
			report.check(await setComposer(page, "watch my mvp repo too"), "the composer textarea never mounted");
			await page.press("Enter");
			await waitUntil(
				report,
				"the agent's repos.watch tool call never opened the chooser",
				async () => (await count(page, CHOOSER)) === 1,
				30_000,
			);
			await waitUntil(
				report,
				"the agent never spoke again after its repos.watch tool call",
				async () => (await page.text()).includes("The chooser is open ("),
				30_000,
			);
			report.includes(
				await textOf(page, CONFIRM),
				"Watch 3 repositories",
				"the agent's repo argument did not pre-select on top of the watched set",
			);
			report.check(await clickOn(page, CONFIRM), "the agent-opened chooser rendered no confirm affordance");
			await waitUntil(
				report,
				"the agent-opened chooser's confirm never wrote the selection",
				async () => (await watchedWrites(stack)).length === 3,
				20_000,
			);
			stack.chat.script(DEFAULT_CHAT_SCRIPT);

			const writes = await watchedWrites(stack);
			report.equals(
				writes.length,
				3,
				"the three triggers did not produce exactly three writes to PUT /api/reco/watched",
			);
			report.equals(
				writes.map((write) => write.via).join(","),
				"onboarding,command,agent",
				"the three triggers did not stamp via onboarding, command, agent in order",
			);
			// Sorted: selection ORDER is an implementation detail of toggling.
			const sets = writes.map((write) => [...write.selected].sort().join(","));
			report.equals(sets[0], "will/flows", "the onboarding write did not carry the chosen set");
			report.equals(sets[1], "will/flows,will/smithers", "the slash write did not carry the chosen set");
			report.equals(
				sets[2],
				"will/flows,will/mvp,will/smithers",
				"the agent write did not carry the chosen set",
			);
			report.ok(
				"E2.4: the chooser confirm, /repos.watch and the agent's tool call are one command and one write — PUT /api/reco/watched, differing only in via: onboarding, command, agent.",
			);

			/* ---------------------------------------------------------- */
			/* E2.5, E2.6 — what the one recommendation card carries.      */
			/* ---------------------------------------------------------- */
			await waitUntil(
				report,
				"the recommendation card never rendered after the watched set was chosen",
				async () => (await count(page, `${CARD} .reco-recommendation`)) === 1,
				30_000,
			);

			// Read the truth from the seam the card was built from: the copy
			// carries em dashes and curly quotes, and hardcoding it here would
			// turn a stub copy edit into a mysterious red.
			const seam = await page.evaluate<SeamAnswer>(fetchInPage("/api/reco/first-run"));
			const firstRun = asRecord(seam.body);
			const recommendation = asRecord(firstRun?.recommendation);
			report.check(
				recommendation !== undefined,
				`the first-run seam answered no recommendation to assert against: ${seam.text}`,
			);
			const proposes = String(recommendation?.proposes ?? "");
			const whyNow = String(recommendation?.whyNow ?? "");
			const whatHappens = String(recommendation?.whatHappens ?? "");
			const recoId = String(recommendation?.id ?? "");
			const evidenceKey = String(recommendation?.evidenceKey ?? "");
			const digestSentence = String(asRecord(firstRun?.digest)?.sentence ?? "");
			for (const [field, value] of [
				["proposes", proposes],
				["whyNow", whyNow],
				["whatHappens", whatHappens],
				["id", recoId],
				["evidenceKey", evidenceKey],
				["digest.sentence", digestSentence],
			] as const) {
				report.check(value !== "", `the first-run seam answered no ${field}, so there is nothing to assert`);
			}

			const rendered = await page.text();
			report.includes(rendered, proposes, "the recommendation card did not render what it proposes");
			report.includes(rendered, whyNow, "the recommendation card did not render why now");
			report.includes(rendered, whatHappens, "the recommendation card did not render what happens");
			report.equals(
				(await textsOf(page, `${CARD} .reco-fields dt`)).join("|"),
				"Proposes|Why now|What happens",
				"the recommendation card did not label its three fields",
			);
			report.ok(
				"E2.5: the one recommendation renders proposes, why-now and what-happens, each labelled and each matching the seam answer verbatim.",
			);

			report.equals(await count(page, CARD), 1, "more than one recommendation card rendered at once");
			report.equals(await count(page, ACCEPT), 1, "the card did not carry exactly one accept affordance");
			report.equals(await count(page, EDIT), 1, "the card did not carry exactly one edit affordance");
			report.equals(await count(page, DISMISS), 1, "the card did not carry exactly one dismiss affordance");
			report.equals(
				await count(page, SUGGESTED_ACCEPT),
				1,
				"the derived suggestion row did not carry the recommendation's one gold binding",
			);
			const registered = await page.evaluate<ReadonlyArray<string>>(
				`(() => {
					const shell = document.querySelector("[data-flows]");
					return (shell?.getAttribute("data-flows") ?? "").split(/\\s+/).filter((name) => name.length > 0);
				})()`,
			);
			for (const name of ["reco.accept", "reco.edit", "reco.dismiss", "repos.watch"]) {
				report.check(
					registered.includes(name),
					`${name} is not in the shell's registry manifest, so that pill is bound to nothing`,
				);
			}
			report.ok(
				"E2.6: the card offers exactly one accept, one edit and one dismiss, every one of them a registered command name, with the derived suggestion row carrying the same accept binding once.",
			);

			/* ---------------------------------------------------------- */
			/* E2.8 — accept RUNS the bound command.                       */
			/* ---------------------------------------------------------- */
			const acceptPage = await freshPage();
			await waitUntil(
				report,
				"the recommendation card never rendered on a fresh signed-in page",
				async () => (await count(acceptPage, ACCEPT)) === 1,
				BOOT_MS,
			);
			const feedbackBeforeAccept = (await feedbackLog(stack)).length;
			const turnsBeforeAccept = stack.chat.requests().length;
			report.check(await clickOn(acceptPage, ACCEPT), "the accept affordance could not be clicked");

			await waitUntil(
				report,
				"the accept pill posted no recommendation feedback — it is behaving as a prompt string, not a command binding",
				async () => (await feedbackLog(stack)).length === feedbackBeforeAccept + 1,
				15_000,
			);
			const accepted = (await feedbackLog(stack))[feedbackBeforeAccept];
			report.equals(accepted?.action, "accept", "the accept pill posted the wrong feedback action");
			report.equals(accepted?.recommendationId, recoId, "the accept feedback named the wrong recommendation");
			report.equals(
				accepted?.evidenceKey,
				evidenceKey,
				"the accept feedback dropped the evidence key the recommendation was grounded on",
			);
			await waitUntil(
				report,
				"the accepted card stayed actionable — it can be answered twice",
				async () => (await count(acceptPage, ACCEPT)) === 0,
				10_000,
			);
			report.includes(
				await acceptPage.text(),
				"Answered — the feedback is logged.",
				"the accepted card did not say it had been answered",
			);
			await waitUntil(
				report,
				"accepting the recommendation started no turn — the pill is decorative",
				async () => stack.chat.requests().length === turnsBeforeAccept + 1,
				20_000,
			);
			/*
			 * On the chain wire the upstream sees ONE user message: the rendered
			 * context lines. The accepted proposal must be its LAST line, spoken
			 * as the user — that is what "the pill speaks for the user" means on
			 * this wire.
			 */
			const acceptedContent = lastUserContent(stack.chat.requests()[turnsBeforeAccept]);
			report.check(
				acceptedContent === proposes || acceptedContent.endsWith(`user: ${proposes}`),
				`the accepted proposal did not reach the turn route as the user's own message (saw ${JSON.stringify(acceptedContent.slice(-200))})`,
			);
			report.equals(
				await composerValue(acceptPage),
				"",
				"accept prefilled the composer — that is the edit path's behaviour, not accept's",
			);

			// The decisive half: the SAME name typed as a slash command must do
			// the same three things. A pill that only looked like a command
			// could pass everything above; it cannot pass this.
			const slashAcceptPage = await freshPage();
			await waitUntil(
				report,
				"the recommendation card never rendered for the /reco.accept leg",
				async () => (await count(slashAcceptPage, ACCEPT)) === 1,
				BOOT_MS,
			);
			const feedbackBeforeSlash = (await feedbackLog(stack)).length;
			const turnsBeforeSlashAccept = stack.chat.requests().length;
			report.check(await setComposer(slashAcceptPage, "/reco.accept"), "the composer textarea never mounted");
			await waitUntil(
				report,
				"typing /reco.accept opened no slash menu",
				async () => (await count(slashAcceptPage, ".slash-menu-item")) > 0,
				10_000,
			);
			report.equals(
				(await textsOf(slashAcceptPage, ".slash-menu-item .slash-menu-name")).join(","),
				"/reco.accept",
				"the slash menu did not resolve /reco.accept to exactly one command",
			);
			await slashAcceptPage.press("Enter");
			await waitUntil(
				report,
				"/reco.accept posted no recommendation feedback — the pill and the command are not the same act",
				async () => (await feedbackLog(stack)).length === feedbackBeforeSlash + 1,
				15_000,
			);
			const slashAccepted = (await feedbackLog(stack))[feedbackBeforeSlash];
			report.equals(slashAccepted?.action, "accept", "/reco.accept posted the wrong feedback action");
			report.equals(
				slashAccepted?.evidenceKey,
				evidenceKey,
				"/reco.accept posted feedback without the recommendation's evidence key",
			);
			await waitUntil(
				report,
				"/reco.accept started no turn, so the pill and the command do not resolve to the same act",
				async () => stack.chat.requests().length === turnsBeforeSlashAccept + 1,
				20_000,
			);
			report.equals(
				lastUserContent(stack.chat.requests()[turnsBeforeSlashAccept]),
				proposes,
				"/reco.accept did not carry the proposal to the turn route the way the pill does",
			);
			await waitUntil(
				report,
				"/reco.accept left the card actionable, while the pill freezes it",
				async () => (await count(slashAcceptPage, ACCEPT)) === 0,
				10_000,
			);
			report.ok(
				"E2.8: reco.accept is a command binding — the pill and /reco.accept both post accept feedback carrying the evidence key, freeze the card, and start one turn whose user message is the proposal verbatim; neither prefills the composer.",
			);

			/* ---------------------------------------------------------- */
			/* E2.9 — the EDITED act is what runs.                         */
			/* ---------------------------------------------------------- */
			const editPage = await freshPage();
			await waitUntil(
				report,
				"the recommendation card never rendered for the edit leg",
				async () => (await count(editPage, EDIT)) === 1,
				BOOT_MS,
			);
			const feedbackBeforeEdit = (await feedbackLog(stack)).length;
			const turnsBeforeEdit = stack.chat.requests().length;
			report.check(await clickOn(editPage, EDIT), "the edit affordance could not be clicked");

			await waitUntil(
				report,
				"reco.edit did not open the composer prefilled with the proposal",
				async () => (await composerValue(editPage)) === proposes,
				15_000,
			);
			// What it opens is the composer — not a pane, not a takeover.
			report.equals(
				await editPage.evaluate<string | null>(
					`document.querySelector(".chat-frame")?.getAttribute("data-pane") ?? null`,
				),
				null,
				"reco.edit opened a surface instead of the composer",
			);
			report.equals(
				await count(editPage, ".card-maximize-backdrop"),
				0,
				"reco.edit took the screen over instead of prefilling the composer",
			);
			await waitUntil(
				report,
				"reco.edit posted no recommendation feedback — the prefill is not the edit flow",
				async () => (await feedbackLog(stack)).length === feedbackBeforeEdit + 1,
				15_000,
			);
			const edited = (await feedbackLog(stack))[feedbackBeforeEdit];
			report.equals(edited?.action, "edit", "reco.edit posted the wrong feedback action");
			report.equals(edited?.recommendationId, recoId, "the edit feedback named the wrong recommendation");
			report.equals(
				edited?.evidenceKey,
				evidenceKey,
				"the edit feedback dropped the evidence key the recommendation was grounded on",
			);
			await waitUntil(
				report,
				"the edited card stayed actionable after it was answered",
				async () => (await count(editPage, EDIT)) === 0,
				10_000,
			);
			report.includes(
				await editPage.text(),
				"Answered — the feedback is logged.",
				"the edited card did not say it had been answered",
			);
			// Edit hands the words back to the user. Running anything here would
			// be the bug: the whole point is that the user reshapes it first.
			await wait(1_500);
			report.equals(
				stack.chat.requests().length,
				turnsBeforeEdit,
				"reco.edit started a turn on its own — the user never got to edit anything",
			);

			const marker = " Only the first two files, and do not push anything.";
			const reshaped = `${proposes}${marker}`;
			report.check(await setComposer(editPage, reshaped), "the composer textarea never mounted");
			await editPage.press("Enter");
			await waitUntil(
				report,
				"submitting the edited proposal started no turn",
				async () => stack.chat.requests().length === turnsBeforeEdit + 1,
				20_000,
			);
			const ranText = lastUserContent(stack.chat.requests()[turnsBeforeEdit]);
			report.equals(
				ranText,
				reshaped,
				"the turn did not carry the edited proposal — reco.edit's prefill is decorative",
			);
			report.check(
				ranText !== proposes && ranText.endsWith(marker),
				"the turn carried the unedited proposal, so the edit never reached the act that ran",
			);
			await waitUntil(
				report,
				"the edited proposal never appeared in the transcript as the user's own words",
				async () => (await editPage.text()).includes(reshaped),
				15_000,
			);
			report.ok(
				"E2.9: reco.edit posts edit feedback, freezes the card and prefills the composer with the proposal — and the turn that follows carries the EDITED text, never the original.",
			);

			/* ---------------------------------------------------------- */
			/* E2.7 — one keypress, and it does not come back.             */
			/* ---------------------------------------------------------- */
			await recoControl(stack, "/stub/clear-dismissals");

			// Escape that closes the slash menu must not also answer the
			// recommendation: the menu is what the keypress was aimed at.
			const menuPage = await freshPage();
			await waitUntil(
				report,
				"the recommendation card never rendered for the slash-menu Escape leg",
				async () => (await count(menuPage, DISMISS)) === 1,
				BOOT_MS,
			);
			const feedbackBeforeMenu = (await feedbackLog(stack)).length;
			report.check(await setComposer(menuPage, "/"), "the composer textarea never mounted");
			await waitUntil(
				report,
				"a bare / opened no slash menu",
				async () => (await count(menuPage, ".slash-menu")) === 1,
				10_000,
			);
			await menuPage.press("Escape");
			await waitUntil(
				report,
				"Escape did not close the slash menu",
				async () => (await count(menuPage, ".slash-menu")) === 0,
				10_000,
			);
			report.equals(
				await count(menuPage, DISMISS),
				1,
				"the Escape that closed the slash menu also dismissed the recommendation",
			);
			report.equals(
				(await feedbackLog(stack)).length,
				feedbackBeforeMenu,
				"the Escape that closed the slash menu posted dismiss feedback",
			);

			const dismissPage = await freshPage();
			await waitUntil(
				report,
				"the recommendation card never rendered for the dismiss leg",
				async () => (await count(dismissPage, DISMISS)) === 1,
				BOOT_MS,
			);
			// The row is about ONE keypress from where the user already is. The
			// composer autofocuses on load, so that is where focus must be — a
			// row that first tabbed into the card would prove something else.
			report.equals(
				await activeTag(dismissPage),
				"TEXTAREA",
				"the composer did not hold focus on load, so an Escape here would not be the one-keypress path",
			);
			const feedbackBeforeDismiss = (await feedbackLog(stack)).length;
			await dismissPage.press("Escape");
			await waitUntil(
				report,
				"one Escape did not dismiss the recommendation",
				async () => (await count(dismissPage, DISMISS)) === 0,
				10_000,
			);
			await waitUntil(
				report,
				"the dismissal never reached POST /api/reco/feedback — the card was only hidden locally",
				async () => (await feedbackLog(stack)).length === feedbackBeforeDismiss + 1,
				15_000,
			);
			const dismissed = (await feedbackLog(stack))[feedbackBeforeDismiss];
			report.equals(dismissed?.action, "dismiss", "the Escape posted the wrong feedback action");
			report.equals(dismissed?.recommendationId, recoId, "the dismiss feedback named the wrong recommendation");
			report.equals(
				dismissed?.evidenceKey,
				evidenceKey,
				"the dismiss feedback dropped the evidence key the recommendation was grounded on",
			);
			report.includes(
				await dismissPage.text(),
				digestSentence,
				"dismissing the recommendation also took the digest away",
			);

			// It does not come back.
			await dismissPage.reload();
			await waitUntil(
				report,
				"the digest card never re-rendered after a reload",
				async () => (await count(dismissPage, CARD)) === 1,
				BOOT_MS,
			);
			report.equals(
				await count(dismissPage, ACCEPT),
				0,
				"the dismissed recommendation came back unchanged after a reload",
			);
			report.equals(
				await count(dismissPage, SUGGESTED_ACCEPT),
				0,
				"the dismissed recommendation still leads the suggestion row",
			);
			/*
			 * Directive 1b (will, 2026-08-19): the recommendation-less landing IS
			 * the repository list — "we should see a list of repos available and
			 * if we click on it we see the repo view". Not a button that leads to
			 * one: the rows are in the landing, and pressing one opens that
			 * repository.
			 */
			await waitUntil(
				report,
				"the recommendation-less landing never showed the account's repositories",
				async () => (await count(dismissPage, LANDING_ROW)) === RECO_CANDIDATES.length,
				BOOT_MS,
			);
			report.equals(
				(await textsOf(dismissPage, `${LANDING_ROW} .repo-chooser-name`)).join(","),
				RECO_CANDIDATES.join(","),
				"the landing list did not show the account's repositories",
			);
			report.equals(
				await count(dismissPage, `${CARD} [data-flow="github"]`),
				0,
				"the landing still asks for a press before showing the repositories",
			);
			report.check(
				await clickOn(dismissPage, LANDING_ROW),
				"a repository row in the landing was not clickable",
			);
			await waitUntil(
				report,
				"pressing a repository row in the landing never opened the repo view",
				async () => (await count(dismissPage, '[data-flow="repo.tab"]')) === 4,
				BOOT_MS,
			);
			// THE EMBED LAW: what opened is a transcript entry, not a column.
			report.equals(
				await dismissPage.evaluate<string | null>(
					`document.querySelector(".chat-frame")?.getAttribute("data-pane") ?? null`,
				),
				null,
				"browsing into a repository opened a pane beside the conversation",
			);
			report.check(
				await dismissPage.evaluate<boolean>(
					`document.querySelector(".smithers-transcript")?.contains(document.querySelector('[aria-label="GitHub repositories"]')) === true`,
				),
				"the repository view rendered outside the transcript",
			);
			await dismissPage.reload();
			await waitUntil(
				report,
				"the landing never came back after the reload",
				async () => (await count(dismissPage, CARD)) === 1,
				BOOT_MS,
			);

			// It comes back only once something has changed, and it says what.
			await recoControl(stack, "/stub/advance-days", { days: 8 });
			await dismissPage.reload();
			await waitUntil(
				report,
				"the recommendation did not return once the dismissal window had passed",
				async () => (await count(dismissPage, ACCEPT)) === 1,
				BOOT_MS,
			);
			report.equals(await count(dismissPage, EDIT), 1, "the returned recommendation lost its edit affordance");
			report.equals(
				await count(dismissPage, DISMISS),
				1,
				"the returned recommendation lost its dismiss affordance",
			);
			const returnedSeam = await dismissPage.evaluate<SeamAnswer>(fetchInPage("/api/reco/first-run"));
			const whatChanged = String(asRecord(asRecord(returnedSeam.body)?.recommendation)?.whatChanged ?? "");
			report.check(
				whatChanged !== "",
				"the returning recommendation carried no whatChanged, so there is nothing to render",
			);
			const returnedText = await dismissPage.text();
			report.includes(
				returnedText,
				"Back because it changed:",
				"the recommendation returned without saying it had been set aside",
			);
			report.includes(returnedText, whatChanged, "the returned card did not say what had changed");
			report.ok(
				"E2.7: one Escape from the composer dismisses through reco.dismiss with the evidence key, the Escape that closes the slash menu does not, the dismissed recommendation does not return across a reload, and past the window it returns saying what changed.",
			);
		} finally {
			if (session !== undefined) {
				await session.send("Page.navigate", { url: "about:blank" }).catch(() => undefined);
				session.close();
			}
		}
	},
});
