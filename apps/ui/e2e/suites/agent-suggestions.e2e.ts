/*
 * The agent's predicted follow-ups, in a real page (will, 2026-08-19).
 *
 * "If it can predict what user might ask next like this case 'What is a flow'
 * smithers should display those as default responses or the ability to trigger
 * a flow as a / command."
 *
 * The unit tests pin the boundary and the reducers; only a page can prove the
 * three things this suite is for: the pills reach the rendered row after a real
 * turn crossed the Worker, pressing one submits the user's own message back
 * through the composer's path, and the structured call leaves no marker row
 * behind in the transcript. The chat double supplies the SHAPE of the turn (a
 * tool call, then an answer); every assertion below is about what the product
 * does with it.
 */
import { defineSuite } from "../Suite.ts";
import { waitUntil } from "../Assert.ts";
import { toolLoopScript } from "../ChatUpstream.ts";
import type { ProbePage } from "../../src/launch-checklist/Types.ts";

const quote = (value: string): string => JSON.stringify(value);

/** A page load plus React mount plus the first-run seam read; wrangler is not fast. */
const BOOT_MS = 30_000;
const TURN_MS = 20_000;

const PILL = ".smithers-suggestions .smithers-suggestion";
const QUESTION = "What is a flow";

const count = (page: ProbePage, selector: string): Promise<number> =>
	page.evaluate<number>(`document.querySelectorAll(${quote(selector)}).length`);

const flowsOf = (page: ProbePage): Promise<ReadonlyArray<string>> =>
	page.evaluate<ReadonlyArray<string>>(
		`Array.from(document.querySelectorAll(${quote(PILL)})).map((pill) => pill.getAttribute("data-flow") ?? "")`,
	);

const labelsOf = (page: ProbePage): Promise<ReadonlyArray<string>> =>
	page.evaluate<ReadonlyArray<string>>(
		`Array.from(document.querySelectorAll(${quote(PILL)})).map((pill) => pill.textContent ?? "")`,
	);

const clickPill = (page: ProbePage, flow: string): Promise<boolean> =>
	page.evaluate<boolean>(`(() => {
		const pill = document.querySelector(${quote(PILL)} + "[data-flow=" + ${quote(`"${flow}"`)} + "]");
		if (pill === null) return false;
		pill.click();
		return true;
	})()`);

const sendComposer = async (page: ProbePage, text: string): Promise<void> => {
	const focused = await page.evaluate<boolean>(`(() => {
		const composer = document.querySelector("textarea");
		if (composer === null) return false;
		composer.focus();
		return true;
	})()`);
	if (!focused) throw new Error("the composer textarea never mounted");
	await page.type(text);
	await page.press("Enter");
};

export default defineSuite({
	id: "agent-suggestions",
	title: "the agent's predicted follow-ups reach the pill row, and pressing one speaks for the user",
	browser: true,
	run: async ({ stack, report, browser }) => {
		const cookie = await stack.signedInCookie();
		/*
		 * Turn 1 proposes through the structured channel and says nothing else;
		 * turn 2 is the answer the user actually reads. Scripts repeat their last
		 * entry, so the turn the pill starts later gets the same plain answer and
		 * proposes nothing — which is what makes "they left" observable.
		 */
		stack.chat.script(
			toolLoopScript(
				{
					callId: "call_suggest",
					name: "suggestions.propose",
					args: JSON.stringify([
						{ kind: "question", label: QUESTION },
						{ kind: "flow", label: "Browse GitHub", flow: "github" },
					]),
				},
				() => "I'm Smithers.",
			),
		);

		const session = await browser.open(cookie);
		try {
			const page = session.page;
			await waitUntil(
				report,
				"the signed-in shell never mounted",
				async () => (await count(page, "textarea")) === 1,
				BOOT_MS,
			);
			// The state-derived row before the turn: this signed-in session has
			// never chosen a watched set, so its one pill is that step.
			const before = await flowsOf(page);
			report.equals(before.join(" "), "repos.watch", "the state-derived pill row was not the one next step");

			await sendComposer(page, "Who are you");
			await waitUntil(
				report,
				"the agent's follow-ups never reached the pill row",
				async () => (await flowsOf(page)).includes("send"),
				TURN_MS,
			);

			const flows = await flowsOf(page);
			report.equals(
				flows.join(" "),
				"repos.watch send github",
				"the follow-ups did not compose with the state-derived pill, in that order",
			);
			const labels = await labelsOf(page);
			report.check(
				labels.some((label) => label.includes(QUESTION)),
				`no pill carried the predicted question (saw ${labels.join(" | ")})`,
			);
			report.ok("a predicted question and a predicted flow render as pills beside the state-derived one");

			/*
			 * The proposal is not an act. Every act row the transcript renders
			 * carries .tool-act-line, so a marker naming the channel would be
			 * visible here — and the transcript must not narrate its own
			 * furniture.
			 */
			report.equals(
				await count(page, ".tool-act-line"),
				0,
				"the structured proposal rendered a marker row in the transcript",
			);
			report.ok("the structured channel leaves no act row behind");

			// Pressing the question pill speaks as the user, through `send`.
			report.check(await clickPill(page, "send"), "the question pill was not in the row");
			await waitUntil(
				report,
				"pressing the question pill never submitted it as the user's own message",
				async () => (await page.text()).includes(QUESTION),
				TURN_MS,
			);
			await waitUntil(
				report,
				"the follow-ups outlived the answer they belonged to",
				async () => !(await flowsOf(page)).includes("send"),
				TURN_MS,
			);
			report.ok("pressing a predicted question sends it as the user's own message, and the row moves on");
		} finally {
			await session.send("Page.navigate", { url: "about:blank" });
			session.close();
			stack.chat.reset();
		}
	},
});
