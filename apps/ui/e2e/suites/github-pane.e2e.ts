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
const FILES_PANE = '[aria-label="Repository files"]';

/** What THE EMBED LAW asks of a frame, measured in the live page. */
interface Embedding {
	readonly insideTranscript: boolean;
	readonly parentClass: string;
	readonly isLastEntry: boolean;
	readonly dataPane: string | null;
	readonly paneWidth: number;
	readonly messageColumnWidth: number;
	readonly widestMessageWidth: number;
	readonly composers: number;
	readonly composerBelow: boolean;
}

const embedding = (page: ProbePage, selector: string): Promise<Embedding> =>
	page.evaluate<Embedding>(`(() => {
		const pane = document.querySelector(${quote(selector)});
		const transcript = document.querySelector(".smithers-transcript");
		const column = pane === null ? null : pane.parentElement;
		const entries = column === null ? [] : [...column.children];
		const composer = document.querySelector("textarea.sui-chat-composer-input") ?? document.querySelector("textarea");
		const messages = [...document.querySelectorAll(".sui-chat-bubble")];
		return {
			insideTranscript: transcript !== null && pane !== null && transcript.contains(pane),
			parentClass: column === null ? "" : column.className,
			isLastEntry: entries.length > 0 && entries[entries.length - 1] === pane,
			dataPane: document.querySelector(".chat-frame")?.getAttribute("data-pane") ?? null,
			paneWidth: pane === null ? 0 : pane.getBoundingClientRect().width,
			messageColumnWidth: column === null ? 0 : column.getBoundingClientRect().width,
			widestMessageWidth: messages.reduce((widest, node) => Math.max(widest, node.getBoundingClientRect().width), 0),
			composers: document.querySelectorAll("textarea").length,
			composerBelow:
				pane !== null &&
				composer !== null &&
				composer.getBoundingClientRect().top >= pane.getBoundingClientRect().top,
		};
	})()`);

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

			/*
			 * THE EMBED LAW, measured rather than assumed: the frame is a
			 * transcript ENTRY at conversation width, the last one, with the
			 * composer still below it — not a second column beside the chat.
			 * Counting the transcript and the composer is not enough: a 58% side
			 * pane passes that and still breaks the law.
			 */
			const embedded = await embedding(page, PANE);
			report.check(embedded.insideTranscript, "the pane rendered outside the transcript, as a second column");
			report.check(
				embedded.parentClass.includes("sui-chat-messages"),
				`the pane is not a child of the message column (parent: ${embedded.parentClass || "none"})`,
			);
			report.check(embedded.isLastEntry, "the pane is not the newest entry in the transcript");
			report.equals(embedded.dataPane, null, "the shell allocated the pane its own column");
			report.equals(embedded.composers, 1, "the composer left when the pane opened");
			report.check(embedded.composerBelow, "the composer moved above the pane");
			report.equals(await count(page, ".smithers-transcript"), 1, "the transcript left when the pane opened");
			// Conversation width: the frame is bounded by the same message column
			// every bubble is bounded by, and never wider than it.
			report.check(
				embedded.messageColumnWidth > 0 && embedded.paneWidth <= embedded.messageColumnWidth + 1,
				`the pane is wider than the conversation (${Math.round(embedded.paneWidth)}px in a ${Math.round(embedded.messageColumnWidth)}px column)`,
			);
			report.check(
				embedded.paneWidth <= 760,
				`the pane is wider than the 760px conversation column (${Math.round(embedded.paneWidth)}px)`,
			);
			report.ok("the pane is the last transcript entry, at conversation width, with the composer below it");

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

			/*
			 * The frame OWNS the reads it shows. Every repo-scoped read card used
			 * to render twice — once as a standalone transcript card above the
			 * pane, once inside it — so the page held two of every list, and the
			 * previous tab's list stayed behind when the user changed tabs.
			 */
			report.equals(
				await count(page, `[data-flow="issues.view"]`),
				await count(page, `${PANE} [data-flow="issues.view"]`),
				"the issues list rendered twice: once in the transcript and once in the pane",
			);
			report.equals(
				await count(page, '.smithers-card[data-kind="issue-list"]'),
				0,
				"the pane's own issues read was left in the transcript as a standalone card",
			);
			/*
			 * Directive 5, measured on the page: opening a repository starts its
			 * import in the BACKGROUND. No import card, at any phase, ever.
			 */
			report.equals(
				await count(page, '.smithers-card[data-kind="repo-import"]'),
				0,
				"opening a repository rendered an import card the user never asked for",
			);
			report.check(
				!(await page.evaluate<string>('document.body.textContent ?? ""')).includes("Import ·"),
				"opening a repository announced an import to the user",
			);
			report.ok("each tab's list renders once, inside the pane, and the import stays invisible");

			// The Pull Requests tab: the issues-tab row shape on the landing side —
			// number, title, state, author, comment count, updated time.
			const pullsTab = (await textsOf(page, TAB)).indexOf("Pull Requests");
			report.check(await clickNth(page, TAB, pullsTab), "the Pull Requests tab was not clickable");
			await waitUntil(
				report,
				"the Pull Requests tab never rendered rows from the landings seam",
				async () => (await count(page, `${PANE} [data-flow="prs.view"]`)) > 0,
				OPEN_MS,
			);
			const firstPull = (await textsOf(page, `${PANE} [data-flow="prs.view"]`))[0] ?? "";
			report.check(
				firstPull.includes("#31 Reconnect the sync adapter"),
				`a pull-request row did not lead with its number and title (saw ${firstPull})`,
			);
			report.check(firstPull.includes("by will"), `a pull-request row lost its author (saw ${firstPull})`);
			// The count is its own column, next to the comment glyph — the same
			// shape the issues row uses.
			report.equals(
				await count(page, `[data-flow="issues.view"]`),
				0,
				"the Issues tab's list was left behind when the user changed tabs",
			);
			const pullColumns = await textsOf(page, `${PANE} [data-flow="prs.view"] .world-card-path`);
			report.equals(
				(pullColumns[0] ?? "").trim(),
				"3",
				`a pull-request row did not state its comment count (columns: ${pullColumns.join(" | ")})`,
			);
			report.check(
				firstPull.includes("2026-07-29"),
				`a pull-request row did not state when it was updated (saw ${firstPull})`,
			);
			report.ok("the Pull Requests tab lists number, title, state, author, comment count and updated time");

			/*
			 * The Flows tab: the same list treatment on the flow side, with only
			 * the fields a flow has. The stub gateway answers listWorkflows with
			 * two entries, so this proves the rows, not just the tab label.
			 */
			const flowsTab = (await textsOf(page, TAB)).indexOf("Flows");
			report.check(await clickNth(page, TAB, flowsTab), "the Flows tab was not clickable");
			await waitUntil(
				report,
				"the Flows tab never rendered the repository's flows",
				async () => (await count(page, `${PANE} ul.world-card-list.workflow-list li.world-card-row`)) > 0,
				OPEN_MS,
			);
			const flowTitles = await textsOf(page, `${PANE} .workflow-list-row .world-card-title`);
			report.check(
				flowTitles.includes("create-workflow"),
				`a flow row did not state its key (saw ${flowTitles.join(" | ")})`,
			);
			const flowDescriptions = await textsOf(page, `${PANE} .workflow-list-row .world-card-path`);
			report.check(
				flowDescriptions.some((text) => text.includes("Build a new Smithers workflow")),
				`a flow row lost its description (saw ${flowDescriptions.join(" | ")})`,
			);
			report.equals(
				await count(page, `${PANE} .workflow-list-row [data-flow="flow.run"]`),
				flowTitles.length,
				"a flow row carried no run act bound to the registered command",
			);
			// NO INVENTION: a flow has no open/closed state, so no row wears one.
			report.equals(
				await count(page, `${PANE} .workflow-list-row [data-slot="badge"]`),
				0,
				"a flow row wore a state badge no flow has",
			);
			report.equals(
				await count(page, `[data-flow="prs.view"]`),
				0,
				"the Pull Requests tab's list was left behind when the user changed tabs",
			);
			report.ok("the Flows tab lists the repository's flows in the shared row treatment");

			// The Files tab is the SAME browser the /files frame mounts.
			const filesTab = (await textsOf(page, TAB)).indexOf("Files");
			report.check(await clickNth(page, TAB, filesTab), "the Files tab was not clickable");
			await waitUntil(
				report,
				"the Files tab never mounted the shared file browser",
				async () => (await count(page, `${PANE} [data-repo-files-browser="shared"]`)) === 1,
				OPEN_MS,
			);
			report.ok("the Files tab mounts the one shared repository file browser");

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

			// Directive 6: /files opens the same browser, embedded on the same
			// terms. Nothing is watched here, so it opens on the repository list.
			await sendComposer(page, "/files");
			await waitUntil(
				report,
				"/files never opened the Files frame",
				async () => (await count(page, FILES_PANE)) === 1,
				OPEN_MS,
			);
			const filesEmbedded = await embedding(page, FILES_PANE);
			report.check(filesEmbedded.insideTranscript, "the Files frame rendered outside the transcript");
			report.check(
				filesEmbedded.parentClass.includes("sui-chat-messages"),
				"the Files frame is not a child of the message column",
			);
			report.equals(filesEmbedded.dataPane, null, "the shell allocated the Files frame its own column");
			report.check(
				filesEmbedded.paneWidth <= 760,
				`the Files frame is wider than the conversation column (${Math.round(filesEmbedded.paneWidth)}px)`,
			);
			report.equals(filesEmbedded.composers, 1, "the composer left when the Files frame opened");
			// With nothing watched it asks WHICH repository, with the account's own
			// list — it never guesses one.
			report.equals(
				await count(page, '.repo-chooser-row[data-flow="files"]'),
				CANDIDATES.length,
				"the Files frame did not offer the account's repositories to choose from",
			);
			report.check(
				await clickNth(page, '.repo-chooser-row[data-flow="files"]', 0),
				"a Files frame repository row was not clickable",
			);
			await waitUntil(
				report,
				"choosing a repository never opened the shared file browser",
				async () => (await count(page, `${FILES_PANE} [data-repo-files-browser="shared"]`)) === 1,
				OPEN_MS,
			);
			report.ok("/files embeds the same shared browser and asks which repository rather than guessing");
		} finally {
			await session.send("Page.navigate", { url: "about:blank" });
			session.close();
			stack.chat.reset();
		}
	},
});
