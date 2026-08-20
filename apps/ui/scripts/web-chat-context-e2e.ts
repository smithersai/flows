/**
 * Real-browser end-to-end proof for the runtime-context seam: drives headless
 * Chrome over the DevTools protocol against a hermetic app (built SPA +
 * `wrangler dev` + a scripted chat double), asks the exact prompt "hey
 * smithers what app am I in", and asserts the streamed reply identifies
 * Smithers from the supplied runtime context. Then it changes app state (the
 * theme) and proves — from the sniffed /api/agent/turn request body — that the
 * NEXT turn carries a freshly derived context seeing the update.
 *
 * The state lever is the theme: it is the smallest always-available change that
 * both turns can observe, and the toggle lives in the corner chrome that is
 * mounted on every surface. (The surface would work as a lever too now that
 * World and Connectors open as panes beside a persistent composer — see
 * scripts/web-chat-shell-e2e.ts, which proves exactly that — but the theme keeps
 * this script's assertion about freshly derived context to one variable.)
 *
 * The model at the far end is scripted, so this costs nothing and its reply is
 * deterministic. The double echoes the context it received back into the reply,
 * which is what makes "the reply identified Smithers from the context" a real
 * assertion rather than a canned match.
 *
 * Usage: bun scripts/web-chat-context-e2e.ts [url]
 */
import {
	CLEARABLE_STORAGE,
	HERMETIC_REPLY_PREFIX,
	connectCdp,
	openCdpTarget,
	startHermeticApp,
	wait,
} from "./e2e-harness";

const PROMPT_ONE = "hey smithers what app am I in";
const PROMPT_TWO = "and what theme is the app using right now";
const PORT = 9334;
const WORKER_PORT = 8792;

const app = await startHermeticApp({ workerPort: WORKER_PORT });
const APP_URL = process.argv[2] ?? app.origin;

const trace = (step: string) => console.error(`[e2e] ${step}`);

const chrome = await openCdpTarget({
	port: PORT,
	userDataDir: `${process.env.TMPDIR ?? "/tmp"}/smithers-context-e2e-profile`,
	url: APP_URL,
}).catch((error: unknown) => {
	app.stop();
	console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
const cdp = await connectCdp(chrome.socketUrl);

/** Sniffed POST bodies to the turn boundary, in order, straight off the wire. */
const turnBodies: string[] = [];
cdp.onEvent((message) => {
	if (
		message.method === "Network.requestWillBeSent" &&
		message.params?.request?.method === "POST" &&
		message.params.request.url?.includes("/api/agent/turn") === true &&
		typeof message.params.request.postData === "string"
	) {
		turnBodies.push(message.params.request.postData);
	}
});

const done = (code: number): never => {
	cdp.close();
	chrome.kill();
	app.stop();
	process.exit(code);
};

const fail = async (reason: string): Promise<never> => {
	const html = await cdp.evaluate("document.body.innerText").catch(() => "<unavailable>");
	console.error(`FAIL: ${reason}\n---- page text ----\n${html}`);
	return done(1);
};

const typePrompt = async (prompt: string) => {
	// Boot-time async loads (session, reco) can remount the composer; wait it out.
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const mounted = await cdp
			.evaluate(
				"(() => { const t = document.querySelector('textarea'); if (t === null) return false; t.focus(); t.select(); return true; })()",
			)
			.catch(() => false);
		if (mounted === true) break;
		await wait(250);
	}
	for (const character of prompt) {
		await cdp.typeKey(character, `Key${character.toUpperCase()}`, character.charCodeAt(0), character);
	}
	const typed = await cdp.evaluate("document.querySelector('textarea')?.value ?? ''");
	if (typed !== prompt) await fail(`The composer did not receive the prompt (saw ${JSON.stringify(typed)}).`);
	await cdp.typeKey("Enter", "Enter", 13);
};

/*
 * The assistant's own bubbles, never `document.body.innerText`. Slicing the whole
 * page after the prompt sweeps in the app chrome ("Smithers Cloud · live", the
 * suggestion chips), so a "does the reply say Smithers" assertion would pass on
 * the chrome alone while the model was still mid-stream — a false green. A bubble
 * is still streaming while it carries its status marker, so this also waits for a
 * genuinely finished answer instead of guessing from a label's wording.
 *
 * The bubbles are selected by `data-role`, which is what @smthrs/ui's ChatMessage
 * actually emits. This used to filter on a `.message-author` child; nothing has
 * rendered that class since the bubble moved into @smthrs/ui, so `count` was
 * always 0 and every wait here timed out.
 */
const ASSISTANT_STATE = `(() => {
	const bubbles = [...document.querySelectorAll('.smithers-chat-message[data-role="assistant"]')];
	const last = bubbles[bubbles.length - 1];
	const markdown = last === undefined ? null : last.querySelector('.message-markdown');
	return JSON.stringify({
		count: bubbles.length,
		streaming: last !== undefined && last.querySelector('.bubble-system-note') !== null,
		note: last === undefined ? '' : (last.querySelector('.bubble-system-note')?.innerText ?? ''),
		text: markdown === null ? '' : markdown.innerText,
	});
})()`;

interface AssistantState {
	readonly count: number;
	readonly streaming: boolean;
	readonly note: string;
	readonly text: string;
}

const assistantState = async (): Promise<AssistantState> =>
	JSON.parse(String(await cdp.evaluate(ASSISTANT_STATE))) as AssistantState;

/*
 * The boot-time reco digest lands as an assistant bubble a second or two after
 * the composer mounts, so a baseline taken at mount time is a baseline taken
 * before the app finished talking: turn 1 then "completed" on the digest and
 * the run failed on prose it never asked for. Wait for the count to stop
 * moving before baselining.
 */
const settleAssistantBubbles = async (): Promise<number> => {
	let previous = -1;
	let stable = 0;
	for (let attempt = 0; attempt < 40 && stable < 3; attempt += 1) {
		const { count } = await assistantState();
		stable = count === previous ? stable + 1 : 0;
		previous = count;
		await wait(800);
	}
	return previous;
};

/** Waits for a NEW completed assistant bubble past `baseline` and returns only its text. */
const awaitReply = async (baseline: number): Promise<AssistantState> => {
	let state = await assistantState();
	for (let attempt = 0; attempt < 180; attempt += 1) {
		state = await assistantState();
		if (state.count > baseline && !state.streaming && state.text.trim() !== "") return state;
		await wait(500);
	}
	return state;
};

await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Network.enable");
await cdp.send("Network.setExtraHTTPHeaders", { headers: { cookie: app.cookie } });
trace("cdp ready");
await cdp.send("Storage.clearDataForOrigin", {
	origin: new URL(APP_URL).origin,
	storageTypes: CLEARABLE_STORAGE,
});
await cdp.send("Page.navigate", { url: APP_URL });
trace("navigated");

let ready = false;
for (let attempt = 0; attempt < 80 && !ready; attempt += 1) {
	ready = (await cdp.evaluate("document.querySelector('textarea') !== null").catch(() => false)) === true;
	if (!ready) await wait(250);
}
if (!ready) await fail("The composer textarea never mounted.");
trace("composer mounted");

// ---- Turn 1: the exact prompt; the reply must identify Smithers. ----
const baselineOne = await settleAssistantBubbles();
trace(`assistant bubbles settled at ${baselineOne} before turn 1`);
await typePrompt(PROMPT_ONE);
trace("prompt 1 sent");
const stateOne = await awaitReply(baselineOne);
const replyOne = stateOne.text;
trace(`reply 1 received (${replyOne.trim().length} chars)`);
if (stateOne.count <= baselineOne || stateOne.streaming) {
	await fail(`Turn 1 never produced a completed assistant reply (status: ${stateOne.note || "none"}).`);
}

const pageText: string = await cdp.evaluate("document.body.innerText");
const errorMarkers = [
	"Could not reach the Smithers web agent",
	"Smithers web agent failed",
	"Smithers Cloud chat failed",
	"Smithers Cloud returned an empty response",
	"failed to start",
];
const marker = errorMarkers.find((candidate) => pageText.includes(candidate));
if (marker !== undefined) await fail(`The page rendered an error state: ${marker}`);
if (replyOne.trim().length < 20) await fail("No streamed Smithers reply appeared after the prompt.");
if (!/smithers/i.test(replyOne)) {
	await fail(`The reply did not identify Smithers from the runtime context: ${replyOne.trim().slice(0, 300)}`);
}
if (!replyOne.includes(HERMETIC_REPLY_PREFIX)) {
	await fail(`Turn 1's reply did not come from the scripted double: ${replyOne.trim().slice(0, 300)}`);
}
if (/cannot see the host environment|can't see the host environment|don't have access to (the|your) host/i.test(replyOne)) {
	await fail(`The reply pleaded ignorance of the host environment: ${replyOne.trim().slice(0, 300)}`);
}

// The first turn's wire body must carry the structured hidden context…
if (turnBodies.length === 0) await fail("No /api/agent/turn request body was sniffed for turn 1.");
const firstBody = JSON.parse(turnBodies[0] ?? "{}") as { context?: { surface?: string; product?: string } };
if (firstBody.context?.product !== "smithers" || firstBody.context.surface !== "chat") {
	await fail(`Turn 1 crossed the boundary without a chat-surface Smithers context: ${turnBodies[0]?.slice(0, 300)}`);
}
// …and the hidden context must stay OUT of the visible transcript.
if (pageText.includes("Runtime context") || pageText.includes("running INSIDE the Smithers product")) {
	await fail("The hidden runtime context leaked into the visible transcript.");
}

// ---- State change, then turn 2 must SEE the update on the wire. ----
const firstTheme = (firstBody.context as { theme?: string }).theme;
if (firstTheme !== "light" && firstTheme !== "dark") {
	await fail(`Turn 1's context carried no theme (saw ${JSON.stringify(firstTheme)}).`);
}
/*
 * The corner theme control. Its accessible name is "Toggle light and dark
 * mode" (App.tsx); it was "Toggle theme" when this script was written, and a
 * stale aria-label here read as "the toggle is gone" rather than as a rename.
 */
const clicked = await cdp.evaluate(
	"(() => { const b = document.querySelector('button[aria-label=\"Toggle light and dark mode\"]'); if (b === null) return false; b.click(); return true; })()",
);
if (clicked !== true) await fail("The theme toggle button was not found.");
trace("theme toggled");
await wait(500);
const domTheme = await cdp.evaluate("document.documentElement.dataset.theme ?? ''");
if (domTheme === firstTheme) await fail(`The theme did not actually change (still ${domTheme}).`);

const baselineTwo = stateOne.count;
await typePrompt(PROMPT_TWO);
trace("prompt 2 sent");
const stateTwo = await awaitReply(baselineTwo);
const replyTwo = stateTwo.text;
trace(`reply 2 received (${replyTwo.trim().length} chars)`);
if (stateTwo.count <= baselineTwo || stateTwo.streaming) {
	await fail(`Turn 2 never produced a completed assistant reply (status: ${stateTwo.note || "none"}).`);
}

if (turnBodies.length < 2) await fail("No /api/agent/turn request body was sniffed for turn 2.");
const secondBody = JSON.parse(turnBodies[1] ?? "{}") as {
	context?: { theme?: string; revision?: number };
};
if (secondBody.context?.theme !== domTheme) {
	await fail(
		`Turn 2 did not see the state change (context.theme=${secondBody.context?.theme}, app theme=${domTheme}).`,
	);
}
if ((secondBody.context?.revision ?? 0) <= (firstBody.context as { revision?: number }).revision!) {
	await fail("Turn 2's context was not freshly derived (revision did not advance).");
}
/*
 * The double reads the theme back off the COMPOSED instructions the Worker
 * built, so a matching echo proves the change survived the whole path — client
 * context → Worker composition → upstream — not just the client half the
 * sniffed body shows.
 */
if (!replyTwo.includes(`in ${domTheme} mode`)) {
	await fail(`Turn 2's composed instructions did not carry the new theme: ${replyTwo.trim().slice(0, 300)}`);
}

const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
if (typeof screenshot?.data === "string") {
	await Bun.write("/tmp/smithers-context-e2e.png", Buffer.from(screenshot.data, "base64"));
}

console.log(
	`PASS: the reply identified Smithers from the runtime context, and turn 2 saw the state change on the wire (theme ${firstTheme} → ${domTheme}).`,
);
console.log("---- reply 1 ----");
console.log(replyOne.trim().slice(0, 500));
console.log("---- reply 2 ----");
console.log(replyTwo.trim().slice(0, 500));

done(0);
