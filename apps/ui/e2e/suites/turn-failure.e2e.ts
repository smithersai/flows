/*
 * Turn lifecycle — failure, retry, interruption, the stop budget, and restore.
 *
 * Rows E3.9, E3.10, E3.11, E3.5 and E3.6 of apps/E2E-CANARY-CHECKLIST.md.
 *
 * Every assertion here is grounded in a product string or a store field, never
 * in what the chat double was told to say. The double supplies the *shape* of a
 * turn (a partial delta then an error, a stream that never ends); what is
 * asserted is what the product does with it — the reducer the frame lands in,
 * the bubble it keeps, the note it renders, the request it re-POSTs.
 *
 * Two altitudes, deliberately:
 *
 *  - the store altitude runs always, over the real AppStore/AppController/
 *    WebAgent against wrangler dev;
 *  - the page altitude runs when the machine has a Chrome, because the key
 *    binding (E3.5), the reload (E3.6) and the retry button (E3.10) are the
 *    rows themselves and no store call can stand in for them.
 *
 * `browser` stays false on purpose: a machine with no Chrome must still run the
 * store altitude rather than skip all five rows, so the page half is guarded
 * inside `run` instead of by the runner's suite-level skip. That guard skips on
 * exactly one condition — this machine has no Chrome, which is the only thing
 * `browser.openIfAvailable` answers with undefined. A browser that exists and
 * then misbehaves throws, and a throw fails the suite, so a crashed or
 * unreachable Chrome can never delete the page half silently.
 *
 * Every page call this suite makes goes through `bounded()`. waitUntil and
 * waitForText bound how long they poll, not how long one read takes, so a
 * DevTools call that never answers parks the poll forever; this suite's browser
 * half once held the whole runner for 25 minutes that way with no output.
 */
import { defineSuite } from "../Suite.ts";
import { NO_NATIVE_REPOSITORIES, openClient } from "../Client.ts";
import { wait, waitUntil, type Reporter } from "../Assert.ts";
import type { ChatRequest } from "../ChatUpstream.ts";
import type { CdpSession } from "../Browser.ts";
import type { StorageApi } from "@tanstack/db";
import type { FetchLike } from "smithers-shared/NativeAgent";
import { STOP_BUDGET_MS, sendPrompt, waitForText } from "../../src/launch-checklist/Probes.ts";
import type { ProbePage } from "../../src/launch-checklist/Types.ts";
import { createAppController, type AppController } from "../../src/mainview/state/AppController.ts";
import { createAppStore, type AppStore } from "../../src/mainview/state/AppStore.ts";
import type { Message } from "../../src/mainview/state/AppState.ts";
import { createAgentSeat, createChainRuntime } from "../../src/mainview/chain/ChainRuntime.ts";
import {
	PERSISTED_KEY_PREFIX,
	PERSISTENCE_BACKEND_STORAGE_KEY,
	SCHEMA_VERSION_STORAGE_KEY,
} from "../../src/mainview/chain/SchemaVersion.ts";

/** Nothing here may read as an impossible ask (RunClaims.ASK_PATTERNS), or the answer is held. */
const PROMPT = "summarize the release notes";
const RESTORE_PROMPT = "walk me through the restore path";
const SLOW_PROMPT = "count slowly";

/** What the model streamed before the provider died — the partial that must survive. */
const WARM_PARTIAL = "Working on it… ";
const PROVIDER_ERROR = "The model provider dropped the connection.";
const RETRY_REPLY = "Second time lucky — here is the summary.";

/** AppStore.ts:508-530, the no-bubble-yet branch of message.response.failed. */
const COLD_BUBBLE = `I couldn't complete that turn. ${PROVIDER_ERROR}`;
/** AppController.ts:2299 — a stream that says nothing is a named failure, never a silent completion. */
const EMPTY_BUBBLE = "I couldn't complete that turn. Smithers Cloud returned an empty response.";

/** AppController.stop() (:3851) and the AppStore.ts:534 default. */
const STOP_DETAIL = "Stopped the current response.";
/** AppStore.ts:586 — what boot reconciliation says about the turn the app closed on. */
const ORPHAN_DETAIL = "That turn was interrupted when the app closed.";

/** App.tsx:52-55 renders the note as `<label> — <statusDetail>`; the dash is U+2014. */
const NOTE_LABEL = "Turn interrupted";
const STOP_NOTE = `${NOTE_LABEL} — ${STOP_DETAIL}`;
const ORPHAN_NOTE = `${NOTE_LABEL} — ${ORPHAN_DETAIL}`;

/** ChatComposer.tsx:108-110 — "submitted" while the turn runs, "ready" when it does not. */
const COMPOSER_STATUS = `document.querySelector('[data-slot="chat-composer"]')?.getAttribute("data-status") ?? ""`;
const COMPOSER_MOUNTED = `document.querySelector("textarea") !== null`;
/**
 * What the app has actually written to disk, by either backend: the OPFS files
 * wa-sqlite keeps and the localStorage keys the fallback writes. A reopen that
 * restores nothing means one of two very different things — the bytes were
 * never written, or they were written and ignored — and only this tells them
 * apart.
 */
const PERSISTED_EVIDENCE = `(async () => {
	const local = Object.keys(localStorage).filter((key) => key.startsWith("smithers-mvp."));
	const opfs = [];
	try {
		const root = await navigator.storage.getDirectory();
		for await (const [name, handle] of root.entries()) {
			if (handle.kind !== "file") continue;
			try {
				const file = await handle.getFile();
				opfs.push(name + ":" + file.size);
			} catch {
				opfs.push(name + ":locked");
			}
		}
	} catch {
		opfs.push("unavailable");
	}
	return { local, opfs };
})()`;

/** App.tsx:827-838 — rendered only beside a message whose status is "failed". */
const RETRY_BUTTON = `document.querySelector('[aria-label="Retry turn"]') !== null`;
const CLICK_RETRY = `(() => {
	const button = document.querySelector('[aria-label="Retry turn"]');
	if (button === null) return false;
	button.click();
	return true;
})()`;

/**
 * A turn that streams two deltas and then keeps the socket open without ever
 * ending: exactly the state an app is in when the user closes it mid-turn.
 * `call.started` is journal evidence the client ignores (AppController.ts:2181),
 * so the transcript stops growing while the session stays "responding" — the
 * restore rows can then read a stable partial instead of racing the stream.
 */
/*
 * A turn caught MID-FLIGHT, on the chain wire: link 1 says the partial the
 * reload must restore and asks for its successor; the successor's author
 * stream then idles on keepalive frames for a minute, holding the turn open
 * with the partial on screen and the session persisted as responding.
 */
const MID_TURN_SCRIPT = [
	{
		raw: true,
		frames: [
			{
				type: "delta",
				kind: "text",
				text: [
					"```flow",
					'await ctx.call("say", { text: "chunk 0 chunk 1 " })',
					'return to(await ctx.call("author", { context: ["continue"] }))',
					"```",
				].join("\n"),
			},
			{ type: "done", reason: "stop" },
		],
	},
	{
		raw: true,
		gapMs: 250,
		frames: Array.from({ length: 240 }, (_unused, index) => ({
			type: "call.started",
			link: 0,
			ordinal: index,
			name: "sys/e2e-keepalive",
		})),
	},
];

const ordered = (store: AppStore): ReadonlyArray<Message> =>
	[...store.collections.messages.values()].sort((left, right) => left.ordinal - right.ordinal);

/** The turn the last user message opened. Its response lives at `message-<turnId>-smithers`. */
const lastTurnId = (store: AppStore, report: Reporter): string => {
	const user = ordered(store).filter((message) => message.role === "user").at(-1);
	const turnId = user?.id.match(/^message-(.+)-user$/)?.[1];
	if (turnId === undefined) report.fail(`no user message carried a turn id (saw ${user?.id ?? "nothing"})`);
	return turnId;
};

const responseOf = (store: AppStore, turnId: string): Message | undefined =>
	store.collections.messages.get(`message-${turnId}-smithers`);

/** The last user prompt the Worker forwarded upstream on a given turn. */
const lastUserContent = (request: ChatRequest | undefined): string =>
	String([...(request?.messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? "");

/** handleTurn stamps the client's runId on the upstream call (apps/server/src/index.ts:535). */
const forwardedRunId = (request: ChatRequest | undefined): string =>
	request?.headers["x-smithers-run-id"] ?? "";

/**
 * The upstream call a given turn made. Turns are matched by the id the Worker
 * stamped, never by position: the double records every turn the stack sees, and
 * an assertion keyed on "the first one" would break on traffic that is not this
 * assertion's.
 */
/** Every turn the double saw, for a failure that explains itself. */
const describeTurns = (requests: ReadonlyArray<ChatRequest>): string =>
	requests.map((request) => `${forwardedRunId(request)}=${lastUserContent(request)}`).join(" | ") || "none";

/** True when wa-sqlite has a database with rows in it, rather than an empty pool file. */
const hasSqliteData = (evidence: PersistedEvidence): boolean =>
	evidence.opfs.some((entry) => !entry.endsWith(":0") && !entry.endsWith(":locked") && entry !== "unavailable");

/**
 * The store's own bookkeeping, which both backends write to localStorage: the
 * schema stamp and the backend stamp. Neither is conversation data, so neither
 * is evidence that the fallback backend holds anything, and counting them as
 * data would make an OPFS launch look like a localStorage one.
 */
const BOOKKEEPING: ReadonlySet<string> = new Set([SCHEMA_VERSION_STORAGE_KEY, PERSISTENCE_BACKEND_STORAGE_KEY]);

/** The localStorage keys that are the fallback backend's actual store. */
const localData = (evidence: PersistedEvidence): ReadonlyArray<string> =>
	evidence.local.filter((key) => !BOOKKEEPING.has(key));

/** The two stores AppStore can choose between. A launch writes to exactly one. */
type Backend = "OPFS" | "localStorage";

/**
 * The backend the second launch wrote to, when it is not the one the first
 * launch wrote to. Undefined when both launches agreed.
 *
 * AppStore opens OPFS first and falls back to localStorage whenever that open
 * throws (AppStore.ts:99-147), and it never reads the backend it did not
 * choose. The flip is detected by a store that was empty when the app closed
 * and holds data after the reopen, which names it in either direction: the
 * first launch's own bytes stay on disk when the second launch ignores them,
 * so "which store has data now" alone cannot tell the two directions apart.
 */
const flippedBackend = (written: PersistedEvidence, kept: PersistedEvidence): Backend | undefined => {
	if (localData(written).length > 0 && !hasSqliteData(written) && hasSqliteData(kept)) return "OPFS";
	if (hasSqliteData(written) && localData(written).length === 0 && localData(kept).length > 0) return "localStorage";
	return undefined;
};

/**
 * Why the reopened app came back empty, in the product's own terms, including
 * what the returning user loses when the backend flips.
 */
const lostReason = (written: PersistedEvidence, kept: PersistedEvidence): string => {
	const flipped = flippedBackend(written, kept);
	if (flipped === undefined) return "the reopened page did not restore both the prompt and the in-flight partial";
	const first: Backend = flipped === "OPFS" ? "localStorage" : "OPFS";
	return (
		`the reopened app switched persistence backends between launches: the mid-turn conversation was written to ${first} ` +
		`and the reopened app read a fresh ${flipped} store instead. What a returning user loses is every conversation they ` +
		`have ever had. The transcript, the prompt they were waiting on, and the partial answer are all still on disk in ` +
		`${first}, and the app greets them with the first-run welcome as though they had never used it. The flip runs both ` +
		`ways, so the loss is not a one-off: the next launch can flip back and orphan whatever this one wrote`
	);
};

interface PersistedEvidence {
	/** smithers-mvp.* keys in localStorage — the fallback backend's whole store. */
	readonly local: ReadonlyArray<string>;
	/** OPFS file names with their byte sizes — wa-sqlite's access-handle pool. */
	readonly opfs: ReadonlyArray<string>;
}

const composerStatus = (page: ProbePage): Promise<string> => page.evaluate<string>(COMPOSER_STATUS);

/**
 * How many times `needle` appears in `haystack`.
 *
 * The page keeps every earlier turn in one transcript, so "the text contains X"
 * is satisfied by a section that ran minutes ago. Counting is how a wait proves
 * the turn under test produced something, rather than reading a neighbour's.
 */
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/**
 * One whole page operation, however many DevTools calls it takes. Looser than
 * Browser.ts's per-call CDP timeout on purpose, so a single stuck call fails
 * with that file's message, naming the method, and this bound only catches an
 * operation that overruns in aggregate.
 */
const PAGE_CALL_MS = 45_000;
/** A reload navigates and then polls for readyState, so it gets a larger bound. */
const RELOAD_MS = 90_000;

/**
 * Run `work` with a deadline, and name what was being waited for when it blows.
 *
 * The deadline does not cancel the DevTools call it is racing; it releases this
 * suite so the failure is reported and the run continues. A rejection from
 * `work` itself passes through untouched, so a BrowserUnavailableError still
 * reaches the skip guard.
 */
const withDeadline = async <T>(what: string, budgetMs: number, work: () => Promise<T>): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out after ${budgetMs}ms waiting for ${what}`)), budgetMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};

/**
 * The same page, with a deadline on every operation it performs.
 *
 * Browser.ts bounds one DevTools call. It does not bound an operation built
 * from many: `type` sends two events per character and `reload` polls
 * readyState up to eighty times, so a page that answers every call slowly still
 * outlives any per-call timeout. waitUntil and waitForText do not close that
 * gap either — they check their deadline between reads, never during one, so a
 * slow read parks the poll for as long as the runner will wait. That is how
 * this suite once held the whole run for 25 minutes in silence.
 */
const bounded = (page: ProbePage): ProbePage => ({
	text: () => withDeadline("the page to report its text", PAGE_CALL_MS, () => page.text()),
	evaluate: <T,>(expression: string): Promise<T> =>
		withDeadline(
			`the page to evaluate ${JSON.stringify(expression.slice(0, 60))}`,
			PAGE_CALL_MS,
			() => page.evaluate<T>(expression),
		),
	type: (value: string) =>
		withDeadline(`the page to accept the typed ${JSON.stringify(value.slice(0, 40))}`, PAGE_CALL_MS, () =>
			page.type(value),
		),
	press: (key: string) => withDeadline(`the page to accept the ${key} key press`, PAGE_CALL_MS, () => page.press(key)),
	reload: () => withDeadline("the app to load after a navigation", RELOAD_MS, () => page.reload()),
});

/**
 * Close the app and open it again, which is what the row asks for. The app is
 * unloaded to about:blank first so its OPFS worker releases the wa-sqlite
 * access handles before the next document opens the database.
 *
 * A bare reload overlaps the two documents. The incoming one can then fail to
 * acquire the access-handle pool, fall back to an empty localStorage store, and
 * render the first-run welcome in place of the conversation — silent loss on a
 * reload race. That is its own defect, reported separately; it is not what E3.6
 * is about, and letting it land here would make this row flaky rather than
 * informative.
 */
const reopenApp = async (session: CdpSession, page: ProbePage): Promise<void> => {
	await withDeadline("the tab to unload to about:blank", PAGE_CALL_MS, () =>
		session.send("Page.navigate", { url: "about:blank" }),
	);
	await wait(2_000);
	await page.reload();
};

/** Wait for the composer to mount; Page.navigate resolves before React does. */
const awaitComposer = async (report: Reporter, page: ProbePage): Promise<void> => {
	await waitUntil(
		report,
		"the composer textarea never mounted in the page",
		async () => (await page.evaluate<boolean>(COMPOSER_MOUNTED)) === true,
		30_000,
	);
};

export default defineSuite({
	id: "E3.9",
	title: "a failed turn says so and offers retry, an interrupted turn keeps its partial, Escape stops inside the budget, and a reopened app describes the turn it lost",
	run: async ({ origin, stack, report, browser }) => {
		const cookie = await stack.signedInCookie();

		// ---------------------------------------------------------------- E3.9a
		// A failure AFTER the model has spoken keeps the partial and stamps the
		// turn failed. Red when the reducer starts discarding streamed text, when
		// the upstream error stops reaching statusDetail, or when a dead turn
		// leaves the composer stuck in "responding".
		stack.chat.reset();
		stack.chat.script([
			// Chain staging: the partial exists once say() landed; the successor
			// link's author call is the one the provider kills.
			{
				raw: true,
				frames: [
					{
						type: "delta",
						kind: "text",
						text: [
							"```flow",
							`await ctx.call("say", { text: ${JSON.stringify(WARM_PARTIAL)} })`,
							'return to(await ctx.call("author", { context: ["continue"] }))',
							"```",
						].join("\n"),
					},
					{ type: "done", reason: "stop" },
				],
			},
			{ raw: true, frames: [{ type: "done", error: PROVIDER_ERROR }] },
		]);
		const warm = await openClient({ origin, cookie });
		await warm.controller.loadSession();
		warm.controller.runCommandArgs("send", PROMPT);
		await warm.settle(
			"the warm failure never marked the turn failed",
			() => responseOf(warm.store, lastTurnId(warm.store, report))?.status === "failed",
		);
		const warmTurnId = lastTurnId(warm.store, report);
		const warmBubble = responseOf(warm.store, warmTurnId);
		report.equals(warmBubble?.text, WARM_PARTIAL, "the failed turn did not keep the text it had streamed");
		report.equals(warmBubble?.status, "failed", "the failed turn's status");
		report.equals(warmBubble?.statusDetail, PROVIDER_ERROR, "the failed turn's stated detail");
		report.equals(warm.store.session().phase, "idle", "the phase a failed turn leaves behind");
		/*
		 * The relay mints the upstream run id itself (anti-replay: a caller who
		 * could choose it could replay a receipt), so the client's turn id never
		 * reaches the wire — the PROMPT is what proves this turn was forwarded.
		 */
		report.check(
			stack.chat.requests().some((request) => lastUserContent(request).includes(PROMPT)),
			`the Worker never forwarded the turn the bubble is keyed by; it forwarded ${describeTurns(stack.chat.requests())}`,
		);
		report.ok(
			"E3.9 — a turn that fails mid-stream keeps its partial text, reports status failed with the upstream's own sentence, and returns the composer to idle.",
		);

		// ---------------------------------------------------------------- E3.9b
		// A failure BEFORE any delta has no bubble to mark up, so the reducer
		// writes the in-character one. Red if that branch ever answers with
		// silence, jargon, or a statusDetail the note would then double-state.
		stack.chat.reset();
		stack.chat.script({ frames: [{ type: "done", error: PROVIDER_ERROR }] });
		const cold = await openClient({ origin, cookie });
		await cold.controller.loadSession();
		cold.controller.runCommandArgs("send", PROMPT);
		await cold.settle(
			"the cold failure never marked the turn failed",
			() => responseOf(cold.store, lastTurnId(cold.store, report))?.status === "failed",
		);
		const coldBubble = responseOf(cold.store, lastTurnId(cold.store, report));
		report.equals(coldBubble?.text, COLD_BUBBLE, "the in-character bubble a turn that never spoke leaves");
		report.equals(coldBubble?.status, "failed", "the cold failure's status");
		report.equals(coldBubble?.statusDetail, undefined, "the cold failure must not also stamp a detail");
		report.ok("E3.9 — a turn that fails before its first word renders the in-character failure bubble.");

		// ---------------------------------------------------------------- E3.9c
		// A stream that completes having said nothing is a failure with a name.
		stack.chat.reset();
		stack.chat.script({ frames: [{ type: "done", reason: "stop" }] });
		const empty = await openClient({ origin, cookie });
		await empty.controller.loadSession();
		empty.controller.runCommandArgs("send", PROMPT);
		await empty.settle(
			"the empty turn never settled",
			() => empty.store.session().phase === "idle" && ordered(empty.store).length > 1,
		);
		const emptyBubble = responseOf(empty.store, lastTurnId(empty.store, report));
		report.equals(emptyBubble?.text, EMPTY_BUBBLE, "an empty stream must be named, never rendered as success");
		report.equals(emptyBubble?.status, "failed", "the empty stream's status");
		report.ok("E3.9 — a stream that ends without a word fails by name instead of completing silently.");

		// ---------------------------------------------------------------- E3.10
		// Retry RE-RUNS the failed turn: it re-POSTs the same user prompt and
		// "does not duplicate the user" (MANUAL-REVIEW-CHECKLIST 4.6), so the
		// transcript keeps one user bubble and the dead answer is replaced in
		// place. This block used to assert the opposite — a fresh turn id and a
		// second user bubble — which no canon states and the app has never done,
		// so the suite was red on a claim rather than on a defect.
		stack.chat.reset();
		stack.chat.script([
			{
				frames: [
					{ type: "delta", kind: "text", text: WARM_PARTIAL },
					{ type: "done", error: PROVIDER_ERROR },
				],
			},
			{
				frames: [
					{ type: "delta", kind: "text", text: RETRY_REPLY },
					{ type: "done", reason: "stop" },
				],
			},
		]);
		const retry = await openClient({ origin, cookie });
		await retry.controller.loadSession();
		retry.controller.runCommandArgs("send", PROMPT);
		await retry.settle(
			"the turn to be retried never failed",
			() => responseOf(retry.store, lastTurnId(retry.store, report))?.status === "failed",
		);
		const failedTurnId = lastTurnId(retry.store, report);
		report.check(
			stack.chat.requests().some((request) => lastUserContent(request).includes(PROMPT)),
			`the turn to be retried never reached the upstream; it forwarded ${describeTurns(stack.chat.requests())}`,
		);
		const postsBeforeRetry = stack.chat.requests().length;
		report.check(retry.controller.runCommand("retry"), "the retry command is not registered");
		await retry.settle(
			"the retry never re-POSTed a turn",
			() => stack.chat.requests().length > postsBeforeRetry,
		);
		const second = stack.chat.requests()[postsBeforeRetry];
		/*
		 * The relay mints its own upstream run id, so "the retry re-runs the
		 * SAME turn" is proven where it is true: the prompt rides again, and the
		 * failed turn's own bubble (same turn id) is the one that completes
		 * below — never a second user bubble.
		 */
		report.includes(lastUserContent(second) ?? "", PROMPT, "the prompt the retry resubmitted");
		// Checklist 4.6: the same question is not asked twice in the transcript.
		report.equals(
			ordered(retry.store).filter((message) => message.role === "user" && message.text === PROMPT).length,
			1,
			"the retry duplicated the user's message instead of re-running the turn",
		);
		// The dead partial made way for the re-run, so it is not fed back as
		// context — the model answers the question, not its own failed draft.
		report.check(
			second?.messages.some(
				(message) => message.role === "assistant" && String(message.content) === WARM_PARTIAL,
			) !== true,
			"the retry carried the failed turn's abandoned partial back into the context",
		);
		await retry.settle(
			"the retried turn never completed",
			() => responseOf(retry.store, failedTurnId)?.status === "complete",
		);
		report.equals(responseOf(retry.store, failedTurnId)?.text, RETRY_REPLY, "the retried turn's answer");
		report.ok(
			"E3.10 — retry on a failed turn re-POSTs the same user prompt, replaces the dead answer in place without duplicating the user's message, and completes.",
		);

		// -------------------------------------------------------- E3.11 + E3.5a
		// Stopping keeps everything the model had already said and returns the
		// surface inside the stop budget. Red if the cancel reducer starts
		// clearing text, if the detail sentence changes, if the phase stays
		// responding, or if frames keep landing after the kill.
		stack.chat.reset();
		/*
		 * Chain staging: the words the user can lose exist once say() landed, so
		 * link 1 says the prefix and asks for a successor whose author stream is
		 * the slow one the kill interrupts.
		 */
		stack.chat.script([
			{
				raw: true,
				frames: [
					{
						type: "delta",
						kind: "text",
						text: [
							"```flow",
							`await ctx.call("say", { text: ${JSON.stringify(
								Array.from({ length: 8 }, (_unused, index) => `chunk ${index} `).join(""),
							)} })`,
							'return to(await ctx.call("author", { context: ["continue"] }))',
							"```",
						].join("\n"),
					},
					{ type: "done", reason: "stop" },
				],
			},
			{
				raw: true,
				gapMs: 250,
				frames: Array.from({ length: 32 }, (_unused, index) => ({
					type: "delta",
					kind: "text",
					text: `slow successor chunk ${index} `,
				})),
			},
		]);
		const stopped = await openClient({ origin, cookie });
		await stopped.controller.loadSession();
		stopped.controller.runCommandArgs("send", SLOW_PROMPT);
		await stopped.settle(
			"the slow turn never streamed far enough to interrupt",
			() => (responseOf(stopped.store, lastTurnId(stopped.store, report))?.text ?? "").includes("chunk 2"),
			20_000,
		);
		const stoppedTurnId = lastTurnId(stopped.store, report);
		const partial = responseOf(stopped.store, stoppedTurnId)?.text ?? "";
		const startedAt = Date.now();
		report.check(stopped.controller.runCommand("chat.stop"), "the chat.stop command is not registered");
		await stopped.settle(
			"the stopped turn never returned the composer to idle",
			() => stopped.store.session().phase === "idle",
			STOP_BUDGET_MS + 2_000,
		);
		const stoppedMs = Date.now() - startedAt;
		const kept = responseOf(stopped.store, stoppedTurnId);
		report.equals(kept?.text, partial, "the interrupted turn discarded the partial it had already streamed");
		report.check(
			kept?.text.startsWith("chunk 0 chunk 1 chunk 2 ") === true,
			`the retained partial is not the streamed prefix (saw ${JSON.stringify(kept?.text.slice(0, 80))})`,
		);
		report.equals(kept?.status, "interrupted", "the stopped turn's status");
		report.equals(kept?.statusDetail, STOP_DETAIL, "the stopped turn must state what stopped");
		report.check(
			stoppedMs <= STOP_BUDGET_MS,
			`stopping took ${stoppedMs}ms, over the ${STOP_BUDGET_MS}ms budget`,
		);
		// Non-vacuity: the double keeps streaming for another 30 chunks, so a
		// "stop" that only relabelled the bubble would grow it again here.
		await wait(900);
		report.equals(
			responseOf(stopped.store, stoppedTurnId)?.text,
			partial,
			"the stopped turn kept growing, so foreground work did not actually stop",
		);
		report.ok(
			`E3.11 — an interrupted turn retains its partial text with status interrupted, and E3.5 — stopping settled in ${stoppedMs}ms and no further frame landed.`,
		);

		// ----------------------------------------------------------- E3.6 store
		// Close-and-reopen at store altitude: two AppStores over ONE persisted
		// map, the second one booting into the bytes the first left mid-turn.
		// openClient() owns its storage (one Map per client, by design), so this
		// half builds the pair by hand — the same createAppStore/
		// createAppController/createWebAgent wiring, with the storage shared.
		//
		// This proves persistence and boot reconciliation over the localStorage
		// adapter. The OPFS adapter the browser really uses is exercised by the
		// page half below, which is where a reload is a reload.
		stack.chat.reset();
		stack.chat.script(MID_TURN_SCRIPT);
		const shared = sharedStorage();
		const midTurn = await openSharedClient(origin, cookie, shared);
		await midTurn.controller.loadSession();
		midTurn.controller.runCommandArgs("send", RESTORE_PROMPT);
		await waitUntil(
			report,
			"the mid-turn partial never reached the store",
			() => (responseOf(midTurn.store, lastTurnId(midTurn.store, report))?.text ?? "").includes("chunk 1"),
			20_000,
		);
		const restoredTurnId = lastTurnId(midTurn.store, report);
		// The bytes as they stood when the app went away — the live objects prove
		// nothing about what a reopened app would find. Snapshotting both
		// collections in one read also keeps this race-free: the still-running
		// turn rewrites the live map the instant it ends, and the reopened store
		// must boot from the mid-turn bytes rather than from that.
		const closed = await closedMidTurnBytes(report, shared);
		report.ok(
			"E3.6 — a mid-turn app persists its responding session and the partial it has streamed, so there is something to reopen.",
		);

		const reopened = await createAppStore({ kind: "localStorage", storage: sharedStorage(closed) });
		const restoredUser = ordered(reopened).filter((message) => message.role === "user").at(-1);
		report.equals(restoredUser?.text, RESTORE_PROMPT, "the reopened app did not restore the conversation");
		const restored = responseOf(reopened, restoredTurnId);
		report.check(
			restored?.text.startsWith("chunk 0 chunk 1 ") === true,
			`the reopened app lost the in-flight partial (saw ${JSON.stringify(restored?.text.slice(0, 80))})`,
		);
		report.equals(restored?.status, "interrupted", "the restored turn's status");
		report.equals(restored?.statusDetail, ORPHAN_DETAIL, "the restored turn must be correctly described");
		report.equals(reopened.session().phase, "idle", "a reopened app must never restore a stuck pending surface");
		report.check(
			[...reopened.collections.transitions.values()].some(
				(transition) => transition.type === "session.turn.orphaned",
			),
			"the boot reconciliation was not journaled",
		);
		report.ok(
			"E3.6 — a store reopened over a mid-turn session restores the conversation and the in-flight partial, describes it as interrupted by the close, and comes back idle.",
		);
		// Release the still-open upstream turn before the next section arms the
		// double again; the assertions above are already made.
		midTurn.controller.stop();

		// ---------------------------------------------------------- page altitude
		// openIfAvailable answers undefined for the one skippable condition — this
		// machine has no Chrome at all — and throws for every other way of failing
		// to get a page: a browser that never exposed its DevTools endpoint, a
		// socket that died mid-handshake, a target that stopped answering. Those
		// throws fail the suite. Catching them here would delete four rows of
		// coverage while the suite still reported PASS, which is what a catch-all
		// around this call used to do.
		const session = await browser.openIfAvailable(cookie);
		if (session === undefined) {
			console.log(`skip: E3.9 page altitude — ${browser.reason ?? "no browser"}`);
			return;
		}
		// Every page call below is bounded; `bounded` says what that adds to the
		// per-call bound Browser.ts already applies.
		const page = bounded(session.page);

		// ------------------------------------------------------------ E3.6 page
		// The real row: a real reload of the real SPA, over whichever persistence
		// the browser resolved. Red if the reload restores an empty transcript, a
		// prompt with no answer, an undescribed stump, or a stuck composer.
		try {
			stack.chat.reset();
			stack.chat.script(MID_TURN_SCRIPT);
			await awaitComposer(report, page);
			await sendPrompt(page, RESTORE_PROMPT);
			const streaming = await waitForText(
				page,
				(text) => text.includes("chunk 1"),
				30_000,
				() => Date.now(),
				wait,
			);
			report.check(streaming.ok, "the page never rendered the streamed partial, so there was nothing to restore");
			report.equals(await composerStatus(page), "submitted", "the composer state mid-turn");
			report.excludes(streaming.text, ORPHAN_NOTE, "the restore note was on screen before the reload");
			// Persistence is a write behind the render, and the SPA's wa-sqlite
			// backend writes it through an OPFS worker. Reopening the instant the
			// text appears reopens ahead of the write, so this waits for the bytes
			// to exist rather than for the paint.
			const written = await persistedPageBytes(report, page);
			await wait(2_000);
			await reopenApp(session, page);

			const restoredPage = await waitForText(
				page,
				(text) => text.includes(RESTORE_PROMPT) && text.includes("chunk 1"),
				45_000,
				() => Date.now(),
				wait,
			);
			const kept = await page.evaluate<PersistedEvidence>(PERSISTED_EVIDENCE);
			// The root cause is asserted before the symptom, so the failure names
			// the defect rather than only its effect. This one also has to hold
			// once the transcript comes back: an app that restores the text but
			// still chose a different store than it wrote to has moved the loss to
			// the next launch instead of fixing it.
			report.check(
				flippedBackend(written, kept) === undefined,
				`${lostReason(written, kept)}; it had written ${JSON.stringify(written)} and it now holds ${JSON.stringify(kept)}`,
			);
			report.check(
				restoredPage.ok,
				`${lostReason(written, kept)}; the page showed ${JSON.stringify(restoredPage.text.slice(0, 200))}, it had written ${JSON.stringify(written)}, it now holds ${JSON.stringify(kept)}, and it logged ${JSON.stringify(session.consoleErrors().slice(-3))}`,
			);
			// waitForText returned the moment the transcript reappeared, and the
			// note is a second render off the same boot reconciliation. Reading
			// that one snapshot raced it. This still fails when the note never
			// arrives, which is the assertion; it just stops failing when the note
			// is one frame behind the text it annotates.
			const described = await waitForText(
				page,
				(text) => text.includes(ORPHAN_NOTE),
				10_000,
				() => Date.now(),
				wait,
			);
			// The evidence goes in the message because the two ways this fails look
			// alike from the outside: an app that restored the wrong store has no
			// interrupted turn to describe, and an app that restored the right one
			// and skipped reconciliation has one and says nothing about it. What
			// was on disk before and after the reopen tells them apart.
			report.check(
				described.ok,
				`the restored turn is not correctly described: no ${JSON.stringify(ORPHAN_NOTE)} appeared within ${described.elapsedMs}ms of the transcript coming back, though the transcript itself did; it had written ${JSON.stringify(written)}, it now holds ${JSON.stringify(kept)}, the page showed ${JSON.stringify(described.text.slice(0, 300))}, and it logged ${JSON.stringify(session.consoleErrors().slice(-3))}`,
			);
			await waitUntil(
				report,
				"the reopened page left the composer stuck mid-turn",
				async () => (await composerStatus(page)) === "ready",
				10_000,
			);
			// A restored surface has to still work, not merely look right.
			stack.chat.script({
				frames: [
					{ type: "delta", kind: "text", text: RETRY_REPLY },
					{ type: "done", reason: "stop" },
				],
			});
			await sendPrompt(page, "and now?");
			const usable = await waitForText(
				page,
				(text) => text.includes(RETRY_REPLY),
				30_000,
				() => Date.now(),
				wait,
			);
			// A bare "it could not run a new turn" cannot be acted on: the client
			// never sending, the Worker refusing, and the double never answering all
			// look the same from an unchanged transcript. What the upstream saw
			// separates the first from the other two, and the composer's own state
			// separates a surface that refused the prompt from one that accepted it
			// and got nothing back.
			if (!usable.ok) {
				report.fail(
					`the restored page could not run a new turn: no ${JSON.stringify(RETRY_REPLY)} arrived within ${usable.elapsedMs}ms; ` +
						`the composer read ${JSON.stringify(await composerStatus(page))}, the Worker forwarded ${describeTurns(stack.chat.requests())}, ` +
						`the page ends with ${JSON.stringify(usable.text.slice(-400))}, and it logged ${JSON.stringify(session.consoleErrors().slice(-3))}`,
				);
			}
			// The evidence is stated on the way through, not only on the way out.
			// This row goes green on two different machines for two different
			// reasons — one resolves OPFS, one falls back to localStorage — and a
			// green line that does not name the store cannot be read back later to
			// tell which of the two this run actually proved.
			report.ok(
				`E3.6 — reloading the page mid-turn restores the conversation and the in-flight partial, describes it as interrupted by the close, and leaves the surface usable. It had written ${JSON.stringify(written)}, and the reopened app read back ${JSON.stringify(kept)} from the same store.`,
			);

			// --------------------------------------------------- E3.9/E3.10 page
			// The rendered half of the failure contract and the retry affordance
			// itself. Red if the note stops stating the failure, if the button
			// stops rendering beside a failed turn, or if clicking it sends
			// nothing.
			//
			// The note's LABEL is deliberately not pinned here. App.tsx:52-55
			// returns "Turn interrupted — <detail>" for any message carrying a
			// statusDetail, so a failed turn that had already streamed text is
			// currently labelled interrupted. That is a product defect, not a
			// test contract; pinning it would freeze the bug. What is pinned is
			// what the row asks for — the failure is stated on screen beside the
			// partial, with a retry beside it.
			stack.chat.reset();
			stack.chat.script([
				// Chain staging, as in the store half: the partial exists once
				// say() landed; the successor's author call is the one that dies.
				{
					raw: true,
					frames: [
						{
							type: "delta",
							kind: "text",
							text: [
								"```flow",
								`await ctx.call("say", { text: ${JSON.stringify(WARM_PARTIAL)} })`,
								'return to(await ctx.call("author", { context: ["continue"] }))',
								"```",
							].join("\n"),
						},
						{ type: "done", reason: "stop" },
					],
				},
				{ raw: true, frames: [{ type: "done", error: PROVIDER_ERROR }] },
				{
					frames: [
						{ type: "delta", kind: "text", text: RETRY_REPLY },
						{ type: "done", reason: "stop" },
					],
				},
			]);
			await sendPrompt(page, PROMPT);
			const failedPage = await waitForText(
				page,
				(text) => text.includes(PROVIDER_ERROR),
				30_000,
				() => Date.now(),
				wait,
			);
			report.check(failedPage.ok, "the page never stated why the turn failed");
			// innerText collapses the delta's trailing space, so compare the words.
			report.includes(
				failedPage.text,
				WARM_PARTIAL.trim(),
				"the page discarded the partial the turn had streamed",
			);
			await waitUntil(
				report,
				"no retry affordance rendered beside the failed turn",
				async () => (await page.evaluate<boolean>(RETRY_BUTTON)) === true,
				10_000,
			);
			// Retry RE-RUNS the failed turn, so the new POST carries that turn's own
			// id: counting requests is what tells a re-run from silence, not a set
			// of ids the re-run deliberately reuses.
			const postsBeforeClick = stack.chat.requests().length;
			report.equals(await page.evaluate<boolean>(CLICK_RETRY), true, "the retry button did not click");
			await waitUntil(
				report,
				"clicking retry sent no new turn",
				() => stack.chat.requests().length > postsBeforeClick,
				15_000,
			);
			/*
			 * The retry resumes the SAME lineage from its settled prefix, so the
			 * wire carries the successor authoring's context, not the original
			 * prompt again. The proof the same question was re-run is on screen:
			 * the answer arrives under the same turn, with the user's message
			 * still asked exactly once.
			 */
			const retriedPage = await waitForText(
				page,
				(text) => text.includes(RETRY_REPLY),
				30_000,
				() => Date.now(),
				wait,
			);
			report.check(retriedPage.ok, "the retried turn never rendered its completed answer");
			report.equals(
				(retriedPage.text.match(new RegExp(PROMPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length,
				1,
				"the retry duplicated the user's message",
			);
			report.ok(
				"E3.9/E3.10 — a failed turn renders its partial, states the failure in the system note, and its retry re-runs the turn to completion without duplicating the question.",
			);

			// -------------------------------------------------------- E3.5 page
			// The row is a key press. Red if Escape stops reaching the stop
			// command, if stopping stops saying what stopped, or if it takes
			// longer than the budget the checklist sets.
			stack.chat.reset();
			// Chain staging, as in the store half: say the words first, then hold
			// the successor's author stream open for the Escape to interrupt.
			stack.chat.script([
				{
					raw: true,
					frames: [
						{
							type: "delta",
							kind: "text",
							text: [
								"```flow",
								'await ctx.call("say", { text: "chunk 0 chunk 1 chunk 2 " })',
								'return to(await ctx.call("author", { context: ["continue"] }))',
								"```",
							].join("\n"),
						},
						{ type: "done", reason: "stop" },
					],
				},
				{
					raw: true,
					gapMs: 250,
					frames: Array.from({ length: 32 }, (_unused, index) => ({
						type: "delta",
						kind: "text",
						text: `slow successor chunk ${index} `,
					})),
				},
			]);
			// Count the chunks already on screen first. The restored turn from E3.6
			// is still in this transcript and it streamed the same words, so
			// "chunk 1 is on the page" was true before this prompt was even sent:
			// Escape then landed on a turn that had not spoken yet, and the row
			// measured the wrong thing. This waits for THIS turn to stream.
			const chunksBefore = occurrences(await page.text(), "chunk 1");
			await sendPrompt(page, SLOW_PROMPT);
			await waitUntil(
				report,
				"the page never entered the mid-turn state",
				async () => (await composerStatus(page)) === "submitted",
				20_000,
			);
			const beforeEscape = await waitForText(
				page,
				(text) => occurrences(text, "chunk 1") > chunksBefore,
				30_000,
				() => Date.now(),
				wait,
			);
			report.check(
				beforeEscape.ok,
				`the slow turn never streamed, so there was no foreground work to stop: the page still holds ${chunksBefore} "chunk 1" from earlier turns and no more`,
			);
			report.excludes(beforeEscape.text, STOP_NOTE, "the stop note was on screen before Escape was pressed");
			report.equals(
				await page.evaluate<boolean>(`(() => {
	const composer = document.querySelector("textarea");
	if (composer === null) return false;
	composer.focus();
	return true;
})()`),
				true,
				"the composer could not take focus for the Escape press",
			);
			const escapedAt = Date.now();
			await page.press("Escape");
			const escapeSettled = await waitForText(
				page,
				(text) => text.includes(STOP_NOTE),
				STOP_BUDGET_MS,
				() => Date.now(),
				wait,
				100,
			);
			// The budget is not relaxed by a byte. What is added is which failure
			// this is: waitForText returns the moment the budget expires, so its
			// elapsed time is the budget, never the note's true latency. A row that
			// is late by a frame and a row where Escape does nothing at all read
			// identically until something looks after the deadline.
			if (!escapeSettled.ok) {
				const stuckAt = await composerStatus(page);
				const later = await waitForText(page, (text) => text.includes(STOP_NOTE), 10_000, () => Date.now(), wait);
				report.fail(
					`Escape did not state what stopped within ${STOP_BUDGET_MS}ms; ` +
						(later.ok
							? `the note did arrive, ${STOP_BUDGET_MS + later.elapsedMs}ms after the press, so foreground work stops but not inside the budget`
							: `the note had still not arrived ${STOP_BUDGET_MS + later.elapsedMs}ms after the press`) +
						`; the composer read ${JSON.stringify(stuckAt)}, the page holds the label ${JSON.stringify(NOTE_LABEL)}: ` +
						`${later.text.includes(NOTE_LABEL)}, holds the detail ${JSON.stringify(STOP_DETAIL)}: ${later.text.includes(STOP_DETAIL)}, ` +
						`and ends with ${JSON.stringify(later.text.slice(-500))}`,
				);
			}
			await waitUntil(
				report,
				"the page never returned the composer to ready after Escape",
				async () => (await composerStatus(page)) === "ready",
				5_000,
			);
			report.ok(
				`E3.5 — Escape in the composer stopped foreground work and stated what stopped in ${Date.now() - escapedAt}ms, inside the ${STOP_BUDGET_MS}ms budget.`,
			);
		} finally {
			// Park the tab before letting go of it. E2eBrowser.close() drops the
			// CDP socket but leaves the target open, and a page left on the origin
			// keeps polling the Worker — traffic a later run would see as its own.
			await withDeadline("the tab to park on about:blank", PAGE_CALL_MS, () =>
				session.send("Page.navigate", { url: "about:blank" }),
			).catch(() => {});
			session.close();
		}
	},
});

/**
 * A StorageApi whose bytes a suite can read back, so "it persisted" is asserted
 * against what was written rather than against the live objects still in memory.
 */
type StoredBytes = ReadonlyArray<readonly [string, string]>;

interface SharedStorage extends StorageApi {
	/** Every key written so far, as one point-in-time copy. */
	readonly entries: () => StoredBytes;
}

const sharedStorage = (seed: StoredBytes = []): SharedStorage => {
	const data = new Map<string, string>(seed.map(([key, value]) => [key, value]));
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key),
		entries: () => [...data.entries()],
	};
};

/* Derived from the product's own prefix, so renaming it cannot leave this green. */
const SESSIONS_KEY = `${PERSISTED_KEY_PREFIX}app-sessions`;
const MESSAGES_KEY = `${PERSISTED_KEY_PREFIX}app-messages`;

/** How long the mid-turn app may take to write a responding session beside its partial. */
const PERSIST_ATTEMPTS = 150;
const PERSIST_STEP_MS = 100;

/** The persisted bytes of an app that is mid-turn: a responding session and a partial. */
const closedMidTurnBytes = async (report: Reporter, storage: SharedStorage): Promise<StoredBytes> => {
	let snapshot: StoredBytes = [];
	for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
		snapshot = storage.entries();
		const held = (key: string): string => snapshot.find(([name]) => name === key)?.[1] ?? "";
		if (held(SESSIONS_KEY).includes(`"responding"`) && held(MESSAGES_KEY).includes("chunk 1")) {
			return snapshot;
		}
		await wait(PERSIST_STEP_MS);
	}
	const describe = (key: string): string =>
		JSON.stringify((snapshot.find(([name]) => name === key)?.[1] ?? "").slice(0, 300));
	return report.fail(
		`the mid-turn app never persisted a responding session beside its partial in ${PERSIST_ATTEMPTS * PERSIST_STEP_MS}ms: ` +
			`${SESSIONS_KEY} held ${describe(SESSIONS_KEY)}, ${MESSAGES_KEY} held ${describe(MESSAGES_KEY)}`,
	);
};

/** How long the page may take to write bytes a reopen could restore. */
const PAGE_PERSIST_MS = 20_000;

/**
 * What the page has written, once either backend holds something.
 *
 * Bounded on the wall clock, and the failure names what it last saw. "The app
 * wrote nothing" and "the app wrote somewhere this read cannot reach" both
 * present as an empty reopen, and only the bytes on disk tell them apart, so
 * the poll that gates the reopen reports them instead of a bare timeout.
 *
 * A locked OPFS entry counts as written on purpose: the app under test is
 * mid-turn and its own worker holds the access handles, so a read that cannot
 * open the file still proves the file is there. `hasSqliteData` is stricter
 * because it answers a different question — whether that store holds rows.
 */
const persistedPageBytes = async (report: Reporter, page: ProbePage): Promise<PersistedEvidence> => {
	const deadline = Date.now() + PAGE_PERSIST_MS;
	let evidence: PersistedEvidence = { local: [], opfs: [] };
	for (;;) {
		evidence = await page.evaluate<PersistedEvidence>(PERSISTED_EVIDENCE);
		if (localData(evidence).length > 0 || evidence.opfs.some((entry) => !entry.endsWith(":0"))) return evidence;
		if (Date.now() >= deadline) {
			return report.fail(
				`the page never wrote anything a reopen could restore in ${PAGE_PERSIST_MS}ms, so there was nothing to restore: ` +
					`localStorage held ${JSON.stringify(evidence.local)} and OPFS held ${JSON.stringify(evidence.opfs)}`,
			);
		}
		await wait(100);
	}
};

/**
 * The product's own store, controller and agent over a caller-supplied
 * StorageApi, so two of them can share one set of persisted bytes. The fetch is
 * injected, never assigned to globalThis: a suite that patched the global would
 * corrupt the stack every other suite shares.
 */
const openSharedClient = async (
	origin: string,
	cookie: string,
	storage: StorageApi,
): Promise<{ readonly store: AppStore; readonly controller: AppController }> => {
	const fetchImpl: FetchLike = async (input, init) => {
		const base =
			typeof input === "string" || input instanceof URL ? new Request(input, init) : (input as Request);
		const url = new URL(base.url);
		const request =
			url.origin !== origin || base.headers.has("cookie")
				? base
				: new Request(base, { headers: new Headers([...base.headers, ["cookie", cookie]]) });
		return fetch(request);
	};
	const store = await createAppStore({ kind: "localStorage", storage });
	// The product's one backend: the chain seat, bound exactly as
	// ControllerBoot binds it (Client.ts does the same).
	const seat = createAgentSeat();
	const controller = createAppController(store, NO_NATIVE_REPOSITORIES, seat, {
		baseUrl: origin,
		fetchImpl,
		workflowPollMs: 150,
	});
	seat.bindChain(createChainRuntime({ store, commands: controller.commands, baseUrl: origin, fetchImpl }));
	return { store, controller };
};
