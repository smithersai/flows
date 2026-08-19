/**
 * HERMETIC half of the pure-web chat e2e (I-7). The same journey as
 * scripts/web-chat-e2e.ts — real Chrome, real key events, a real streamed
 * NDJSON turn through the deployable Worker — but the model at the far end is
 * a scripted double, so the run costs nothing and its reply is deterministic.
 * That is what makes this half safe to gate CI with.
 *
 * The double echoes the hidden runtime context back out of the reply, so a
 * green run also proves the composed-instructions round trip the live half
 * can only assert loosely ("some Smithers-shaped prose arrived").
 *
 * Usage: bun scripts/web-chat-hermetic-e2e.ts
 */
import {
	CLEARABLE_STORAGE,
	HERMETIC_REPLY_PREFIX,
	connectCdp,
	openCdpTarget,
	startHermeticApp,
	wait,
} from "./e2e-harness";

const PROMPT = "Hello who are you";
const PORT = 9336;
const WORKER_PORT = 8793;

const app = await startHermeticApp({ workerPort: WORKER_PORT });
const APP_URL = app.origin;

const chrome = await openCdpTarget({
	port: PORT,
	userDataDir: `${process.env.TMPDIR ?? "/tmp"}/smithers-hermetic-e2e-profile`,
	url: APP_URL,
}).catch((error: unknown) => {
	app.stop();
	console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
const cdp = await connectCdp(chrome.socketUrl);

const done = (code: number): never => {
	cdp.close();
	chrome.kill();
	app.stop();
	process.exit(code);
};

const fail = async (reason: string): Promise<never> => {
	const text = await cdp.evaluate("document.body.innerText").catch(() => "<unavailable>");
	console.error(`FAIL: ${reason}\n---- page text ----\n${text}`);
	return done(1);
};

await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Network.enable");
// The session was minted over HTTP, so hand it to the page as a header. Cookies
// are deliberately absent from CLEARABLE_STORAGE for the same reason.
await cdp.send("Network.setExtraHTTPHeaders", { headers: { cookie: app.cookie } });
await cdp.send("Storage.clearDataForOrigin", {
	origin: new URL(APP_URL).origin,
	storageTypes: CLEARABLE_STORAGE,
});
await cdp.send("Page.navigate", { url: APP_URL });

let ready = false;
for (let attempt = 0; attempt < 80 && !ready; attempt += 1) {
	ready = (await cdp.evaluate("document.querySelector('textarea') !== null").catch(() => false)) === true;
	if (!ready) await wait(250);
}
if (!ready) await fail("The composer textarea never mounted.");

const statusBefore: string = await cdp.evaluate("document.body.innerText");
if (statusBefore.includes("Web preview") || statusBefore.includes("only available in the native app")) {
	await fail("The web build still advertises itself as unable to run agent turns.");
}
console.log("ok: the SPA the Worker serves mounts a composer and claims no native-only limitation.");

await cdp.evaluate("(() => { const t = document.querySelector('textarea'); t.focus(); t.select(); })()");
for (const character of PROMPT) {
	await cdp.typeKey(character, `Key${character.toUpperCase()}`, character.charCodeAt(0), character);
}
const typed = await cdp.evaluate("document.querySelector('textarea').value");
if (typed !== PROMPT) await fail(`The composer did not receive the prompt (saw ${JSON.stringify(typed)}).`);
await cdp.typeKey("Enter", "Enter", 13);
console.log("ok: the prompt reached the composer through real key events.");

/*
 * The assistant's own bubbles, never document.body.innerText: slicing the page
 * after the prompt sweeps in the app chrome, and an assertion that reads chrome
 * passes while the turn is still in flight.
 */
const REPLY_TEXT = `(() => {
	const bubbles = [...document.querySelectorAll('.smithers-chat-message[data-role="assistant"]')];
	const last = bubbles[bubbles.length - 1];
	const markdown = last === undefined ? null : last.querySelector('.message-markdown');
	return markdown === null ? '' : markdown.innerText;
})()`;

let reply = "";
for (let attempt = 0; attempt < 120 && !reply.includes(HERMETIC_REPLY_PREFIX); attempt += 1) {
	await wait(500);
	reply = String(await cdp.evaluate(REPLY_TEXT));
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
if (!reply.includes(HERMETIC_REPLY_PREFIX)) {
	await fail(`The scripted reply never reached the transcript (saw ${JSON.stringify(reply.slice(0, 300))}).`);
}
console.log("ok: the streamed NDJSON turn rendered as an assistant bubble.");

// The turn crossed the Worker exactly once, and it carried the hidden context.
if (app.chat.turns.length !== 1) {
	await fail(`the chat double saw ${app.chat.turns.length} turns, expected exactly 1.`);
}
const instructions = app.chat.turns[0]?.instructions ?? "";
if (!instructions.includes("- Current surface: chat")) {
	await fail(`the composed instructions carried no chat surface: ${instructions.slice(0, 300)}`);
}
if (!/- Theme: (light|dark)/.test(instructions)) {
	await fail(`the composed instructions carried no theme: ${instructions.slice(0, 300)}`);
}
console.log("ok: the Worker composed the hidden runtime context into the upstream instructions.");

// …and the hidden context stayed out of what the human reads.
if (pageText.includes("Runtime context") || pageText.includes("running INSIDE the Smithers product")) {
	await fail("The hidden runtime context leaked into the visible transcript.");
}
if (!reply.includes("the chat surface is in")) {
	await fail(`the reply did not echo the surface the context named: ${reply.slice(0, 300)}`);
}
console.log("ok: the context reached the model without leaking into the visible transcript.");

const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
if (typeof screenshot?.data === "string") {
	await Bun.write("/tmp/smithers-web-chat-hermetic-e2e.png", Buffer.from(screenshot.data, "base64"));
}

console.log("PASS: pure-web chat streamed a scripted reply end to end, no model spend.");
console.log("---- reply ----");
console.log(reply.trim().slice(0, 800));
done(0);
