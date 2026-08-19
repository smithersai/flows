/*
 * E10.2, E10.3, E10.4 — the World pane, driven as a person drives it.
 *
 * The three rows this suite proves are all about what the World surface DOES
 * to the store, not about what a double returned:
 *
 *  - E10.2 an edit typed into the real Milkdown editor reparses the wikilinks
 *    into the note's link graph and stamps `user:world-editor` provenance on
 *    top of the provenance the note already carried.
 *  - E10.3 the trash affordance asks before it acts, the question is
 *    destructive-styled and escapable, and only the confirm deletes.
 *  - E10.4 the empty state left behind by that deletion carries a door out of
 *    itself, and walking through it makes a real note.
 *
 * Nothing here is scripted by a test double. The seed comes from the product's
 * own `initialWorldDocuments`, the edit runs through `AppController`'s
 * `updateDocumentBody`, and every string asserted is a literal that ships in
 * apps/ui/src or in the @smthrs/ui primitive App.tsx renders.
 */
import { defineSuite } from "../Suite.ts";
import { waitUntil } from "../Assert.ts";
import type { CdpSession } from "../Browser.ts";

/** The seeded note (src/mainview/state/AppState.ts `initialWorldDocuments`). */
const SEED_PATH = "World.md";
const SEED_TITLE = "World";
const SEED_SOURCE = "system:bootstrap";
/** The provenance an edit stamps (src/mainview/state/AppController.ts `updateDocumentBody`). */
const EDITOR_SOURCE = "user:world-editor";

/** The two wikilink targets typed into the editor, and the sentence carrying them. */
const LINKED = ["Kernel", "Journal"] as const;
const TYPED = `Smithers depends on [[${LINKED[0]}]] and [[${LINKED[1]}]].`;

/** Copy App.tsx renders around the destructive question and the empty state. */
const DELETE_TITLE = `Delete ${SEED_TITLE}?`;
const DELETE_BODY =
	"This note leaves Smithers' world. You can write it again, but Smithers will treat it as new.";
const DELETE_CONFIRM = "Delete";
const EMPTY_TITLE = "No World notes yet";
const EMPTY_DESCRIPTION = "Smithers will keep what it learns here.";
const EMPTY_ACTION = "Create a note";
const HEADER_ACTION = "New note";
/** The path AppController's `documentPath` hands the first note it makes. */
const CREATED_PATH = "Untitled 1.md";
/** The admin-only flow that mounts the live store dump this suite reads. */
const DEVTOOLS_FLOW = "admin.devtools";

/** A world note as the devtools store dump serializes it. */
interface WorldRow {
	readonly id: string;
	readonly path: string;
	readonly body: string;
	readonly links: ReadonlyArray<string>;
	readonly sources: ReadonlyArray<string>;
	readonly updatedBy: string;
}

const json = (value: unknown): string => JSON.stringify(value);

/** True when `selector` resolves in the page. */
const present = (session: CdpSession, selector: string): Promise<boolean> =>
	session.page.evaluate<boolean>(`document.querySelector(${json(selector)}) !== null`);

/** `textContent` of the first `selector` match, or null when it does not resolve. */
const textOf = (session: CdpSession, selector: string): Promise<string | null> =>
	session.page.evaluate<string | null>(
		`document.querySelector(${json(selector)})?.textContent ?? null`,
	);

/**
 * `textContent` of the whole subtree under the first `selector` match, or null.
 * Deliberately not `innerText`: the badges are `text-transform: uppercase`, so
 * `innerText` would report the CSS casing and an assertion on the product's own
 * copy would never match it.
 */
const subtreeTextOf = (session: CdpSession, selector: string): Promise<string | null> =>
	session.page.evaluate<string | null>(
		`document.querySelector(${json(selector)})?.textContent ?? null`,
	);

/**
 * Click the affordance the way the product binds it: the element's own click
 * handler. Returns false when nothing matched, so a renamed selector fails the
 * suite instead of quietly proving nothing. That silent pass is the rot this
 * harness exists to end.
 */
const click = (session: CdpSession, selector: string): Promise<boolean> =>
	session.page.evaluate<boolean>(`(() => {
		const target = document.querySelector(${json(selector)});
		if (target === null) return false;
		target.click();
		return true;
	})()`);

export default defineSuite({
	id: "E10",
	title: "the World pane reparses an edit with provenance, confirms deletion, and offers its empty state a door",
	browser: true,
	// The suite ends with a World store holding one created note, not the seed.
	order: 90,
	run: async ({ stack, report, browser }) => {
		const cookie = await stack.signedInCookie();
		// Admin is what mounts the devtools store dump, which is how this suite
		// reads the note the product actually wrote rather than a rendered count.
		await stack.makeAdmin();
		const session = await browser.open(cookie);

		await waitUntil(report, "the app shell never mounted", () => present(session, ".app-shell"));

		// ── open the World pane through the composer's surfaces menu ──────────
		report.check(
			await click(session, ".composer-menu-trigger"),
			"the composer's surfaces menu trigger (.composer-menu-trigger) does not exist",
		);
		await waitUntil(report, "the surfaces menu never opened", () =>
			present(session, '.composer-menu-list .composer-menu-item[data-flow="world"]'),
		);
		report.check(
			await click(session, '.composer-menu-list .composer-menu-item[data-flow="world"]'),
			"the surfaces menu carries no World entry",
		);
		await waitUntil(report, "the World pane never rendered", () => present(session, ".world-surface"));
		report.ok("the composer's surfaces menu opens the World pane without leaving the conversation.");

		// ── the baseline the three rows are measured against ──────────────────
		await waitUntil(report, "the seeded note never selected itself", async () =>
			(await textOf(session, ".world-document-meta > span")) === SEED_PATH,
		);
		const baselineFacts = (await subtreeTextOf(session, ".world-document-meta > div")) ?? "";
		report.includes(baselineFacts, "1 source", "the seeded note did not start with exactly one source");
		report.includes(baselineFacts, "100% confidence", "the seeded note did not state its confidence");
		report.ok(`the World pane opens on the seeded ${SEED_PATH}, stating one source and full confidence.`);

		// ── E10.2 — an edit reparses wikilinks and stamps its provenance ──────
		await waitUntil(
			report,
			"the markdown editor never mounted in the World pane",
			() => present(session, ".world-document .sui-markdown-editor .milkdown .ProseMirror"),
			20_000,
		);
		const focused = await session.page.evaluate<boolean>(`(() => {
			const editable = document.querySelector('.world-document .sui-markdown-editor .milkdown .ProseMirror');
			if (editable === null) return false;
			editable.focus();
			const selection = window.getSelection();
			const range = document.createRange();
			range.selectNodeContents(editable);
			range.collapse(false);
			selection.removeAllRanges();
			selection.addRange(range);
			return true;
		})()`);
		report.check(focused, "the World editor's editable surface refused focus");
		// Input.insertText is a real text insertion, so ProseMirror's own input
		// path runs and Milkdown serializes the result exactly as it would for a
		// person typing.
		await session.send("Input.insertText", { text: TYPED });

		// Proof one, rendered: the source count moves from one to two. Only
		// `updateDocumentBody` unioning EDITOR_SOURCE into `sources` produces it.
		await waitUntil(
			report,
			`editing the note never added a second source: ${EDITOR_SOURCE} did not join ${SEED_SOURCE}`,
			async () => ((await subtreeTextOf(session, ".world-document-meta > div")) ?? "").includes("2 sources"),
			10_000,
		);
		report.ok("typing in the World editor added a second source to the note's provenance.");

		// Proof two, exact: read the rows the store actually holds.
		report.check(
			await session.page.evaluate<boolean>(`(() => {
				const composer = document.querySelector('textarea');
				if (composer === null) return false;
				composer.focus();
				composer.select();
				return true;
			})()`),
			"the composer textarea never mounted, so the devtools command could not be run",
		);
		// Input.insertText, not page.type. page.type derives a key `code` from
		// the character, so "/" and "." arrive as unmapped keys and the draft
		// loses them. A draft of "admindevtools" opens no slash menu, and the
		// composer sends the text to the model instead.
		await session.send("Input.insertText", { text: `/${DEVTOOLS_FLOW}` });
		await waitUntil(report, `the slash menu never offered /${DEVTOOLS_FLOW}`, async () =>
			((await subtreeTextOf(session, ".slash-menu")) ?? "").includes(`/${DEVTOOLS_FLOW}`),
		);
		await session.page.press("Enter");
		await waitUntil(
			report,
			"the admin devtools panel never opened, so the store dump could not be read",
			() => present(session, ".devtools-panel"),
		);
		const dump = await session.page.evaluate<string | null>(`(() => {
			const sections = [...document.querySelectorAll('.devtools-panel details')];
			const target = sections.find((node) => node.querySelector('summary code')?.textContent === 'worldDocuments');
			return target?.querySelector('pre.devtools-json')?.textContent ?? null;
		})()`);
		report.check(dump !== null, "the devtools store dump lists no worldDocuments collection");
		const rows = JSON.parse(dump ?? "[]") as ReadonlyArray<WorldRow>;
		const note = rows.find((row) => row.path === SEED_PATH);
		report.check(note !== undefined, `the edited ${SEED_PATH} is not in the store dump`);
		const edited = note as WorldRow;
		report.includes(edited.body, LINKED[0], "the typed edit never reached the note's body");
		report.check(
			edited.sources.includes(EDITOR_SOURCE),
			`the edit did not stamp ${EDITOR_SOURCE} provenance (sources: ${edited.sources.join(", ")})`,
		);
		report.check(
			edited.sources.includes(SEED_SOURCE),
			`the edit replaced the note's original ${SEED_SOURCE} provenance instead of adding to it`,
		);
		report.equals(edited.updatedBy, "user", "the edit was not recorded as the user's act");
		report.ok(`the edit stamped ${EDITOR_SOURCE} on top of ${SEED_SOURCE} and recorded the user as its author.`);
		for (const target of LINKED) {
			report.check(
				edited.links.includes(target),
				`the edit did not reparse [[${target}]] into the note's link graph (links: ${edited.links.join(", ") || "none"})`,
			);
		}
		report.ok(`the edit reparsed both wikilinks into links: ${edited.links.join(", ")}.`);

		// The panel is a third child of the chat frame; leave the pane as found.
		report.check(
			await click(session, '.devtools-panel [data-flow="admin.devtools"]'),
			"the devtools panel carries no close affordance",
		);
		await waitUntil(report, "the devtools panel never closed", async () => !(await present(session, ".devtools-panel")));

		// ── E10.3 — deletion is a question first ──────────────────────────────
		report.check(
			!(await present(session, '[data-slot="dialog-content"]')),
			"a dialog was already mounted before the destructive act was asked for",
		);
		report.check(
			await click(session, ".world-document-meta .world-delete-btn"),
			"the World note carries no delete affordance (.world-delete-btn)",
		);
		await waitUntil(report, "the delete affordance opened no confirm dialog", () =>
			present(session, '[data-slot="dialog-content"]'),
		);
		report.equals(
			await textOf(session, '[data-slot="dialog-title"]'),
			DELETE_TITLE,
			"the confirm dialog does not name the note it is about to delete",
		);
		report.equals(
			await textOf(session, '[data-slot="dialog-description"]'),
			DELETE_BODY,
			"the confirm dialog does not state what deletion costs",
		);
		report.equals(
			await textOf(session, '[data-slot="dialog-footer"] .sui-button-destructive'),
			DELETE_CONFIRM,
			"the confirm action is not the destructive-styled one",
		);
		report.includes(
			(await subtreeTextOf(session, ".world-workspace")) ?? "",
			SEED_PATH,
			"opening the dialog already deleted the note",
		);
		report.ok("the trash affordance asks a destructive, note-naming question and deletes nothing yet.");

		report.check(
			await click(session, '[data-slot="dialog-footer"] button:not(.sui-button-destructive)'),
			"the confirm dialog carries no way out that is not the destructive act",
		);
		await waitUntil(report, "cancelling never closed the dialog", async () =>
			!(await present(session, '[data-slot="dialog-content"]')),
		);
		report.includes(
			(await subtreeTextOf(session, ".world-sidebar")) ?? "",
			SEED_TITLE,
			"cancelling the destructive dialog deleted the note anyway",
		);
		report.equals(
			await textOf(session, ".world-document-meta > span"),
			SEED_PATH,
			"cancelling the destructive dialog closed the note it was asking about",
		);
		report.ok("cancelling the question leaves the note exactly where it was.");

		report.check(
			await click(session, ".world-document-meta .world-delete-btn"),
			"the delete affordance stopped working after a cancel",
		);
		await waitUntil(report, "the delete affordance opened no confirm dialog the second time", () =>
			present(session, '[data-slot="dialog-content"]'),
		);
		report.check(
			await click(session, '[data-slot="dialog-footer"] .sui-button-destructive'),
			"the confirm dialog carries no destructive confirm",
		);
		await waitUntil(report, "confirming never closed the dialog", async () =>
			!(await present(session, '[data-slot="dialog-content"]')),
		);
		await waitUntil(report, "confirming the destructive dialog did not remove the note", async () =>
			!(await present(session, ".world-document-meta")),
		);
		report.ok("only the destructive confirm deletes, and it deletes the note it named.");

		// ── E10.4 — the empty state, and its way out ──────────────────────────
		await waitUntil(report, "deleting the last note rendered no empty state", () =>
			present(session, '.world-document [data-slot="empty-state"]'),
		);
		report.equals(
			await textOf(session, ".world-document .sui-empty-title"),
			EMPTY_TITLE,
			"the World empty state does not name itself",
		);
		report.equals(
			await textOf(session, ".world-document .sui-empty-description"),
			EMPTY_DESCRIPTION,
			"the World empty state does not explain what will fill it",
		);
		report.equals(
			await textOf(session, ".world-document .sui-empty-action button"),
			EMPTY_ACTION,
			"the World empty state is a dead end: it carries no create action",
		);
		report.equals(
			(await subtreeTextOf(session, `.world-surface .surface-header-actions button:not([data-flow])`))?.trim() ??
				null,
			HEADER_ACTION,
			"the World header lost its create door",
		);
		report.ok("the empty state names itself, says what will fill it, and offers a create action.");

		report.check(
			await click(session, ".world-document .sui-empty-action button"),
			"the empty state's create action is not clickable",
		);
		await waitUntil(report, "the empty state's create action made no note", () =>
			present(session, ".world-document-meta"),
		);
		report.equals(
			await textOf(session, ".world-document-meta > span"),
			CREATED_PATH,
			"the note the empty state created does not carry the next free Untitled path",
		);
		report.includes(
			(await subtreeTextOf(session, ".world-document-meta > div")) ?? "",
			"1 source",
			"a note created from the empty state does not carry provenance from birth",
		);
		report.includes(
			(await subtreeTextOf(session, ".world-sidebar")) ?? "",
			CREATED_PATH.replace(/\.md$/, ""),
			"the created note never joined the World sidebar",
		);
		report.ok(`the empty state's create action made a real ${CREATED_PATH} the sidebar lists.`);

		const errors = session.consoleErrors();
		report.check(
			errors.length === 0,
			`the World pane logged ${errors.length} console error(s): ${errors.slice(0, 3).join(" | ")}`,
		);
		report.ok("the whole World round trip ran without a console error.");
	},
});
