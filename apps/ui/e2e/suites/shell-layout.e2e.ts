/*
 * E9.1–E9.7 — the chat-first shell: panes, node identity, the responsive
 * contract, and the toast law.
 *
 * This is the port of apps/ui/scripts/web-chat-shell-e2e.ts onto the hermetic
 * harness, so the proof finally runs unattended. The standalone script stays
 * where it is; it is the manual driver for a real browser window.
 *
 * The node-identity stamp is the load-bearing trick and it is preserved
 * verbatim. Stamping the live transcript, composer and textarea with an
 * expando, then re-reading the expando after every pane transition, is what
 * separates "the shell kept the conversation mounted" from "the shell threw
 * the conversation away and rebuilt an identical-looking one". A takeover that
 * re-rendered the same transcript would pass a screenshot comparison and still
 * have discarded scroll position, focus and in-flight editor state.
 *
 * Latency and failure come from the billing front (Front.delay / Front.failOnce),
 * not from a patched window.fetch: the controller captures fetch once at
 * construction (AppController.ts:379), so a page-side patch is either invisible
 * or forces a reload, and the front is the seam the harness already owns.
 */
import { wait, waitUntil, type Reporter } from "../Assert.ts";
import type { CdpSession } from "../Browser.ts";
import { defineSuite } from "../Suite.ts";
import { FOCUS_COMPOSER } from "../../src/launch-checklist/Probes.ts";

/** The words that must survive every pane transition (E9.2). */
const MESSAGE = "remember this message across every pane";
/** The unsent draft that must survive them too (E9.2). */
const DRAFT = "a half-written thought";

/**
 * Copied byte-for-byte from AppController.ts:862 and :829 — both carry a
 * typographic ellipsis or apostrophe, so they are never retyped by hand.
 */
const RUNNING_TITLE = "Refreshing your balance…";
const DONE_TITLE = "Balance is up to date";
const FAILED_DETAIL = "Your balance couldn't be refreshed right now.";
/** App.tsx:901 — the placeholder an allowlisted, signed-in composer states. */
const READY_PLACEHOLDER = "Ask Smithers to work on something…";

/** AppController.ts:441-442 — the law under test. */
const TOAST_DEBOUNCE_MS = 300;
const TOAST_AUTO_DISMISS_MS = 4000;

/** chat.css:39 — the single media query that decides beside vs under. */
const NARROW_MAX_WIDTH = 900;

/** The border between the chat column and the pane makes the boxes touch exactly. */
const EPS = 1;

interface Box {
	readonly left: number;
	readonly right: number;
	readonly top: number;
	readonly bottom: number;
	readonly width: number;
	readonly height: number;
}

interface ShellProbe {
	readonly innerWidth: number;
	readonly matchesNarrow: boolean;
	readonly pane: string;
	readonly paneClass: string | null;
	readonly column: Box | null;
	readonly paneBox: Box | null;
	readonly corner: Box | null;
	readonly transcriptBox: Box | null;
	readonly composerBox: Box | null;
	readonly headerButtonsCovered: ReadonlyArray<string>;
	readonly transcriptOverflowsX: boolean;
	readonly closeFlow: string | null;
	readonly registry: ReadonlyArray<string>;
	readonly draft: string | null;
	readonly transcriptText: string;
	readonly transcriptStamped: boolean;
	readonly composerStamped: boolean;
	readonly textareaStamped: boolean;
}

/*
 * One geometry read per assertion point. Reading it all in a single evaluate
 * keeps the boxes consistent with each other: two round trips could straddle a
 * layout pass and compare rectangles that never coexisted.
 *
 * The selectors are the shipped ones: `data-flows` on .app-shell (App.tsx:636),
 * `data-flow` on every affordance, and `.smithers-composer textarea` rather
 * than a bare `textarea`, which collides with the MarkdownEditor's textarea
 * fallback once the World pane is open.
 */
const SHELL_PROBE = `
(() => {
	const box = (selector) => {
		const node = document.querySelector(selector);
		if (node === null) return null;
		const rect = node.getBoundingClientRect();
		return {
			left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
			width: rect.width, height: rect.height,
		};
	};
	const frame = document.querySelector(".chat-frame");
	const pane = document.querySelector(".embedded-pane");
	const transcript = document.querySelector(".smithers-transcript");
	const textarea = document.querySelector(".smithers-composer textarea");
	const composer = document.querySelector(".smithers-composer");
	const covered = pane === null ? [] : Array.from(pane.querySelectorAll(".surface-header button")).flatMap((button) => {
		const rect = button.getBoundingClientRect();
		const hit = document.elementFromPoint(
			Math.round(rect.left + rect.width / 2),
			Math.round(rect.top + rect.height / 2),
		);
		if (hit !== null && button.contains(hit)) return [];
		const label = button.getAttribute("aria-label") || button.innerText || "button";
		const owner = hit === null ? "nothing" : (hit.closest("[class]") === null ? hit.tagName : hit.closest("[class]").className);
		return [label + " <- " + owner];
	});
	const closeButton = pane === null ? null : pane.querySelector("[data-flow]");
	const shell = document.querySelector(".app-shell");
	return {
		innerWidth: window.innerWidth,
		matchesNarrow: window.matchMedia("(max-width: ${NARROW_MAX_WIDTH}px)").matches,
		pane: frame === null ? "no-frame" : (frame.getAttribute("data-pane") || "none"),
		paneClass: pane === null ? null : pane.className,
		column: box(".chat-column"),
		paneBox: box(".embedded-pane"),
		corner: box(".corner-chrome"),
		transcriptBox: box(".smithers-transcript"),
		composerBox: box(".smithers-composer"),
		headerButtonsCovered: covered,
		transcriptOverflowsX: transcript === null ? false : transcript.scrollWidth > transcript.clientWidth + 1,
		closeFlow: closeButton === null ? null : closeButton.getAttribute("data-flow"),
		registry: (shell === null ? "" : shell.getAttribute("data-flows") || "").split(" ").filter((name) => name.length > 0),
		draft: textarea === null ? null : textarea.value,
		transcriptText: transcript === null ? "" : transcript.innerText,
		transcriptStamped: transcript !== null && transcript.__shellStamp === "transcript",
		composerStamped: composer !== null && composer.__shellStamp === "composer",
		textareaStamped: textarea !== null && textarea.__shellStamp === "textarea",
	};
})()`;

/**
 * The identity stamp. An expando on a DOM node cannot survive an unmount, so a
 * shell that rebuilds the conversation loses it even when the rebuilt markup is
 * byte-identical.
 */
const STAMP = `
(() => {
	const transcript = document.querySelector(".smithers-transcript");
	const composer = document.querySelector(".smithers-composer");
	const textarea = document.querySelector(".smithers-composer textarea");
	if (transcript === null || composer === null || textarea === null) return false;
	transcript.__shellStamp = "transcript";
	composer.__shellStamp = "composer";
	textarea.__shellStamp = "textarea";
	return true;
})()`;

/*
 * The toast recorder. A MutationObserver is the only way to prove a toast NEVER
 * appeared: polling can step over a flash, and the whole point of the 300ms law
 * is that a flash is the defect.
 */
const TOAST_RECORDER = `
(() => {
	window.__shellToasts = [];
	window.__shellStart = performance.now();
	/*
	 * When the balance work settled, on the page's own clock. The fast half of
	 * E9.6 needs to know whether the work actually beat the debounce on THIS
	 * machine rather than assume it: a loaded machine can take the "fast" path
	 * past 300ms, at which point a toast is the law being obeyed, not broken.
	 * Stamped page-side because a CDP read costs a round trip and would inflate
	 * the very number the assertion turns on.
	 */
	window.__balanceSettledAt = null;
	const record = () => {
		if (window.__balanceSettledAt === null && document.querySelector(".smithers-balance-total") !== null) {
			window.__balanceSettledAt = performance.now() - window.__shellStart;
		}
		for (const node of document.querySelectorAll(".toast-stack .toast")) {
			const title = node.querySelector(".toast-title");
			const entry = {
				at: performance.now() - window.__shellStart,
				title: title === null ? "" : title.textContent,
				status: node.getAttribute("data-toast-status"),
			};
			const seen = window.__shellToasts.some((old) => old.title === entry.title && old.status === entry.status);
			if (!seen) window.__shellToasts.push(entry);
		}
	};
	if (window.__shellToastObserver !== undefined) window.__shellToastObserver.disconnect();
	window.__shellToastObserver = new MutationObserver(record);
	window.__shellToastObserver.observe(document.body, { childList: true, subtree: true });
	record();
	return true;
})()`;

interface ToastSighting {
	readonly at: number;
	readonly title: string;
	readonly status: string;
}

/** Read one toast's rendered facts by its title, so a foreign toast is never mistaken for this one. */
const toastByTitle = (title: string): string => `
(() => {
	const nodes = Array.from(document.querySelectorAll(".toast-stack .toast"));
	const node = nodes.find((candidate) => {
		const heading = candidate.querySelector(".toast-title");
		return heading !== null && heading.textContent === ${JSON.stringify(title)};
	});
	if (node === undefined) return null;
	const detail = node.querySelector(".toast-detail");
	const dismiss = node.querySelector('.toast-dismiss[data-flow="toast.dismiss"]');
	return {
		status: node.getAttribute("data-toast-status"),
		role: node.getAttribute("role"),
		detail: detail === null ? null : detail.textContent,
		dismissLabel: dismiss === null ? null : dismiss.getAttribute("aria-label"),
	};
})()`;

interface ToastFacts {
	readonly status: string;
	readonly role: string;
	readonly detail: string | null;
	readonly dismissLabel: string | null;
}

/**
 * A real mouse press at the element's centre, refused when something else owns
 * that point. Clicking through `element.click()` would happily "press" a button
 * a pane header or the corner chrome is covering — exactly the bug E9.5 exists
 * to catch.
 */
const clickAt = async (session: CdpSession, report: Reporter, selector: string, what: string): Promise<void> => {
	const spot = await session.page.evaluate<{
		readonly found: boolean;
		readonly hit: boolean;
		readonly owner: string;
		readonly x: number;
		readonly y: number;
	}>(`
		(() => {
			const node = document.querySelector(${JSON.stringify(selector)});
			if (node === null) return { found: false, hit: false, owner: "", x: 0, y: 0 };
			const rect = node.getBoundingClientRect();
			const x = Math.round(rect.left + rect.width / 2);
			const y = Math.round(rect.top + rect.height / 2);
			const target = document.elementFromPoint(x, y);
			const owner = target === null ? "nothing" : (target.closest("[class]") === null ? target.tagName : target.closest("[class]").className);
			return { found: true, hit: target !== null && node.contains(target), owner: String(owner), x, y };
		})()`);
	report.check(spot.found, `${what}: nothing on the page matched ${selector}`);
	report.check(spot.hit, `${what}: ${selector} is rendered but ${spot.owner} owns its centre point`);
	for (const type of ["mousePressed", "mouseReleased"]) {
		await session.send("Input.dispatchMouseEvent", {
			type,
			x: spot.x,
			y: spot.y,
			button: "left",
			buttons: type === "mousePressed" ? 1 : 0,
			clickCount: 1,
		});
	}
};

/** Open the surfaces dropdown and invoke one of its entries — the only path the shipped UI offers. */
const openSurface = async (session: CdpSession, report: Reporter, flow: "connect" | "world"): Promise<void> => {
	await clickAt(session, report, ".composer-menu-trigger", `opening the surfaces menu for ${flow}`);
	await waitUntil(
		report,
		`the surfaces menu never opened for ${flow}`,
		async () =>
			(await session.page.evaluate<boolean>(
				`document.querySelector('.composer-menu-list[aria-label="Surfaces"] .composer-menu-item[data-flow="${flow}"]') !== null`,
			)) === true,
		5_000,
	);
	await clickAt(
		session,
		report,
		`.composer-menu-list[aria-label="Surfaces"] .composer-menu-item[data-flow="${flow}"]`,
		`invoking the ${flow} entry`,
	);
};

/** What .chat-frame currently says is open. */
const PANE_STATE = `(() => {
	const frame = document.querySelector(".chat-frame");
	return frame === null ? "no-frame" : (frame.getAttribute("data-pane") || "none");
})()`;

/*
 * `.world-surface` and `.connectors-surface` both run
 * `animation: view-in var(--dur-slow)` (chat.css:435,445) whose first frame is
 * `translateY(6px)` (base.css:65-73). A headless target Chrome never paints does
 * not tick that animation at all, so the pane would sit 6px low for the whole
 * run and every geometry read would measure the entrance frame instead of the
 * layout. Finishing the animation explicitly puts the pane exactly where a
 * settled window shows it. The entrance transition is not part of the E9.4/E9.5
 * contract; where the pane comes to rest is.
 */
const SETTLE_PANE = `(() => {
	const pane = document.querySelector(".embedded-pane");
	if (pane === null) return "";
	for (const animation of pane.getAnimations()) {
		try { animation.finish(); } catch { /* an animation without a finite end stays as it is. */ }
	}
	const rect = pane.getBoundingClientRect();
	return JSON.stringify([rect.left, rect.top, rect.right, rect.bottom]);
})()`;

/** Wait until the frame names `expected` and, when it names a pane, until that pane has stopped moving. */
const waitForPane = async (session: CdpSession, report: Reporter, expected: string): Promise<void> => {
	let seen = "never read";
	for (let attempt = 0; attempt < 100; attempt += 1) {
		seen = await session.page.evaluate<string>(PANE_STATE);
		if (seen === expected) break;
		await wait(100);
	}
	if (seen !== expected) {
		report.fail(`.chat-frame never settled at data-pane="${expected}" — it stayed at "${seen}"`);
	}
	if (expected === "none") return;
	let previous = "";
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const rect = await session.page.evaluate<string>(SETTLE_PANE);
		if (rect !== "" && rect === previous) return;
		previous = rect;
		await wait(100);
	}
	report.fail(`the ${expected} pane's box never stopped moving (last read ${previous})`);
};

/** Both rectangles are separated on at least one axis: they cannot overlay each other. */
const disjoint = (a: Box, b: Box): boolean =>
	a.right <= b.left + EPS || a.left >= b.right - EPS || a.bottom <= b.top + EPS || a.top >= b.bottom - EPS;

const beside = (pane: Box, column: Box): boolean =>
	pane.left >= column.right - EPS && Math.abs(pane.top - column.top) <= EPS;

const under = (pane: Box, column: Box): boolean =>
	pane.top >= column.bottom - EPS &&
	Math.abs(pane.left - column.left) <= EPS &&
	Math.abs(pane.right - column.right) <= EPS;

export default defineSuite({
	id: "E9",
	title: "the chat shell embeds panes without unmounting the conversation, lays them out responsively, and obeys the toast law",
	browser: true,
	order: 20,
	run: async ({ stack, report, browser }) => {
		const cookie = await stack.signedInCookie();
		const session = await browser.open(cookie);
		const page = session.page;
		const evaluate = page.evaluate;

		// -------------------------------------------------------------------
		// Setup: an allowlisted, signed-in composer. A signed-out send appends
		// only the sign-in reply, so E9.2 would have nothing to survive.
		// -------------------------------------------------------------------
		await waitUntil(
			report,
			"the composer never mounted",
			async () => (await evaluate<boolean>(`document.querySelector(".smithers-composer textarea") !== null`)) === true,
			30_000,
		);
		await waitUntil(
			report,
			"the composer never reached the signed-in, allowlisted state",
			async () =>
				(await evaluate<string | null>(
					`(document.querySelector(".smithers-composer textarea") || {}).placeholder || null`,
				)) === READY_PLACEHOLDER,
			30_000,
		);
		report.ok("the shell booted signed in and allowlisted, with the composer ready.");

		// -------------------------------------------------------------------
		// E9.1/E9.2/E9.3 — send a message, leave a draft, stamp the live nodes.
		// -------------------------------------------------------------------
		report.equals(await evaluate<boolean>(FOCUS_COMPOSER), true, "the composer never took focus");
		report.equals(
			await evaluate<boolean>(`document.activeElement.closest(".smithers-composer") !== null`),
			true,
			"the focused textarea is not the chat composer",
		);
		await session.send("Input.insertText", { text: MESSAGE });
		await page.press("Enter");
		await waitUntil(
			report,
			"the sent message never reached the transcript",
			async () =>
				(await evaluate<boolean>(
					`(document.querySelector(".smithers-transcript") || { innerText: "" }).innerText.includes(${JSON.stringify(MESSAGE)})`,
				)) === true,
			20_000,
		);

		report.equals(await evaluate<boolean>(FOCUS_COMPOSER), true, "the composer never took focus for the draft");
		await session.send("Input.insertText", { text: DRAFT });
		await waitUntil(
			report,
			"the draft never landed in the composer",
			async () =>
				(await evaluate<string | null>(
					`(document.querySelector(".smithers-composer textarea") || {}).value ?? null`,
				)) === DRAFT,
			5_000,
		);
		report.equals(await evaluate<boolean>(STAMP), true, "the stamp did not land on the transcript, composer and textarea");
		report.ok("a message is in the transcript, a draft is in the composer, and both live nodes carry an identity stamp.");

		let expectedDraft = DRAFT;

		const requireShell = async (label: string, expectedPane: "none" | "world" | "connectors"): Promise<ShellProbe> => {
			const shell = await evaluate<ShellProbe>(SHELL_PROBE);
			report.check(
				shell.transcriptBox !== null && shell.transcriptBox.width > 0 && shell.transcriptBox.height > 0,
				`${label}: the transcript is not on screen`,
			);
			report.check(
				shell.composerBox !== null && shell.composerBox.height > 0,
				`${label}: the composer is not on screen`,
			);
			report.check(shell.transcriptStamped, `${label}: the transcript node was unmounted and rebuilt`);
			report.check(shell.composerStamped, `${label}: the composer node was unmounted and rebuilt`);
			report.check(shell.textareaStamped, `${label}: the composer input was unmounted and rebuilt`);
			report.equals(shell.pane, expectedPane, `${label}: .chat-frame data-pane`);
			report.includes(shell.transcriptText, MESSAGE, `${label}: the sent message left the transcript`);
			report.equals(shell.draft, expectedDraft, `${label}: the composer draft changed`);
			report.equals(shell.transcriptOverflowsX, false, `${label}: the chat column scrolls horizontally`);
			if (expectedPane === "none") {
				report.check(shell.paneBox === null, `${label}: a pane is still on screen`);
			} else {
				report.check(
					shell.paneBox !== null && shell.paneBox.width > 0 && shell.paneBox.height > 0,
					`${label}: the pane did not open`,
				);
				report.equals(shell.closeFlow, "chat", `${label}: the pane's close affordance names the wrong flow`);
				report.equals(
					shell.headerButtonsCovered.length,
					0,
					`${label}: pane chrome is covered and unclickable: ${shell.headerButtonsCovered.join(", ")}`,
				);
				report.check(shell.registry.includes("chat"), `${label}: chat is missing from the live data-flows registry`);
			}
			return shell;
		};

		await requireShell("chat only", "none");
		report.ok("E9.1: with no pane open the conversation is the whole surface.");

		await openSurface(session, report, "connect");
		await waitForPane(session, report, "connectors");
		const connectors = await requireShell("Connectors open", "connectors");
		report.includes(String(connectors.paneClass), "connectors-surface", "the pane is not the connectors surface");
		report.ok("E9.1: Connectors opens as an embedded pane and the transcript, composer and textarea keep their identity.");

		await clickAt(session, report, '.embedded-pane [data-flow="chat"]', "closing the Connectors pane");
		await waitForPane(session, report, "none");
		await requireShell("Connectors closed", "none");
		report.ok("E9.3: back-to-conversation closes Connectors without unmounting a single chat node.");

		await openSurface(session, report, "world");
		await waitForPane(session, report, "world");
		const world = await requireShell("World open", "world");
		report.includes(String(world.paneClass), "world-surface", "the pane is not the world surface");
		report.ok("E9.1: World opens as an embedded pane beside the same, still-mounted conversation.");

		await clickAt(session, report, '.embedded-pane [data-flow="chat"]', "closing the World pane");
		await waitForPane(session, report, "none");
		const closed = await requireShell("World closed", "none");
		report.includes(closed.transcriptText, MESSAGE, "the sent message did not survive both pane round trips");
		report.equals(closed.draft, DRAFT, "the draft did not survive both pane round trips");
		report.ok("E9.2: the sent message and the unsent draft survived four pane transitions unchanged.");

		// -------------------------------------------------------------------
		// E9.4/E9.5 — the responsive contract, measured, not assumed.
		// -------------------------------------------------------------------
		const setViewport = async (width: number): Promise<void> => {
			await session.send("Emulation.setDeviceMetricsOverride", {
				width,
				height: 900,
				deviceScaleFactor: 1,
				mobile: false,
			});
			// The resize observer and one layout pass; measuring mid-reflow is the
			// classic source of geometry flake.
			await wait(400);
		};

		await setViewport(1400);
		const baseline = await requireShell("1400px, chat alone", "none");
		report.check(baseline.column !== null && baseline.corner !== null, "the chat column or corner chrome is missing");
		const baseColumn = baseline.column as Box;
		const baseCorner = baseline.corner as Box;
		report.check(
			baseCorner.right <= baseColumn.right + EPS && baseCorner.top >= baseColumn.top - EPS,
			"with the chat alone the corner chrome is not anchored in the chat column's top-right corner",
		);
		report.ok("E9.5: with no pane open the chat chrome sits in the chat column's own top-right corner.");

		for (const width of [1400, 901, 900, 700]) {
			await setViewport(width);
			for (const [flow, pane, label] of [
				["connect", "connectors", "Connectors"],
				["world", "world", "World"],
			] as const) {
				await openSurface(session, report, flow);
				await waitForPane(session, report, pane);
				const shell = await requireShell(`${width}px with ${label} open`, pane);
				const narrow = shell.innerWidth <= NARROW_MAX_WIDTH;
				report.equals(
					shell.matchesNarrow,
					narrow,
					`${width}px: the (max-width: ${NARROW_MAX_WIDTH}px) query disagrees with window.innerWidth ${shell.innerWidth}`,
				);
				report.check(shell.column !== null && shell.paneBox !== null && shell.corner !== null, `${width}px: a measured box is missing`);
				const column = shell.column as Box;
				const paneBox = shell.paneBox as Box;
				const corner = shell.corner as Box;
				const transcriptBox = shell.transcriptBox as Box;
				const composerBox = shell.composerBox as Box;
				report.check(
					narrow ? under(paneBox, column) : beside(paneBox, column),
					`${width}px: the ${label} pane does not sit ${narrow ? "under" : "beside"} the conversation ` +
						`(column ${JSON.stringify(column)}, pane ${JSON.stringify(paneBox)})`,
				);
				report.check(disjoint(paneBox, column), `${width}px: the ${label} pane overlays the conversation column`);
				report.check(disjoint(paneBox, transcriptBox), `${width}px: the ${label} pane overlays the transcript`);
				report.check(disjoint(paneBox, composerBox), `${width}px: the ${label} pane overlays the composer`);
				report.check(
					corner.left >= column.left - EPS &&
						corner.right <= column.right + EPS &&
						corner.top >= column.top - EPS &&
						corner.bottom <= column.bottom + EPS,
					`${width}px: the chat chrome escaped the chat column with the ${label} pane open ` +
						`(corner ${JSON.stringify(corner)}, column ${JSON.stringify(column)})`,
				);
				report.check(disjoint(corner, paneBox), `${width}px: the chat chrome covers the ${label} pane`);
				await clickAt(session, report, '.embedded-pane [data-flow="chat"]', `closing ${label} at ${width}px`);
				await waitForPane(session, report, "none");
			}
			report.ok(
				`E9.4/E9.5: at ${width}px both panes sit ${width <= NARROW_MAX_WIDTH ? "under" : "beside"} the conversation, ` +
					"overlay nothing, and leave every pane header button hit-testable.",
			);
		}

		await session.send("Emulation.clearDeviceMetricsOverride");
		await wait(400);

		// The conversation still works after every transition and every resize.
		report.equals(await evaluate<boolean>(FOCUS_COMPOSER), true, "the composer never took focus for the second send");
		await page.press("Enter");
		await waitUntil(
			report,
			"the draft left in the composer never sent as a real turn",
			async () =>
				(await evaluate<boolean>(
					`(document.querySelector(".smithers-transcript") || { innerText: "" }).innerText.includes(${JSON.stringify(DRAFT)})`,
				)) === true,
			20_000,
		);
		expectedDraft = "";
		const afterSend = await requireShell("after the second send", "none");
		report.equals(afterSend.draft, "", "the composer did not clear after sending");
		report.includes(afterSend.transcriptText, MESSAGE, "the first message did not survive the second send");
		report.ok("E9.3: the composer that survived every pane and every width still sends a real turn.");

		// -------------------------------------------------------------------
		// E9.6 — the 300ms toast law.
		// -------------------------------------------------------------------
		await waitUntil(
			report,
			"the balance chip never rendered, so no toast driver is reachable",
			async () => (await evaluate<boolean>(`document.querySelector(".corner-balance-chip") !== null`)) === true,
			20_000,
		);

		/*
		 * Fast work: the local billing double answers in single-digit
		 * milliseconds, so the debounce is normally never reached.
		 *
		 * "Normally" is why this reads the page's own settle stamp instead of
		 * assuming it. Under load the click-to-render round trip can cross
		 * 300ms, and then a toast is the 300ms law being OBEYED. Asserting a
		 * bare "no toast" made this suite fail for a product that was correct —
		 * observed at 308ms. The law is an if-and-only-if, so both directions
		 * are asserted from the measured time and neither can flake.
		 */
		report.equals(await evaluate<boolean>(TOAST_RECORDER), true, "the toast recorder did not install");
		await clickAt(session, report, ".corner-balance-chip", "asking for the balance (fast)");
		await waitUntil(
			report,
			"the fast balance read never produced a balance card, so 'no toast' would prove nothing",
			async () => (await evaluate<boolean>(`document.querySelector(".smithers-balance-total") !== null`)) === true,
			20_000,
		);
		await wait(TOAST_DEBOUNCE_MS * 4);
		const quiet = await evaluate<ReadonlyArray<ToastSighting>>("window.__shellToasts");
		const flashed = quiet.filter((sighting) => sighting.title === RUNNING_TITLE);
		const settledAt = await evaluate<number | null>("window.__balanceSettledAt");
		report.check(settledAt !== null, "the fast balance read never stamped a settle time, so neither direction is provable");
		const settled = Math.round(settledAt as number);
		if ((settledAt as number) < TOAST_DEBOUNCE_MS) {
			report.equals(
				flashed.length,
				0,
				`balance work that settled in ${settled}ms, under the ${TOAST_DEBOUNCE_MS}ms debounce, still flashed a toast: ${JSON.stringify(flashed)}`,
			);
			report.ok(`E9.6: balance work that settles under ${TOAST_DEBOUNCE_MS}ms (${settled}ms) completes without ever flashing a toast.`);
		} else {
			report.check(
				flashed.length > 0,
				`balance work took ${settled}ms, past the ${TOAST_DEBOUNCE_MS}ms debounce, and never stated what was running`,
			);
			report.ok(
				`E9.6: this machine took ${settled}ms on the fast path, past the ${TOAST_DEBOUNCE_MS}ms debounce, ` +
					`so the law requires the toast it showed. The under-budget direction is proved by the slow half below.`,
			);
		}

		// Slow work: the same flow, delayed at the billing front, must state what
		// is running — and must wait out the debounce before it does.
		stack.fronts.billing.delay("/api/billing/balance", 3_000);
		report.equals(await evaluate<boolean>(TOAST_RECORDER), true, "the toast recorder did not reinstall");
		await clickAt(session, report, ".corner-balance-chip", "asking for the balance (slow)");
		await waitUntil(
			report,
			"slow balance work never stated that it was running",
			async () =>
				(await evaluate<boolean>(
					`document.querySelector('.toast-stack .toast[data-toast-status="running"]') !== null`,
				)) === true,
			5_000,
		);
		const sightings = await evaluate<ReadonlyArray<ToastSighting>>("window.__shellToasts");
		const running = sightings.find((sighting) => sighting.title === RUNNING_TITLE && sighting.status === "running");
		report.check(running !== undefined, `no running balance toast was recorded: ${JSON.stringify(sightings)}`);
		const firedAt = (running as ToastSighting).at;
		/*
		 * The floor is 250ms, not 300ms: the recorder's clock starts one CDP round
		 * trip before the click, so the measured delay is if anything longer than
		 * the real debounce. 50ms of slack is well inside the law and still turns
		 * red the moment the debounce is removed (a debounce-free toast fires in
		 * single-digit milliseconds). The ceiling only excludes "the toast appeared
		 * after the work settled": the work takes 3000ms, so anything under that
		 * proves the notice arrived while it was still running. 2000ms leaves room
		 * for a loaded machine (observed 305ms, 318ms and 494ms on this one) without
		 * ever admitting a post-settlement toast.
		 */
		report.check(firedAt >= 250, `the running toast fired at ${Math.round(firedAt)}ms, before the ${TOAST_DEBOUNCE_MS}ms debounce`);
		report.check(firedAt <= 2_000, `the running toast fired at ${Math.round(firedAt)}ms, after the work it names had settled`);
		const runningFacts = await evaluate<ToastFacts | null>(toastByTitle(RUNNING_TITLE));
		report.check(runningFacts !== null, "the running toast is not on screen under its own title");
		report.equals((runningFacts as ToastFacts).status, "running", "the running toast's status");
		report.equals((runningFacts as ToastFacts).role, "status", "a running toast must be a calm status note, never an alert");
		report.equals((runningFacts as ToastFacts).dismissLabel, null, "a running toast must carry no dismiss affordance");
		report.ok(
			`E9.6: work over ${TOAST_DEBOUNCE_MS}ms states what is running ("${RUNNING_TITLE}") as a status note, ` +
				`after waiting out the debounce (${Math.round(firedAt)}ms).`,
		);

		await waitUntil(
			report,
			"the settled balance toast never stated its result",
			async () => (await evaluate<ToastFacts | null>(toastByTitle(DONE_TITLE))) !== null,
			10_000,
		);
		const doneFacts = (await evaluate<ToastFacts>(toastByTitle(DONE_TITLE))) as ToastFacts;
		report.equals(doneFacts.status, "ok", "the settled toast's status");
		report.equals(doneFacts.dismissLabel, null, "an ok toast must clear itself, so it carries no dismiss affordance");
		report.equals(
			await evaluate<ToastFacts | null>(toastByTitle(RUNNING_TITLE)),
			null,
			"the settled toast still states the running sentence instead of its result",
		);
		await waitUntil(
			report,
			`the ok toast never dismissed itself within ${TOAST_AUTO_DISMISS_MS}ms`,
			async () => (await evaluate<ToastFacts | null>(toastByTitle(DONE_TITLE))) === null,
			TOAST_AUTO_DISMISS_MS * 3,
		);
		stack.fronts.billing.delay("/api/billing/balance", 0);
		report.ok(`E9.6: the settled toast states "${DONE_TITLE}" and dismisses itself.`);

		// -------------------------------------------------------------------
		// E9.7 — a failure toast stays until the user dismisses it.
		// -------------------------------------------------------------------
		const balanceCalls = (): number =>
			stack.fronts.billing.requests().filter((entry) => entry.path === "/api/billing/balance").length;
		const callsBefore = balanceCalls();
		const chipBefore = await evaluate<string | null>(
			`(document.querySelector(".corner-balance-chip") || {}).textContent ?? null`,
		);
		report.check(
			chipBefore !== null && chipBefore.length > 0,
			"the balance chip states nothing before the failing read, so 'unchanged' would prove nothing",
		);
		stack.fronts.billing.delay("/api/billing/balance", 1_000);
		stack.fronts.billing.failOnce("GET", "/api/billing/balance", 503);
		await clickAt(session, report, ".corner-balance-chip", "asking for the balance (failing)");
		await waitUntil(
			report,
			"the failed balance read never surfaced a failure toast",
			async () => {
				const facts = await evaluate<ToastFacts | null>(toastByTitle(RUNNING_TITLE));
				return facts !== null && facts.status === "failed";
			},
			10_000,
		);
		const failure = (await evaluate<ToastFacts>(toastByTitle(RUNNING_TITLE))) as ToastFacts;
		report.equals(failure.role, "alert", "a failed toast must be an assertive error landmark");
		report.equals(failure.detail, FAILED_DETAIL, "the failed toast does not carry the honest line");
		report.equals(
			failure.dismissLabel,
			`Dismiss: ${RUNNING_TITLE}`,
			"the failed toast's dismiss affordance does not name what it dismisses",
		);
		report.equals(
			balanceCalls(),
			callsBefore + 1,
			"the failing read never reached the billing seam, so the failure toast proves nothing",
		);
		/*
		 * AppStore.ts:1158-1166: a balance that has loaded once stays honest-but-stale
		 * when a refresh fails — only an account that never loaded reads "unavailable".
		 * So the rule under test is that a failed refresh neither invents a new number
		 * nor blanks the chip.
		 */
		report.equals(
			await evaluate<string | null>(
				`(document.querySelector(".corner-balance-chip") || {}).textContent ?? null`,
			),
			chipBefore,
			"a failed refresh changed the balance the chip states",
		);
		stack.fronts.billing.delay("/api/billing/balance", 0);

		// The whole claim: it outlives the auto-dismiss window by a wide margin.
		await wait(TOAST_AUTO_DISMISS_MS * 1.5);
		const survived = await evaluate<ToastFacts | null>(toastByTitle(RUNNING_TITLE));
		report.check(
			survived !== null && survived.status === "failed",
			`the failure toast vanished on its own within ${TOAST_AUTO_DISMISS_MS * 1.5}ms`,
		);
		await clickAt(
			session,
			report,
			'.toast-stack .toast .toast-dismiss[data-flow="toast.dismiss"]',
			"dismissing the failure toast",
		);
		await waitUntil(
			report,
			"the failure toast did not leave when the user dismissed it",
			async () => (await evaluate<ToastFacts | null>(toastByTitle(RUNNING_TITLE))) === null,
			5_000,
		);
		report.ok(
			"E9.7: the failure toast keeps the attempt's title, states the honest line as an alert, outlives the " +
				"auto-dismiss window, and leaves only through the registered toast.dismiss affordance.",
		);

		session.close();
	},
});
