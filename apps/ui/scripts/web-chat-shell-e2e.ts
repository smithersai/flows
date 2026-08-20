/**
 * Real-browser end-to-end proof of the chat-first shell contract: World and
 * Connectors are embedded panes inside the persistent chat, not full-screen
 * takeovers that replace it.
 *
 * Drives headless Chrome over the DevTools protocol against a hermetic app
 * (built SPA + `wrangler dev` + a scripted chat double, so no model spend) and,
 * using real clicks on the real affordances:
 *
 *  1. sends a message, so there is conversation state with something to lose,
 *  2. opens Connectors — the composer and transcript must still be visible, and
 *     the transcript and composer DOM nodes must be the SAME nodes (a takeover
 *     that re-rendered an identical transcript would look fine in a screenshot
 *     and still have thrown away scroll, focus, and in-flight editor state),
 *  3. clicks the pane's back-to-conversation affordance,
 *  4. repeats both for World,
 *  5. proves the sent message and the composer draft came through untouched.
 *
 * Node identity is proved by stamping a property on the live nodes before the
 * first transition and asserting it is still on the nodes at the end; React
 * unmounting and re-creating them would drop the stamp.
 *
 * Usage: bun scripts/web-chat-shell-e2e.ts [url]
 */
import { CLEARABLE_STORAGE, connectCdp, openCdpTarget, startHermeticApp, wait } from "./e2e-harness";

const MESSAGE = "remember this message across every pane";
const DRAFT = "a half-written thought";
const PORT = 9335;
const WORKER_PORT = 8794;
const SHOTS = new URL("../reports/chat-shell/", import.meta.url).pathname;

const app = await startHermeticApp({ workerPort: WORKER_PORT });
const APP_URL = process.argv[2] ?? app.origin;

const trace = (step: string) => console.error(`[shell-e2e] ${step}`);

const chrome = await openCdpTarget({
	port: PORT,
	userDataDir: `${process.env.TMPDIR ?? "/tmp"}/smithers-shell-e2e-profile`,
	url: APP_URL,
	extraArgs: ["--window-size=1400,900"],
}).catch((error: unknown) => {
	app.stop();
	console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
const cdp = await connectCdp(chrome.socketUrl);

const shot = async (name: string): Promise<void> => {
	const result = await cdp.send("Page.captureScreenshot", { format: "png" });
	const data = result?.data;
	if (typeof data !== "string") return;
	await Bun.write(`${SHOTS}${name}.png`, Buffer.from(data, "base64"));
};

const done = (code: number): never => {
	cdp.close();
	chrome.kill();
	app.stop();
	process.exit(code);
};

const fail = async (reason: string): Promise<never> => {
	await shot("FAIL").catch(() => {});
	const text = await cdp.evaluate("document.body.innerText").catch(() => "<unavailable>");
	console.error(`FAIL: ${reason}\n---- page text ----\n${text}`);
	return done(1);
};

await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Network.enable");
await cdp.send("Network.setExtraHTTPHeaders", { headers: { cookie: app.cookie } });
await cdp.send("Storage.clearDataForOrigin", {
	origin: new URL(APP_URL).origin,
	storageTypes: CLEARABLE_STORAGE,
});
await cdp.send("Page.navigate", { url: APP_URL });

trace("waiting for the composer to mount");
let ready = false;
for (let attempt = 0; attempt < 80 && !ready; attempt += 1) {
	ready = (await cdp.evaluate("document.querySelector('textarea') !== null").catch(() => false)) === true;
	if (!ready) await wait(250);
}
if (!ready) await fail("The composer never mounted.");

/*
 * The one measurement the whole contract turns on. `visible` is a real layout
 * question (rendered, non-zero box, not display:none) rather than a source
 * question, and `stamped` proves node identity across transitions.
 */
const STAMP = `
(() => {
  const transcript = document.querySelector('.smithers-transcript');
  const composer = document.querySelector('.smithers-composer');
  const textarea = document.querySelector('textarea');
  if (!transcript || !composer || !textarea) return false;
  transcript.__shellStamp = 'transcript';
  composer.__shellStamp = 'composer';
  textarea.__shellStamp = 'textarea';
  return true;
})()`;

const PROBE = `
(() => {
  const box = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { w: Math.round(rect.width), h: Math.round(rect.height) };
  };
  const visible = (node) => {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
  };
  const transcript = document.querySelector('.smithers-transcript');
  const composer = document.querySelector('.smithers-composer');
  const textarea = document.querySelector('textarea');
  const pane = document.querySelector('.embedded-pane');
  const frame = document.querySelector('.chat-frame');
  return {
    transcriptVisible: visible(transcript),
    composerVisible: visible(composer),
    textareaVisible: visible(textarea),
    transcriptStamped: transcript ? transcript.__shellStamp === 'transcript' : false,
    composerStamped: composer ? composer.__shellStamp === 'composer' : false,
    textareaStamped: textarea ? textarea.__shellStamp === 'textarea' : false,
    transcriptBox: box(transcript),
    paneBox: box(pane),
    // Where the pane sits relative to the conversation: beside it on a wide
    // window, stacked under it on a narrow one. Either way it is beside/below,
    // never on top of and never instead of.
    paneStacked: pane && composer
      ? pane.getBoundingClientRect().top >= composer.getBoundingClientRect().bottom - 1
      : null,
    pane: frame ? (frame.dataset.pane ?? 'none') : 'no-frame',
    paneClass: pane ? pane.className : null,
    paneVisible: visible(pane),
    closeFlow: pane ? (pane.querySelector('[data-flow]')?.dataset.flow ?? null) : null,
    // "Clear close affordance" is a hit-test question, not a markup question:
    // a button covered by the fixed corner chrome is in the DOM, passes every
    // node assertion, and still cannot be clicked by a person.
    headerButtonsCovered: pane
      ? [...pane.querySelectorAll('.surface-header button')].flatMap((button) => {
          const rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(
            Math.round(rect.left + rect.width / 2),
            Math.round(rect.top + rect.height / 2),
          );
          return hit && button.contains(hit)
            ? []
            : [(button.getAttribute('aria-label') ?? button.innerText ?? 'button') + ' <- ' +
               (hit ? (hit.closest('[class]')?.className ?? hit.tagName) : 'nothing')];
        })
      : [],
    // A narrowed chat column must not gain a horizontal scrollbar.
    transcriptOverflowsX: transcript ? transcript.scrollWidth > transcript.clientWidth + 1 : false,
    draft: textarea ? textarea.value : null,
    transcriptText: transcript ? transcript.innerText : '',
    registry: (document.querySelector('.app-shell')?.dataset.flows ?? '').split(' '),
  };
})()`;

const probe = async (): Promise<any> => await cdp.evaluate(PROBE);

const clickFlow = async (selector: string): Promise<void> => {
	const clicked = await cdp.evaluate(`
    (() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      node.click();
      return true;
    })()`);
	if (clicked !== true) await fail(`No affordance matched ${selector}.`);
	await wait(350);
};

/*
 * §2c′: the surface buttons collapsed into ONE dropdown beside the composer.
 * `.composer-actions [data-flow="connect"]` still resolves — but to the
 * repository-connections trigger, which opens a different menu and never opens
 * the Connectors pane. Open the surfaces menu and invoke its entry, exactly as
 * src/mainview/state/ChatShell.test.tsx does.
 */
const SURFACES_LIST = '.composer-menu-list[aria-label="Surfaces"]';
const openSurface = async (flow: "connect" | "world"): Promise<void> => {
	await clickFlow(".composer-menu-trigger");
	await clickFlow(`${SURFACES_LIST} .composer-menu-item[data-flow="${flow}"]`);
};

// ---------------------------------------------------------------------------
// 1. Send a message, and leave a draft in the composer behind it.
// ---------------------------------------------------------------------------
trace("sending a message");
await cdp.evaluate("document.querySelector('textarea').focus()");
await cdp.typeText(MESSAGE);
await cdp.typeKey("Enter", "Enter", 13);
await wait(1200);

let state = await probe();
if (!state.transcriptText.includes(MESSAGE)) {
	await fail(`The sent message never reached the transcript. Saw: ${state.transcriptText.slice(0, 400)}`);
}
console.log(`ok: the message is in the transcript.`);

trace("leaving a draft in the composer");
await cdp.evaluate("document.querySelector('textarea').focus()");
await cdp.typeText(DRAFT);
await wait(250);
state = await probe();
if (state.draft !== DRAFT) await fail(`The draft did not land in the composer: ${JSON.stringify(state.draft)}`);

await cdp.evaluate(STAMP);
await shot("1-chat");

const requireShell = async (label: string, expectedPane: string): Promise<any> => {
	const current = await probe();
	const problems: Array<string> = [];
	if (!current.transcriptVisible) problems.push("the transcript is not visible");
	if (!current.composerVisible) problems.push("the composer is not visible");
	if (!current.textareaVisible) problems.push("the composer input is not visible");
	if (!current.transcriptStamped) problems.push("the transcript node was unmounted and rebuilt");
	if (!current.composerStamped) problems.push("the composer node was unmounted and rebuilt");
	if (!current.textareaStamped) problems.push("the composer input was unmounted and rebuilt");
	if (current.pane !== expectedPane) problems.push(`data-pane is ${current.pane}, expected ${expectedPane}`);
	if (!current.transcriptText.includes(MESSAGE)) problems.push("the sent message is gone from the transcript");
	if (current.draft !== DRAFT) problems.push(`the draft changed to ${JSON.stringify(current.draft)}`);
	if (current.transcriptOverflowsX === true) {
		problems.push("the transcript scrolls horizontally at this width");
	}
	if (expectedPane === "none") {
		if (current.paneVisible) problems.push("a pane is still on screen after closing it");
	} else {
		if (!current.paneVisible) problems.push("the pane did not open");
		if (current.closeFlow !== "chat") {
			problems.push(`the pane's close affordance names ${current.closeFlow}, not the chat flow`);
		}
		if ((current.headerButtonsCovered ?? []).length > 0) {
			problems.push(`pane chrome is covered and unclickable: ${current.headerButtonsCovered.join(", ")}`);
		}
		if (!current.registry.includes("chat")) problems.push("`chat` is not in the live flow registry");
	}
	if (problems.length > 0) await fail(`${label}: ${problems.join("; ")}`);
	console.log(
		`ok: ${label} — transcript ${current.transcriptBox?.w}x${current.transcriptBox?.h} and composer stay mounted and visible` +
			(expectedPane === "none" ? "." : `, pane ${current.paneBox?.w}x${current.paneBox?.h} beside them.`),
	);
	return current;
};

await requireShell("chat only", "none");

// ---------------------------------------------------------------------------
// 2-3. Connectors: open from its real menu entry, close from the pane's affordance.
// ---------------------------------------------------------------------------
trace("opening Connectors");
await openSurface("connect");
const connectors = await requireShell("Connectors open", "connectors");
if (!String(connectors.paneClass).includes("connectors-surface")) {
	await fail(`The Connectors pane is not the connectors surface: ${connectors.paneClass}`);
}
await shot("2-connectors-open");

trace("closing Connectors from the pane's back-to-conversation affordance");
await clickFlow('.embedded-pane [data-flow="chat"]');
await requireShell("Connectors closed", "none");
await shot("3-connectors-closed");

// ---------------------------------------------------------------------------
// 4. World: same round trip.
// ---------------------------------------------------------------------------
trace("opening World");
await openSurface("world");
const world = await requireShell("World open", "world");
if (!String(world.paneClass).includes("world-surface")) {
	await fail(`The World pane is not the world surface: ${world.paneClass}`);
}
await shot("4-world-open");

trace("closing World");
await clickFlow('.embedded-pane [data-flow="chat"]');
const final = await requireShell("World closed", "none");
await shot("5-world-closed");

// ---------------------------------------------------------------------------
// 5. Nothing was lost, and the composer still works after the round trip.
// ---------------------------------------------------------------------------
if (!final.transcriptText.includes(MESSAGE)) {
	await fail("The conversation did not survive the pane round trip.");
}
trace("proving the composer still sends after the round trip");
await cdp.evaluate("document.querySelector('textarea').focus()");
await cdp.typeKey("Enter", "Enter", 13);
await wait(1200);
const sent = await probe();
if (!sent.transcriptText.includes(DRAFT)) {
	await fail(`The composer stopped working after the pane round trip. Transcript: ${sent.transcriptText.slice(0, 400)}`);
}
if (sent.draft !== "") await fail(`The composer did not clear after sending: ${JSON.stringify(sent.draft)}`);
if (!sent.transcriptText.includes(MESSAGE)) await fail("The first message vanished on the second send.");
await shot("6-sent-after-round-trip");

console.log("ok: the draft left before the panes sent as a real turn afterwards.");

// ---------------------------------------------------------------------------
// 6. The narrow window stacks instead of splitting — and still never replaces
//    the conversation. This is the branch where a naive split silently becomes
//    a takeover, because 58% of a 700px window leaves no readable chat.
// ---------------------------------------------------------------------------
trace("re-checking the contract on a narrow window");
await cdp.evaluate(`document.querySelector('textarea').value; true`);
await cdp.send("Emulation.setDeviceMetricsOverride", {
	width: 700,
	height: 900,
	deviceScaleFactor: 1,
	mobile: false,
});
await wait(400);
await cdp.evaluate("document.querySelector('textarea').focus()");
await cdp.typeText(DRAFT);
await wait(250);
await cdp.evaluate(STAMP);

for (const [flow, label] of [
	["connect", "Connectors"],
	["world", "World"],
] as const) {
	await openSurface(flow);
	const narrow = await probe();
	const problems: Array<string> = [];
	if (!narrow.transcriptVisible) problems.push("the transcript is not visible");
	if (!narrow.textareaVisible) problems.push("the composer input is not visible");
	if (!narrow.transcriptStamped || !narrow.textareaStamped) problems.push("the chat was rebuilt");
	if (narrow.paneStacked !== true) problems.push("the pane is not stacked below the conversation");
	if (narrow.draft !== DRAFT) problems.push(`the draft changed to ${JSON.stringify(narrow.draft)}`);
	if ((narrow.headerButtonsCovered ?? []).length > 0) {
		problems.push(`pane chrome is covered: ${narrow.headerButtonsCovered.join(", ")}`);
	}
	if (problems.length > 0) await fail(`${label} on a 700px window: ${problems.join("; ")}`);
	console.log(
		`ok: ${label} on a 700px window — pane ${narrow.paneBox?.w}x${narrow.paneBox?.h} stacks under a live ${narrow.transcriptBox?.w}x${narrow.transcriptBox?.h} conversation.`,
	);
	await shot(`7-narrow-${flow}`);
	await clickFlow('.embedded-pane [data-flow="chat"]');
}
await cdp.send("Emulation.clearDeviceMetricsOverride");

console.log(`ok: screenshots written to ${SHOTS}`);
console.log("PASS: World and Connectors open as embedded panes; the chat is never replaced.");

done(0);
