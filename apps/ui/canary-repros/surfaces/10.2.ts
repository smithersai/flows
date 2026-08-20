/*
 * Repro — checklist row 10.2 ("`world.new-note` creates a note and focuses it")
 * against https://canary.smithers.sh.
 *
 * The note is created and selected. Focus is NOT moved into it: it stays on the
 * "New note" button in the World pane header, so a user who types immediately
 * after creating a note types nothing into the note.
 *
 *   bun 10.2.ts       exit 1 while the bug is present, 0 once it is fixed.
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.PROF ?? "/tmp/canary-surfaces-profile";
const PROBE = `focus-probe-${Date.now()}`;

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 1000 } });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);

/** `/world` toggles, so open it only when the pane is absent. */
const openWorld = async (): Promise<boolean> => {
	for (let attempt = 0; attempt < 3; attempt++) {
		if ((await page.locator("section.world-surface").count()) > 0) return true;
		const composer = page.locator("textarea.sui-chat-composer-input");
		await composer.click();
		await composer.fill("/world");
		await page.keyboard.press("Enter");
		await page.waitForTimeout(2000);
	}
	return (await page.locator("section.world-surface").count()) > 0;
};
if (!(await openWorld())) {
	console.error("FAIL(setup): the World pane never opened.");
	await context.close();
	process.exit(2);
}

const titles = async (): Promise<Array<string>> => page.locator(".world-sidebar .sui-file-tree-file").allInnerTexts();
const before = await titles();
await page.locator("section.world-surface .surface-header button:has-text('New note')").click();
await page.waitForTimeout(2500);
const after = await titles();
console.log("notes before:", before);
console.log("notes after :", after);

const focus = await page.evaluate(() => {
	const element = document.activeElement as HTMLElement | null;
	return {
		tag: element?.tagName ?? null,
		className: element?.className?.toString().slice(0, 70) ?? null,
		insideEditor: element?.closest(".sui-markdown-editor") !== null && element?.closest(".sui-markdown-editor") !== undefined,
	};
});
console.log("document.activeElement after world.new-note:", JSON.stringify(focus));

// The behavioural consequence: type without clicking and see where it lands.
await page.keyboard.type(PROBE, { delay: 25 });
await page.waitForTimeout(1500);
const documentText = (await page.locator(".world-document .ProseMirror").innerText()).trim();
console.log("new note's body after typing:", JSON.stringify(documentText.slice(0, 120)));
await page.screenshot({ path: "/tmp/canary-10.2.png", fullPage: true });
console.log("screenshot: /tmp/canary-10.2.png");
await context.close();

const created = after.length === before.length + 1;
const typedIntoNote = documentText.includes(PROBE);
if (created && !typedIntoNote) {
	console.error(
		"FAIL: the note was created but focus stayed on the New note button — typing straight after creation does not reach the note.",
	);
	process.exit(1);
}
if (!created) {
	console.error("FAIL: world.new-note did not create a note.");
	process.exit(1);
}
console.log("PASS: world.new-note created the note and focused it.");
