/**
 * Real-browser end-to-end check for pure-web Smithers chat: drives headless Chrome over
 * the DevTools protocol against the running dev server, types a prompt with real key
 * events, and asserts a genuine streamed Smithers reply arrives (no error, no stub).
 *
 * Usage: bun scripts/web-chat-e2e.ts [url]
 */
export {};

const APP_URL = process.argv[2] ?? "http://localhost:5173";
const PROMPT = "Hello who are you";
const CHROME =
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = Bun.spawn(
	[
		CHROME,
		"--headless=new",
		`--remote-debugging-port=${PORT}`,
		`--user-data-dir=${process.env.TMPDIR ?? "/tmp"}/smithers-e2e-profile`,
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
socket.addEventListener("message", (event) => {
	const message = JSON.parse(String(event.data)) as {
		id?: number;
		result?: unknown;
		error?: { message: string };
	};
	if (message.id === undefined) return;
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
			// `text` on keyDown is what actually inserts the character.
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

await send("Page.enable");
await send("Runtime.enable");
// Start from a clean profile so a previous run's persisted draft or transcript cannot
// be mistaken for this run's live reply.
await send("Storage.clearDataForOrigin", { origin: new URL(APP_URL).origin, storageTypes: "all" });
await send("Page.navigate", { url: APP_URL });

// Wait for the composer to mount.
let ready = false;
for (let attempt = 0; attempt < 80 && !ready; attempt += 1) {
	ready = (await evaluate("document.querySelector('textarea') !== null").catch(() => false)) === true;
	if (!ready) await wait(250);
}
if (!ready) await fail("The composer textarea never mounted.");

const statusBefore = await evaluate("document.body.innerText");
if (statusBefore.includes("Web preview") || statusBefore.includes("only available in the native app")) {
	await fail("The web build still advertises itself as unable to run agent turns.");
}

// select() so the first keystroke replaces any restored draft instead of prepending.
await evaluate("(() => { const t = document.querySelector('textarea'); t.focus(); t.select(); })()");
for (const character of PROMPT) {
	await typeKey(character, `Key${character.toUpperCase()}`, character.charCodeAt(0), character);
}
const typed = await evaluate("document.querySelector('textarea').value");
if (typed !== PROMPT) await fail(`The composer did not receive the prompt (saw ${JSON.stringify(typed)}).`);

await typeKey("Enter", "Enter", 13);

let reply = "";
for (let attempt = 0; attempt < 120; attempt += 1) {
	await wait(500);
	const text: string = await evaluate("document.body.innerText");
	reply = text.slice(text.lastIndexOf(PROMPT) + PROMPT.length);
	if (!/thinking|working/i.test(reply) && reply.trim().length > 40) break;
}

const pageText: string = await evaluate("document.body.innerText");
const errorMarkers = [
	"only available in the native app",
	"Web preview",
	"Could not reach the Smithers web agent",
	"Smithers web agent failed",
	"Smithers Cloud chat failed",
	"Smithers Cloud returned an empty response",
	"failed to start",
];
const marker = errorMarkers.find((candidate) => pageText.includes(candidate));
if (marker !== undefined) await fail(`The page rendered an error state: ${marker}`);
if (reply.trim().length < 20) await fail("No streamed Smithers reply appeared after the prompt.");

const screenshot = await send("Page.captureScreenshot", { format: "png" });
if (typeof screenshot?.data === "string") {
	await Bun.write("/tmp/smithers-web-chat-e2e.png", Buffer.from(screenshot.data, "base64"));
}

console.log("PASS: pure-web chat returned a live Smithers reply.");
console.log("---- reply region ----");
console.log(reply.trim().slice(0, 800));

socket.close();
chrome.kill();
process.exit(0);
