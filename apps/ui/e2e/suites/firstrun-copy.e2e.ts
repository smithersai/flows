/*
 * First-run copy laws, made hermetic — checklist E2.12 through E2.17.
 *
 * These six rows were live-only: the launch checklist graded them against a
 * real deployment (rows A-2 through A-7 in src/launch-checklist/Rows.ts), so a
 * regression in the product's own first-run copy could only be caught after a
 * deploy. The copy under test belongs to the product, not to the doubles, so
 * most of it grades honestly against the hermetic stack. The one exception is
 * E2.17's 90-second latency bar: stub latency is not production latency, so
 * that row keeps its SLA on the canary and only its liveness half is proven
 * here — the wait below uses LIVENESS_BUDGET_MS, not the row's SLA, so the
 * suite never claims a latency bar a local double cannot fail. E2.13's
 * three-question budget is graded twice: once at the row's bar and once at
 * what the product actually asks today, because the row alone has three units
 * of slack. Every deviation is stated at the row it belongs to.
 *
 * The suite never writes through the browser. `wrangler dev` presents the
 * route host as `url.origin`, and apps/server/src/index.ts refuses an /api/*
 * request whose `Origin` header disagrees with it, so a same-origin POST or
 * PUT from a page served on 127.0.0.1 is answered 403. Every state change here
 * is made from the suite process, which sends no `Origin` at all; the page only
 * reads.
 */
import { defineSuite } from "../Suite.ts";
import { wait, waitUntil } from "../Assert.ts";
import {
	CARD_COLLECTION_COPY,
	FIRST_MESSAGE_BUDGET_MS,
	INTRO_GRANT_LINE,
	SETUP_COPY,
	asRecord,
	countOccurrences,
	countQuestions,
	fetchInPage,
	hasSmithersMessage,
	waitForText,
	type SeamAnswer,
} from "../../src/launch-checklist/Probes.ts";
import type { ProbePage } from "../../src/launch-checklist/Types.ts";

/** The two candidates the reco double offers that the digest is then scoped to. */
const WATCHED: ReadonlyArray<string> = ["will/flows", "will/smithers"];

/*
 * The grant sentence with the amount taken out (ChatCards.tsx:189 renders
 * "You have ${introUsd} of usage on us."). A charge moves the total as well as
 * clearing the grant, so the row's own literal would stop matching either way;
 * this is what makes the "and zero times after" half a real check.
 */
const GRANT_PHRASE = "of usage on us";

/** The A-7 budget, stated by the row itself: at most three questions in the whole first run. */
const QUESTION_BUDGET = 3;

/*
 * What the product actually asks, measured across all three sampled states at
 * this revision: nothing. The row's budget has three units of slack, so a
 * check that only reads `<= 3` would let three new question-shaped lines into
 * the first run before it went red. This is the regression pin at today's
 * behaviour; the budget above stays as the row's own bar, so a failure says
 * which of the two was crossed. Raising this number is a product decision that
 * spends the row's budget, not a way to make a red run green.
 */
const OBSERVED_QUESTIONS = 0;

/*
 * E2.17 / row A-2 has two halves and this stack can only decide one.
 *
 * The row's bar is a 90-second SLA (FIRST_MESSAGE_BUDGET_MS) against a real
 * deployment. Here every seam is a local double answering in single-digit
 * milliseconds — the first message lands in roughly 1.3s — so a 90-second wait
 * cannot go red for the reason the row exists, and passing it would be
 * claiming a latency row local doubles can never fail. The SLA stays a canary
 * claim.
 *
 * Liveness IS decidable here: the page must reach the reco seam and render the
 * sentence it read. That is what this budget waits for. It is sized for a cold
 * wrangler and matches the other waits in this file, so it reds on a hang, not
 * on a slow machine.
 */
const LIVENESS_BUDGET_MS = 30_000;

/*
 * The structural half of row A-6, character for character as
 * src/launch-checklist/Rows.ts:274-277 states it. It is a literal inside a CDP
 * expression there rather than an exported probe, so it cannot be imported
 * yet; see this lane's needsOtherLane note.
 */
const CARD_SHAPED_INPUTS = `document.querySelectorAll("input[autocomplete*='cc-'], input[name*='card' i], input[name*='cvc' i], input[type='tel'][name*='number' i]").length`;

const countOf = (selector: string): string => `document.querySelectorAll(${JSON.stringify(selector)}).length`;

const innerTextOf = (selector: string): string => `(() => {
	const element = document.querySelector(${JSON.stringify(selector)});
	return element === null ? null : element.innerText;
})()`;

export default defineSuite({
	id: "E2.12-E2.17",
	title: "the first run cites a watched repo, asks at most three questions, states the grant line once, and sells nothing",
	browser: true,
	/* Nothing else depends on this suite's state, but it does spend the grant. */
	order: 90,
	run: async ({ origin, stack, report, browser }) => {
		const cookie = await stack.signedInCookie();
		const seam = (page: ProbePage, path: string): Promise<SeamAnswer> =>
			page.evaluate<SeamAnswer>(fetchInPage(path));

		/*
		 * Rows A-4 and A-6 are absolutes: they hold on every signed-in screen,
		 * not just the one a probe happened to sample. Sweep each state.
		 */
		const sweep = async (what: string, text: string, page: ProbePage): Promise<void> => {
			const setup = SETUP_COPY.exec(text);
			report.check(setup === null, `${what}: setup copy rendered on the signed-in surface: ${setup?.[0]}`);
			const collection = CARD_COLLECTION_COPY.exec(text);
			report.check(collection === null, `${what}: card-collection copy rendered: ${collection?.[0]}`);
			const inputs = await page.evaluate<number>(CARD_SHAPED_INPUTS);
			report.equals(inputs, 0, `${what}: card-shaped inputs on the signed-in surface`);
		};

		/* ---- state 1: onboarding, before any repository is chosen ---------- */

		const before = (await (await stack.control("reco", "/stub/watched")).json()) as { watched: unknown };
		report.equals(before.watched, null, "the reco double already held a selection, so this is not a first run");

		const onboarding = await browser.open(cookie);
		await waitUntil(
			report,
			"the repo chooser never mounted on a first-run signed-in load",
			async () => (await onboarding.page.evaluate<number>(countOf(".repo-chooser"))) === 1,
			30_000,
		);
		const onboardingText = await onboarding.page.text();
		report.includes(
			onboardingText,
			"choose which repositories I should watch",
			"the onboarding message did not state the one question it asks",
		);
		report.equals(
			await onboarding.page.evaluate<number>(countOf("section.smithers-card[data-kind='reco']")),
			0,
			"a digest card rendered before any repository was chosen",
		);
		await sweep("onboarding", onboardingText, onboarding.page);
		/* The tab keeps writing its persisted transcript; the next load must not inherit it. */
		await onboarding.send("Page.close").catch(() => undefined);
		onboarding.close();
		report.ok(
			"the onboarding screen asks for repositories and shows no digest, with no setup copy, no card copy and no card-shaped input.",
		);

		/* ---- state 2: the grounded first run ------------------------------- */

		const put = await fetch(`${origin}/api/reco/watched`, {
			method: "PUT",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ selected: [...WATCHED], via: "onboarding" }),
		});
		report.equals(put.status, 200, "the watched-repos write from the suite process");

		/*
		 * The seam's own answer, read before the page opens so the wait below
		 * measures the page and nothing else. Asserting the page renders THIS
		 * sentence is what makes the wait a product check: a first run that
		 * never reaches the reco seam, or that renders a greeting instead of the
		 * digest it read, never satisfies it.
		 */
		const firstRun = (await (
			await fetch(`${origin}/api/reco/first-run`, { headers: { cookie } })
		).json()) as {
			digest?: { sentence?: string };
			recommendation?: { title?: string } | null;
		};
		const sentence = firstRun.digest?.sentence ?? "";
		report.check(sentence.length > 0, "the reco seam answered no digest sentence, so there is nothing to render");

		const startedAt = Date.now();
		const session = await browser.open(cookie);
		const page = session.page;
		/*
		 * E2.17's liveness half. `hasSmithersMessage` is the row's own predicate,
		 * and it is a length test: the signed-in shell alone can clear 80
		 * characters, so on its own it would pass a page that never read
		 * anything. The digest sentence is conjoined for teeth. The wait is
		 * LIVENESS_BUDGET_MS, not the row's SLA — see its comment above.
		 */
		const settled = await waitForText(
			page,
			(text) => hasSmithersMessage(text) && text.includes(sentence),
			LIVENESS_BUDGET_MS,
			() => Date.now(),
			wait,
		);
		const elapsedMs = Date.now() - startedAt;
		report.check(
			settled.ok,
			`no first useful message arrived within ${LIVENESS_BUDGET_MS}ms of a signed-in load; the digest sentence ${JSON.stringify(sentence)} never rendered`,
		);
		report.ok(
			`a signed-in load reaches the reco seam and renders the digest it read, in ${elapsedMs}ms. This is E2.17's liveness half only: row A-2's ${FIRST_MESSAGE_BUDGET_MS}ms SLA is measured against a real deployment and is not claimed here.`,
		);

		/* ---- E2.12 / row A-3: the first message cites repo-specific data ---- */

		const watchedSeam = await seam(page, "/api/reco/watched");
		report.equals(watchedSeam.status, 200, "the page's own read of the watched set");
		const selected = asRecord(watchedSeam.body)?.selected;
		const repos = Array.isArray(selected) ? selected.filter((name): name is string => typeof name === "string") : [];
		report.check(repos.length > 0, "the watched set is empty, so there is no repo-specific fact to cite");
		const citedOnScreen = repos.filter((repo) => settled.text.includes(repo));
		report.check(
			citedOnScreen.length > 0,
			`the first screen cites no watched repository — it is greeting boilerplate. Watched: ${repos.join(", ")}`,
		);
		/*
		 * The double's digest sentence deliberately names no repository, and the
		 * evidence <details> is collapsed so its contents are not in innerText.
		 * The only thing that can satisfy the row is the recommendation title the
		 * product renders (ChatCards.tsx `.reco-title`), which is exactly the
		 * regression the row exists to catch.
		 */
		const recoText = await page.evaluate<string | null>(innerTextOf("section.smithers-card[data-kind='reco']"));
		report.check(recoText !== null, "no reco card rendered, so the first screen carries no read of the watched repos");
		const citedInCard = repos.filter((repo) => (recoText ?? "").includes(repo));
		report.check(
			citedInCard.length > 0,
			`the reco card names no watched repository. Card text: ${JSON.stringify((recoText ?? "").slice(0, 300))}`,
		);
		report.excludes(settled.text, "Welcome — before I read anything", "the grounded first run still shows onboarding copy");
		report.ok(
			`the first screen cites a watched repository by name (${citedInCard.join(", ")}), carried by the recommendation the product rendered, not by boilerplate.`,
		);

		const digestText = await page.text();
		await sweep("the grounded first run", digestText, page);

		/* ---- E2.14 / row A-5: the grant line, once and then never ---------- */

		/*
		 * The line lives only in the balance card body (ChatCards.tsx
		 * `smithers-balance-intro`); the corner chip states the number alone. Row
		 * A-5 counts the sentence on a page that never opens the card, so live it
		 * reports 0 against an expected 1. Open the card the way a user does.
		 *
		 * The grant state is `balance.chargeCount` off the billing seam, not the
		 * `introUsd` row A-5 reads: `introUsd` exists only in the CARD payload
		 * (apps/shared/src/Cards.ts), computed by AppController from chargeCount.
		 * Nothing puts it on the wire, so row A-5 always reads it as null, always
		 * expects 0 occurrences, and has never been able to fail. See this lane's
		 * notes.
		 */
		const grantState = async (what: string): Promise<{ chargeCount: number; totalUsd: string }> => {
			const answer = await seam(page, "/api/billing/balance");
			report.equals(answer.status, 200, `${what}: the page's own read of the billing seam`);
			const balance = asRecord(asRecord(answer.body)?.balance);
			const chargeCount = balance?.chargeCount;
			const totalUsd = balance?.totalUsd;
			report.check(
				typeof chargeCount === "number" && typeof totalUsd === "string",
				`${what}: the billing seam answered no balance.chargeCount/totalUsd: ${answer.text.slice(0, 200)}`,
			);
			return { chargeCount: chargeCount as number, totalUsd: totalUsd as string };
		};

		const openBalance = async (): Promise<void> => {
			const clicked = await page.evaluate<boolean>(`(() => {
	const chip = document.querySelector(".corner-balance-chip");
	if (chip === null) return false;
	chip.click();
	return true;
})()`);
			report.check(clicked, "the corner balance chip never rendered, so the balance card cannot be opened");
		};

		await openBalance();
		await waitUntil(
			report,
			"clicking the balance chip never opened the balance card",
			async () => (await page.evaluate<number>(countOf("section.smithers-card[data-kind='balance']"))) === 1,
			15_000,
		);
		const granted = await grantState("before any charge");
		report.equals(granted.chargeCount, 0, "the billing seam recorded a charge before this suite made one");
		/* The row's literal is "$500 of usage on us", so the grant has to be $500. */
		report.equals(granted.totalUsd, "500", "the unspent grant the balance card states");
		const grantedText = await page.text();
		report.equals(
			countOccurrences(grantedText, INTRO_GRANT_LINE),
			1,
			`"${INTRO_GRANT_LINE}" while the grant is unspent (chargeCount=0)`,
		);
		await sweep("the balance card", grantedText, page);

		/*
		 * A charge also moves the total, so the exact line stops matching for a
		 * second reason. Pin the amount-agnostic phrase as well: without it a
		 * product that dropped the introUsd guard would render "You have
		 * $499.94625 of usage on us." and still satisfy the row's own literal.
		 */
		report.includes(grantedText, GRANT_PHRASE, "the balance card states no intro grant while the grant is unspent");

		await stack.control("billing", "/stub/charge", { method: "POST" });
		await openBalance();
		await waitUntil(
			report,
			`"${INTRO_GRANT_LINE}" survived a recorded charge`,
			async () => !(await page.text()).includes(INTRO_GRANT_LINE),
			15_000,
		);
		const spent = await grantState("after a charge");
		report.check(spent.chargeCount > 0, "the billing seam recorded no charge, so the grant was never spent");
		const spentText = await page.text();
		report.equals(
			countOccurrences(spentText, INTRO_GRANT_LINE),
			0,
			`"${INTRO_GRANT_LINE}" after the grant was spent (chargeCount=${spent.chargeCount})`,
		);
		report.excludes(
			spentText,
			GRANT_PHRASE,
			`the balance card still offers an intro grant after a charge (chargeCount=${spent.chargeCount})`,
		);
		report.ok(
			`"${INTRO_GRANT_LINE}" is stated exactly once while the grant is unspent and zero times after a charge.`,
		);

		/* ---- E2.13 / row A-7: at most three questions in the whole run ------ */

		const states: ReadonlyArray<readonly [string, string]> = [
			["onboarding", onboardingText],
			["the grounded first run", digestText],
			["the balance card", spentText],
		];
		const counts = states.map(([what, text]) => [what, countQuestions(text)] as const);
		const worst = counts.reduce((left, right) => (right[1] > left[1] ? right : left));
		const tally = counts.map(([what, count]) => `${what}=${count}`).join(", ");
		report.check(
			worst[1] <= QUESTION_BUDGET,
			`${worst[0]} asks ${worst[1]} question(s); the whole first run's budget is ${QUESTION_BUDGET} (${tally})`,
		);
		report.check(
			worst[1] <= OBSERVED_QUESTIONS,
			`${worst[0]} asks ${worst[1]} question(s); the product asked ${OBSERVED_QUESTIONS} at the revision this pin was measured (${tally}). Row A-7 still allows ${QUESTION_BUDGET}, so this is a change in the first run's shape, not a row failure.`,
		);
		report.ok(
			`the first run asks ${worst[1]} question(s) across its three states — the pin is ${OBSERVED_QUESTIONS}, and row A-7's budget of ${QUESTION_BUDGET} is untouched.`,
		);

		/* ---- E2.15 and E2.16, restated over every state -------------------- */

		report.ok(
			"no clone/install/configure copy, no card-collection copy and no card-shaped input on the onboarding screen, the grounded first run, or the balance card.",
		);

		session.close();
	},
});
