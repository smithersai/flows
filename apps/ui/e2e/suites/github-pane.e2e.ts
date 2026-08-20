/*
 * The GitHub pane, driven as a person drives it (will, 2026-08-19).
 *
 * "I think what we should be showing here is a bit of a github pane so we
 * should see a list of repos available and if we click on it we see the repo
 * view which will include tabs for issues, prs, flows."
 *
 * The unit tests pin the rows and the reducer; a page is what proves the
 * journey: /github opens on the LIST, the list is the account's repositories in
 * the chooser's three columns, a row opens the repo view with its four tabs,
 * the Issues tab reads real rows through the issues seam, and the whole thing
 * stays embedded — transcript above, composer below — per THE EMBED LAW.
 *
 * Every repository named here comes from the reco double's own candidate set
 * (scripts/stub-backends.ts), and every selector is one apps/ui/src renders.
 */
import { defineSuite } from "../Suite.ts";
import { waitUntil } from "../Assert.ts";
import type { ProbePage } from "../../src/launch-checklist/Types.ts";

const quote = (value: string): string => JSON.stringify(value);

const BOOT_MS = 30_000;
const OPEN_MS = 20_000;

const PANE = '[aria-label="GitHub repositories"]';
const ROW = '.repo-chooser-row[data-flow="repo.open"]';
const TAB = '[data-flow="repo.tab"]';
const BACK = `${PANE} [data-flow="github"]`;
const CLOSE = '.surface-header [data-flow="chat"]';

/** The reco double's candidates, in the order it answers them. */
const CANDIDATES = ["will/flows", "will/smithers", "will/mvp"] as const;

const count = (page: ProbePage, selector: string): Promise<number> =>
	page.evaluate<number>(`document.querySelectorAll(${quote(selector)}).length`);

const textOf = (page: ProbePage, selector: string): Promise<string> =>
	page.evaluate<string>(`document.querySelector(${quote(selector)})?.textContent ?? ""`);

const textsOf = (page: ProbePage, selector: string): Promise<Array<string>> =>
	page.evaluate<Array<string>>(
		`[...document.querySelectorAll(${quote(selector)})].map((node) => node.textContent ?? "")`,
	);

const clickNth = (page: ProbePage, selector: string, index: number): Promise<boolean> =>
	page.evaluate<boolean>(`(() => {
		const node = [...document.querySelectorAll(${quote(selector)})][${index}];
		if (node === undefined) return false;
		node.click();
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
	id: "github-pane",
	title: "the GitHub pane lists the account's repositories and browses into one",
	browser: true,
	run: async ({ stack, report, browser }) => {
		const cookie = await stack.signedInCookie();
		const session = await browser.open(cookie);
		try {
			const page = session.page;
			await waitUntil(
				report,
				"the signed-in shell never mounted",
				async () => (await count(page, "textarea")) === 1,
				BOOT_MS,
			);

			// Nothing is watched in this session. The pane must still open: a
			// surface that silently refuses is the worst answer to a press.
			await sendComposer(page, "/github");
			await waitUntil(
				report,
				"/github never opened the GitHub pane",
				async () => (await count(page, PANE)) === 1,
				OPEN_MS,
			);
			await waitUntil(
				report,
				"the pane opened without the account's repositories",
				async () => (await count(page, ROW)) === CANDIDATES.length,
				OPEN_MS,
			);
			report.ok("/github opens the pane on the repository list with nothing watched");

			const names = await textsOf(page, `${ROW} .repo-chooser-name`);
			report.equals(names.join(","), CANDIDATES.join(","), "the list did not show the account's repositories");
			report.equals(
				await count(page, `${ROW} .repo-chooser-freshness`),
				CANDIDATES.length,
				"a repository row carried no freshness",
			);
			report.equals(
				(await textsOf(page, `${ROW} .repo-chooser-issues`))[0],
				"4 open issues",
				"a repository row carried no open-issue count",
			);
			report.ok("each row states the three columns the chooser row states: name, freshness, open issues");

			// THE EMBED LAW: the pane is embedded, not a takeover.
			report.equals(await count(page, "textarea"), 1, "the composer left when the pane opened");
			report.equals(await count(page, ".smithers-transcript"), 1, "the transcript left when the pane opened");
			report.ok("the pane embeds in the shell with the transcript and composer still there");

			report.check(await clickNth(page, ROW, 0), "the first repository row was not clickable");
			await waitUntil(
				report,
				"clicking a repository never opened its repo view",
				async () => (await count(page, TAB)) === 4,
				OPEN_MS,
			);
			report.equals(
				(await textsOf(page, TAB)).join(","),
				"Files,Issues,Pull Requests,Flows",
				"the repo view did not carry the four tabs the directive names",
			);
			report.check((await textOf(page, BACK)).includes("All repositories"), "the repo view had no way back to the list");
			report.ok("clicking a repository opens the repo view with Files, Issues, Pull Requests and Flows");

			// The Issues tab is a real read through the issues seam, not a shell.
			const issuesTab = (await textsOf(page, TAB)).indexOf("Issues");
			report.check(await clickNth(page, TAB, issuesTab), "the Issues tab was not clickable");
			await waitUntil(
				report,
				"the Issues tab never rendered rows from the issues seam",
				async () => (await count(page, `${PANE} [data-flow="issues.view"]`)) > 0,
				OPEN_MS,
			);
			const firstIssue = (await textsOf(page, `${PANE} [data-flow="issues.view"]`))[0] ?? "";
			report.check(firstIssue.startsWith("#"), `an issue row did not lead with its number (saw ${firstIssue})`);
			report.ok("the Issues tab lists the repository's issues through the issues seam");

			// The way back, then the way out — both are registered flows.
			report.check(await clickNth(page, BACK, 0), "the way back to the list was not clickable");
			await waitUntil(
				report,
				"the way back never returned to the repository list",
				async () => (await count(page, ROW)) === CANDIDATES.length,
				OPEN_MS,
			);
			report.check(await clickNth(page, CLOSE, 0), "the pane's close affordance was not clickable");
			await waitUntil(
				report,
				"closing the pane never returned to the conversation",
				async () => (await count(page, PANE)) === 0,
				OPEN_MS,
			);
			report.ok("the list is one press back and the pane closes to the conversation");
		} finally {
			await session.send("Page.navigate", { url: "about:blank" });
			session.close();
			stack.chat.reset();
		}
	},
});
