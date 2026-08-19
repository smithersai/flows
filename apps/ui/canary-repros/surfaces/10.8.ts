/*
 * Repro — checklist row 10.8 ("The world content actually reaches the model —
 * ask about something only a note says") against https://canary.smithers.sh.
 *
 * A codeword written into a World note is invisible to the model. The agent
 * runtime context (apps/shared/src/AgentContext.ts) carries only each world
 * document's `path`, `title` and `confidence` — never its `body` — and no tool
 * reads a world note, so the model answers that it cannot retrieve the value.
 *
 *   bun 10.8.ts       exit 1 while the bug is present, 0 once it is fixed.
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.PROF ?? "/tmp/canary-surfaces-profile";
const CODEWORD = `zarquon-${Date.now().toString(36)}`;

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 1000 } });
const page = context.pages()[0] ?? (await context.newPage());
/*
 * Start from an empty transcript: the app persists cards to OPFS, and an
 * earlier run's copy in the body text would confuse both the answer check and
 * the rate-limit guard below. Cookies are deliberately not cleared.
 */
await page.goto("about:blank", { waitUntil: "domcontentloaded" });
const cdp = await context.newCDPSession(page);
await cdp.send("Storage.clearDataForOrigin", {
	origin: new URL(BASE).origin,
	storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers",
});
await cdp.detach().catch(() => {});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);

const composer = page.locator("textarea.sui-chat-composer-input");
const runFlow = async (flow: string): Promise<void> => {
	await composer.click();
	await composer.fill(flow);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(2000);
};
/** `/world` and `/chat` toggle the pane, so drive them to a known state. */
const openWorld = async (): Promise<boolean> => {
	for (let attempt = 0; attempt < 3; attempt++) {
		if ((await page.locator("section.world-surface").count()) > 0) return true;
		await runFlow("/world");
	}
	return (await page.locator("section.world-surface").count()) > 0;
};
if (!(await openWorld())) {
	console.error("FAIL(setup): the World pane never opened.");
	await context.close();
	process.exit(2);
}
if ((await page.locator(".world-sidebar .sui-file-tree-file").count()) === 0) {
	await page.locator("section.world-surface .surface-header button:has-text('New note')").click();
	await page.waitForTimeout(2500);
}
await page.locator(".world-sidebar .sui-file-tree-file").first().click();
await page.waitForTimeout(1200);

const editor = page.locator(".world-document .ProseMirror");
await editor.click();
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.press("Backspace");
await page.keyboard.type(`Project glossary. The canary codeword for this workspace is ${CODEWORD}. Nothing else records it.`, {
	delay: 15,
});
await page.waitForTimeout(3000);
console.log("note body:", JSON.stringify((await editor.innerText()).trim()));

await runFlow("/chat");
await composer.click();
await composer.fill("What is the canary codeword for this workspace? Answer with only the codeword.");
await page.keyboard.press("Enter");
await page.waitForTimeout(25000);

const body = await page.locator("body").innerText();
await page.screenshot({ path: "/tmp/canary-10.8.png", fullPage: true });
/*
 * The product Worker rate-limits a session at 120 turns an hour and renders
 * that as the closed-alpha copy, which would otherwise read as this bug. Treat
 * a gated turn as a setup failure, never as evidence.
 */
const gated = body.includes("open to design partners only") || body.includes("something is looping");
if (gated) {
	console.error("SETUP: the session is turn-rate-limited (120/hour) — rerun after the window resets.");
	process.exit(2);
}
const answered = body.includes(CODEWORD);
console.log("the reply contains the codeword:", answered);
console.log("transcript tail:\n" + body.slice(-700));
console.log("screenshot: /tmp/canary-10.8.png");
await context.close();

if (!answered) {
	console.error(`FAIL: the note says the codeword is ${CODEWORD}, and the model could not read it — world content does not reach the model.`);
	process.exit(1);
}
console.log("PASS: the model answered from the world note.");
