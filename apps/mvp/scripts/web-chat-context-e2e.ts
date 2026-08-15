/**
 * Real-browser end-to-end proof for the runtime-context fix: drives headless Chrome
 * over the DevTools protocol against the running dev server, asks the exact prompt
 * "hey smithers what app am I in", and asserts the live streamed reply identifies
 * Smithers from the supplied runtime context (not a canned match). Then it changes
 * app state (the theme) and proves — from the sniffed /api/agent/turn request body —
 * that the NEXT turn carries a freshly derived context seeing the update.
 *
 * The state lever is the theme: it is the smallest always-available change that
 * both turns can observe, and the toggle lives in the corner chrome that is
 * mounted on every surface. (The surface would work as a lever too now that
 * World and Connectors open as panes beside a persistent composer — see
 * scripts/web-chat-shell-e2e.ts, which proves exactly that — but the theme keeps
 * this script's assertion about freshly derived context to one variable.)
 *
 * Usage: bun scripts/web-chat-context-e2e.ts [url]
 */
export {};

const APP_URL = process.argv[2] ?? "http://localhost:5173";
const PROMPT_ONE = "hey smithers what app am I in";
const PROMPT_TWO = "and what theme is the app using right now";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const trace = (step: string) => console.error(`[e2e] ${step}`);

const chrome = Bun.spawn(
	[
		CHROME,
		"--headless=new",
		`--remote-debugging-port=${PORT}`,
		`--user-data-dir=${process.env.TMPDIR ?? "/tmp"}/smithers-context-e2e-profile`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-gpu",
		"about:blank",
	],
	{ stdout: "ignore", stderr: "ignore" },
);

const targetWebSocket = async (): Promise<string> => {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(APP_URL)}`, {
				method: "PUT",
			});
			const target = (await response.json()) as { webSocketDebuggerUrl?: string };
			if (target.webSocketDebuggerUrl !== undefined) return target.webSocketDebuggerUrl;
		} catch {
			// Chrome is still starting up.
		}
		await wait(250);
	}
	throw new Error("Chrome DevTools endpoint never became available.");
};

const socketUrl = await targetWebSocket();
const socket = new WebSocket(socketUrl);
await new Promise<void>((resolve, reject) => {
	socket.addEventListener("open", () => resolve());
	socket.addEventListener("error", () => reject(new Error("Could not open a CDP socket.")));
});

let nextId = 0;
const pending = new Map<number, (result: unknown) => void>();
/** Sniffed POST bodies to the turn boundary, in order, straight off the wire. */
const turnBodies: string[] = [];
socket.addEventListener("message", (event) => {
	const message = JSON.parse(String(event.data)) as {
		id?: number;
		method?: string;
		params?: { request?: { url?: string; method?: string; postData?: string } };
		result?: unknown;
		error?: { message: string };
	};
	if (message.id === undefined) {
		if (
			message.method === "Network.requestWillBeSent" &&
			message.params?.request?.method === "POST" &&
			message.params.request.url?.includes("/api/agent/turn") === true &&
			typeof message.params.request.postData === "string"
		) {
			turnBodies.push(message.params.request.postData);
		}
		return;
	}
	pending.get(message.id)?.(message.error ? { cdpError: message.error.message } : message.result);
	pending.delete(message.id);
});

const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
	const id = (nextId += 1);
	return new Promise((resolve) => {
		pending.set(id, resolve);
		socket.send(JSON.stringify({ id, method, params }));
	});
};

const evaluate = async (expression: string): Promise<any> => {
	const result = await send("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
	});
	if (result?.exceptionDetails !== undefined) {
		throw new Error(`Page evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
	}
	return result?.result?.value;
};

const typeKey = async (key: string, code: string, keyCode: number, text?: string) => {
	for (const type of ["keyDown", "keyUp"]) {
		await send("Input.dispatchKeyEvent", {
			type,
			key,
			code,
			windowsVirtualKeyCode: keyCode,
			nativeVirtualKeyCode: keyCode,
			...(type === "keyDown" && text !== undefined ? { text } : {}),
		});
	}
};

const fail = async (reason: string): Promise<never> => {
	const html = await evaluate("document.body.innerText").catch(() => "<unavailable>");
	console.error(`FAIL: ${reason}\n---- page text ----\n${html}`);
	socket.close();
	chrome.kill();
	process.exit(1);
};

const typePrompt = async (prompt: string) => {
	// Boot-time async loads (session, reco) can remount the composer; wait it out.
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const mounted = await evaluate(
			"(() => { const t = document.querySelector('textarea'); if (t === null) return false; t.focus(); t.select(); return true; })()",
		).catch(() => false);
		if (mounted === true) break;
		await wait(250);
	}
	for (const character of prompt) {
		await typeKey(character, `Key${character.toUpperCase()}`, character.charCodeAt(0), character);
	}
	const typed = await evaluate("document.querySelector('textarea')?.value ?? ''");
	if (typed !== prompt) await fail(`The composer did not receive the prompt (saw ${JSON.stringify(typed)}).`);
	await typeKey("Enter", "Enter", 13);
};

/*
 * The assistant's own bubbles, never `document.body.innerText`. Slicing the whole
 * page after the prompt sweeps in the app chrome ("Smithers Cloud · live", the
 * suggestion chips), so a "does the reply say Smithers" assertion would pass on
 * the chrome alone while the model was still mid-stream — a false green. A bubble
 * is still streaming while it carries its status marker, so this also waits for a
 * genuinely finished answer instead of guessing from a label's wording.
 */
const ASSISTANT_STATE = `(() => {
	const bubbles = [...document.querySelectorAll('.smithers-chat-message')]
		.filter((node) => node.querySelector('.message-author') !== null);
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
	JSON.parse(String(await evaluate(ASSISTANT_STATE))) as AssistantState;

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

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
trace("cdp ready");
await send("Storage.clearDataForOrigin", { origin: new URL(APP_URL).origin, storageTypes: "all" });
await send("Page.navigate", { url: APP_URL });
trace("navigated");

let ready = false;
for (let attempt = 0; attempt < 80 && !ready; attempt += 1) {
	ready = (await evaluate("document.querySelector('textarea') !== null").catch(() => false)) === true;
	if (!ready) await wait(250);
}
if (!ready) await fail("The composer textarea never mounted.");
trace("composer mounted");

// ---- Turn 1: the exact prompt; the reply must identify Smithers. ----
const baselineOne = (await assistantState()).count;
await typePrompt(PROMPT_ONE);
trace("prompt 1 sent");
const stateOne = await awaitReply(baselineOne);
const replyOne = stateOne.text;
trace(`reply 1 received (${replyOne.trim().length} chars)`);
if (stateOne.count <= baselineOne || stateOne.streaming) {
	await fail(`Turn 1 never produced a completed assistant reply (status: ${stateOne.note || "none"}).`);
}

const pageText: string = await evaluate("document.body.innerText");
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
const clicked = await evaluate(
	"(() => { const b = document.querySelector('button[aria-label=\"Toggle theme\"]'); if (b === null) return false; b.click(); return true; })()",
);
if (clicked !== true) await fail("The theme toggle button was not found.");
trace("theme toggled");
await wait(500);
const domTheme = await evaluate("document.documentElement.dataset.theme ?? ''");
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

const screenshot = await send("Page.captureScreenshot", { format: "png" });
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

socket.close();
chrome.kill();
process.exit(0);
