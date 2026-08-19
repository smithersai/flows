/**
 * LIVE half of the pure-web chat e2e (I-7). Drives headless Chrome over the
 * DevTools protocol, types a prompt with real key events, and asserts a
 * genuine streamed Smithers reply arrives — no error state, no stub.
 *
 * This one talks to a REAL model and SPENDS REAL MONEY, so it can never gate
 * CI. Run it by hand or as a canary. The hermetic counterpart that asserts the
 * same journey against a scripted model double is
 * scripts/web-chat-hermetic-e2e.ts.
 *
 * With no url argument it boots the vite dev server itself, which proxies the
 * deployed seams and answers /api/agent locally against chat.smithers.sh.
 *
 * Usage: bun scripts/web-chat-e2e.ts [url]
 */
import { fileURLToPath } from "node:url";
import { CLEARABLE_STORAGE, connectCdp, openCdpTarget, wait } from "./e2e-harness";

/*
 * `localhost`, not 127.0.0.1: vite's dev server binds the IPv6 loopback only,
 * so a 127.0.0.1 probe never sees it and the self-boot below concludes the
 * server it just started never came up.
 */
const APP_URL = process.argv[2] ?? process.env.SMITHERS_E2E_URL ?? "http://localhost:5173";
const PROMPT = "Hello who are you";
const PORT = 9333;

const reachable = async (url: string): Promise<boolean> => {
	try {
		return (await fetch(url)).ok;
	} catch {
		return false;
	}
};

/*
 * Pointed at a running origin the script drives it; pointed at the default dev
 * port with nothing listening it starts the dev server itself. `bun run web`
 * carries the --configLoader runner flag this config needs.
 */
let devServer: ReturnType<typeof Bun.spawn> | undefined;
if (!(await reachable(APP_URL))) {
	console.error(`[e2e] nothing answers ${APP_URL}; starting the dev server`);
	devServer = Bun.spawn(["bun", "run", "web"], {
		cwd: fileURLToPath(new URL("../", import.meta.url)),
		stdout: "inherit",
		stderr: "inherit",
	});
	let up = false;
	for (let attempt = 0; attempt < 120 && !up; attempt += 1) {
		await wait(500);
		up = await reachable(APP_URL);
	}
	if (!up) {
		devServer.kill();
		console.error(`FAIL: the dev server never came up on ${APP_URL}.`);
		process.exit(1);
	}
}

const chrome = await openCdpTarget({
	port: PORT,
	userDataDir: `${process.env.TMPDIR ?? "/tmp"}/smithers-e2e-profile`,
	url: APP_URL,
}).catch((error: unknown) => {
	devServer?.kill();
	console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
const cdp = await connectCdp(chrome.socketUrl);

const fail = async (reason: string): Promise<never> => {
	const html = await cdp.evaluate("document.body.innerText").catch(() => "<unavailable>");
	console.error(`FAIL: ${reason}\n---- page text ----\n${html}`);
	cdp.close();
	chrome.kill();
	devServer?.kill();
	process.exit(1);
};

await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
// Start from a clean profile so a previous run's persisted draft or transcript cannot
// be mistaken for this run's live reply.
await cdp.send("Storage.clearDataForOrigin", {
	origin: new URL(APP_URL).origin,
	storageTypes: CLEARABLE_STORAGE,
});
await cdp.send("Page.navigate", { url: APP_URL });

// Wait for the composer to mount.
let ready = false;
for (let attempt = 0; attempt < 80 && !ready; attempt += 1) {
	ready = (await cdp.evaluate("document.querySelector('textarea') !== null").catch(() => false)) === true;
	if (!ready) await wait(250);
}
if (!ready) await fail("The composer textarea never mounted.");

const statusBefore = await cdp.evaluate("document.body.innerText");
if (statusBefore.includes("Web preview") || statusBefore.includes("only available in the native app")) {
	await fail("The web build still advertises itself as unable to run agent turns.");
}

// select() so the first keystroke replaces any restored draft instead of prepending.
await cdp.evaluate("(() => { const t = document.querySelector('textarea'); t.focus(); t.select(); })()");
for (const character of PROMPT) {
	await cdp.typeKey(character, `Key${character.toUpperCase()}`, character.charCodeAt(0), character);
}
const typed = await cdp.evaluate("document.querySelector('textarea').value");
if (typed !== PROMPT) await fail(`The composer did not receive the prompt (saw ${JSON.stringify(typed)}).`);

await cdp.typeKey("Enter", "Enter", 13);

let reply = "";
for (let attempt = 0; attempt < 120; attempt += 1) {
	await wait(500);
	const text: string = await cdp.evaluate("document.body.innerText");
	reply = text.slice(text.lastIndexOf(PROMPT) + PROMPT.length);
	if (!/thinking|working/i.test(reply) && reply.trim().length > 40) break;
}

const pageText: string = await cdp.evaluate("document.body.innerText");
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

const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
if (typeof screenshot?.data === "string") {
	await Bun.write("/tmp/smithers-web-chat-e2e.png", Buffer.from(screenshot.data, "base64"));
}

console.log("PASS: pure-web chat returned a live Smithers reply.");
console.log("---- reply region ----");
console.log(reply.trim().slice(0, 800));

cdp.close();
chrome.kill();
devServer?.kill();
process.exit(0);
