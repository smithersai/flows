/*
 * Canary repro — MANUAL-REVIEW-CHECKLIST §21.2
 * "Tab order is sane on every surface; no focus trap; no unreachable control."
 *
 * Chat and connectors are clean: every visible focusable is reached by Tab, in
 * document order, and Shift+Tab walks back out to <body>.
 *
 * The world editor is not. Once focus is inside `.ProseMirror`, Tab is consumed
 * by the editor: focus never advances, and every press INSERTS whitespace into
 * the note. Forward Tab is a one-way trap — the only way out is Shift+Tab, which
 * a keyboard user has no reason to try, and by then the document is damaged.
 *
 * This script restores the note's original text before exiting.
 *
 * Run:  bun canary-repros/appearance/21.2.ts
 * Exits 1 while Tab is trapped in the editor.
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.APPEARANCE_PROFILE ?? "/tmp/canary-appearance-profile";

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1280, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);

const run = async (command: string): Promise<void> => {
	const composer = page.locator("textarea").first();
	await composer.click();
	await composer.fill(command);
	await composer.press("Enter");
	await page.waitForTimeout(1200);
};
const active = () =>
	page.evaluate(() => {
		const element = document.activeElement as HTMLElement | null;
		if (element === null) return null;
		return {
			tag: element.tagName,
			role: element.getAttribute("role"),
			prosemirror: element.classList.contains("ProseMirror"),
			name: (element.getAttribute("aria-label") ?? element.innerText ?? "").trim().slice(0, 30).replace(/\n/g, " "),
		};
	});
const noteText = () => page.evaluate(() => (document.querySelector(".ProseMirror") as HTMLElement | null)?.innerText ?? null);

// The world editor lives behind /world; the surface swap occasionally drops the
// dispatch, so retry rather than fail the run on a race.
for (let attempt = 0; attempt < 4; attempt += 1) {
	await run("/world");
	await page.waitForTimeout(4000);
	if ((await page.locator(".ProseMirror").count()) > 0) break;
	await run("/chat");
	await page.waitForTimeout(1000);
}
if ((await page.locator(".ProseMirror").count()) === 0) {
	console.error("setup failed: the world editor never rendered .ProseMirror");
	await context.close();
	process.exit(2);
}

const original = await noteText();
console.log(`note before: ${JSON.stringify(original)}`);

await page.locator(".ProseMirror").first().click();
await page.waitForTimeout(500);
console.log(`focused: ${JSON.stringify(await active())}`);

const forward: Array<unknown> = [];
for (let index = 0; index < 5; index += 1) {
	await page.keyboard.press("Tab");
	await page.waitForTimeout(200);
	forward.push({ press: index + 1, active: await active(), note: (await noteText())?.trim().slice(0, 40) });
}
for (const entry of forward) console.log(`  ${JSON.stringify(entry)}`);

const trapped = forward.every((entry) => (entry as { active: { prosemirror: boolean } }).active.prosemirror);
const damaged = (await noteText()) !== original;

await page.keyboard.press("Shift+Tab");
await page.waitForTimeout(300);
const escaped = await active();
console.log(`Shift+Tab escapes to: ${JSON.stringify(escaped)}`);

// Put the note back the way it was found.
if (damaged && original !== null) {
	await page.locator(".ProseMirror").first().click();
	await page.waitForTimeout(300);
	await page.keyboard.press("Meta+a");
	await page.waitForTimeout(200);
	await page.keyboard.press("Backspace");
	await page.waitForTimeout(300);
	await page.keyboard.type(original.trim());
	await page.waitForTimeout(2500);
	console.log(`note restored to: ${JSON.stringify(await noteText())}`);
}
await page.screenshot({ path: "/tmp/appearance-shots/21.2-world-editor-trap.png" });
await context.close();

console.log("\n--- §21.2 ---");
console.log("expected: Tab moves focus out of the world editor to the next control");
console.log(`actual:   focus stays on .ProseMirror for all 5 presses (trapped=${trapped}) and the note text changes (damaged=${damaged})`);
console.log(`          Shift+Tab does leave, to ${escaped?.name ?? "?"}`);
if (trapped || damaged) {
	console.error("FAIL §21.2 — forward Tab is trapped in the world editor and mutates the note");
	process.exit(1);
}
console.log("pass §21.2");
