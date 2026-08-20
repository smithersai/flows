/*
 * The transcript's act rows open up, in a real page (will, 2026-08-19).
 *
 * About "Smithers ran /repos.watch", "Smithers adjusted its approach": "This is
 * cool but I can't click on it or hover to see more".
 *
 * The unit tests pin the detail's composition and the reducer; a page is what
 * proves the three things the directive is actually about — the row states its
 * detail on hover, pressing it opens the SAME row with the transcript and
 * composer still there, and the keyboard reaches it and toggles it. The chat
 * double supplies the shape of the turn; every assertion is about the product.
 */
import { defineSuite } from "../Suite.ts";
import { waitUntil } from "../Assert.ts";
import { toolLoopScript } from "../ChatUpstream.ts";
import type { ProbePage } from "../../src/launch-checklist/Types.ts";

const quote = (value: string): string => JSON.stringify(value);

const BOOT_MS = 30_000;
const TURN_MS = 20_000;

const TOGGLE = ".tool-act-line .tool-act-toggle";
const DETAIL = ".tool-act-line .tool-act-detail";

const count = (page: ProbePage, selector: string): Promise<number> =>
	page.evaluate<number>(`document.querySelectorAll(${quote(selector)}).length`);

const attribute = (page: ProbePage, selector: string, name: string): Promise<string | null> =>
	page.evaluate<string | null>(
		`document.querySelector(${quote(selector)})?.getAttribute(${quote(name)}) ?? null`,
	);

const textOf = (page: ProbePage, selector: string): Promise<string> =>
	page.evaluate<string>(`document.querySelector(${quote(selector)})?.textContent ?? ""`);

const focusToggle = (page: ProbePage): Promise<boolean> =>
	page.evaluate<boolean>(`(() => {
		const toggle = document.querySelector(${quote(TOGGLE)});
		if (toggle === null) return false;
		toggle.focus();
		return document.activeElement === toggle;
	})()`);

const clickToggle = (page: ProbePage): Promise<boolean> =>
	page.evaluate<boolean>(`(() => {
		const toggle = document.querySelector(${quote(TOGGLE)});
		if (toggle === null) return false;
		toggle.click();
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
	id: "act-markers",
	title: "an act row states what it did on hover and opens it in place",
	browser: true,
	run: async ({ stack, report, browser }) => {
		const cookie = await stack.signedInCookie();
		stack.chat.script(
			toolLoopScript(
				{ callId: "call_issues", name: "issues.list", args: "open will/flows" },
				() => "Those are the open ones.",
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

			await sendComposer(page, "show me the open issues");
			await waitUntil(
				report,
				"the turn's act row never rendered as an openable line",
				async () => (await count(page, TOGGLE)) === 1,
				TURN_MS,
			);

			// Hover: the concrete detail, on the row itself.
			const title = await attribute(page, TOGGLE, "title");
			report.check(
				title !== null && title.includes("/issues.list"),
				`the act row's hover detail did not name the flow it ran (saw ${title ?? "nothing"})`,
			);
			report.check(
				title !== null && title.includes("open will/flows"),
				`the act row's hover detail did not carry the arguments (saw ${title ?? "nothing"})`,
			);
			// The visible line stays payload-free (§2b) whatever the detail holds.
			const line = await textOf(page, TOGGLE);
			report.check(!line.includes("{"), `a payload reached the visible act line: ${line}`);
			report.ok("the act row states the flow and its arguments on hover, and its visible line stays payload-free");

			report.equals(await attribute(page, TOGGLE, "aria-expanded"), "false", "the row did not start closed");
			report.equals(await count(page, DETAIL), 0, "the detail was open before anyone opened it");

			// The keyboard reaches it, and Space toggles it — it is a real button.
			report.check(await focusToggle(page), "the act row was not focusable");
			await page.press("Space");
			await waitUntil(
				report,
				"Space on the focused act row never opened its detail",
				async () => (await count(page, DETAIL)) === 1,
				5_000,
			);
			report.equals(await attribute(page, TOGGLE, "aria-expanded"), "true", "aria-expanded did not follow the row open");
			report.equals(
				await textOf(page, DETAIL),
				title ?? "",
				"the opened detail said something other than what the hover promised",
			);
			// THE EMBED LAW: an expansion is not a view. Both stay.
			report.equals(await count(page, ".smithers-transcript"), 1, "the transcript left when the row opened");
			report.equals(await count(page, "textarea"), 1, "the composer left when the row opened");
			report.ok("the row is focusable, Space opens it in place, and the transcript and composer stay");

			report.check(await clickToggle(page), "the act row's toggle was not clickable");
			await waitUntil(
				report,
				"clicking the open act row never closed it again",
				async () => (await count(page, DETAIL)) === 0,
				5_000,
			);
			report.equals(await attribute(page, TOGGLE, "aria-expanded"), "false", "aria-expanded did not follow the row closed");
			report.ok("clicking it closes it again, and aria-expanded tracks the row both ways");
		} finally {
			await session.send("Page.navigate", { url: "about:blank" });
			session.close();
			stack.chat.reset();
		}
	},
});
