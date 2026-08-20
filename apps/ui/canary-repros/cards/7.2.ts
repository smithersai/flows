/*
 * Repro for MANUAL-REVIEW-CHECKLIST row 7.2 (`card.maximize` /
 * `card.minimize`) on https://canary.smithers.sh.
 *
 * The three behaviours the row names do work: the card maximizes, Escape
 * minimizes it, and focus lands back on the card's own maximize button. What
 * fails is the geometry. A maximized card is laid out 1280px wide starting at
 * x=24 in a 1280px viewport, so it hangs 24px off the right edge. The document
 * cannot scroll horizontally, so the overhang is unreachable: the card's own
 * minimize button and every right-aligned action button inside it are clipped.
 *
 * Exits non-zero while the maximized card overflows the viewport.
 *
 *   bun apps/ui/canary-repros/cards/7.2.ts
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.CARDS_PROFILE ?? "/tmp/canary-cards-profile";
const VIEWPORT = { width: 1280, height: 900 };

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: VIEWPORT });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);

/* Any card will do; the balance card is the cheapest one to produce. */
const composer = page.locator("textarea").first();
await composer.click();
await composer.fill("");
await page.keyboard.type("/billing.balance", { delay: 8 });
await page.keyboard.press("Enter");
await page.waitForTimeout(7000);

const card = page.locator('[data-kind="balance"]').last();
await card.locator('[data-flow="card.maximize"]').click();
await page.waitForTimeout(1200);

const maximized = await card.getAttribute("data-maximized");
const box = await card.evaluate((node) => {
	const rect = node.getBoundingClientRect();
	return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
});
const viewport = await page.evaluate(() => ({
	clientWidth: document.documentElement.clientWidth,
	scrollWidth: document.documentElement.scrollWidth,
}));
const minimizeBox = await card.locator('[data-flow="card.minimize"]').boundingBox();

console.log(`data-maximized: ${maximized}`);
console.log(`card box: ${JSON.stringify(box)}`);
console.log(`viewport: ${JSON.stringify(viewport)}`);
console.log(`minimize button box: ${JSON.stringify(minimizeBox)}`);

await page.screenshot({ path: "/tmp/canary-cards-7.2-maximized.png" });

/* The row's own three assertions, checked so a fix cannot regress them. */
const focusAfterMaximize = await page.evaluate(() => document.activeElement?.getAttribute("data-flow") ?? null);
await page.keyboard.press("Escape");
await page.waitForTimeout(1200);
const afterEscape = await card.getAttribute("data-maximized");
const focusAfterEscape = await page.evaluate(() => document.activeElement?.getAttribute("data-flow") ?? null);
console.log(`focus after maximize: ${focusAfterMaximize}; after Escape: ${focusAfterEscape}; data-maximized: ${afterEscape}`);

await context.close();

const overhang = box.right - viewport.clientWidth;
const minimizeClipped = minimizeBox !== null && minimizeBox.x + minimizeBox.width > viewport.clientWidth;

if (afterEscape !== "false") {
	console.error("FAIL 7.2: Escape did not minimize the card.");
	process.exit(1);
}
if (focusAfterEscape !== "card.maximize") {
	console.error(`FAIL 7.2: focus after Escape was ${String(focusAfterEscape)}, not the card's maximize button.`);
	process.exit(1);
}
if (overhang > 0) {
	console.error(
		`FAIL 7.2: the maximized card is ${box.width}px wide at x=${box.left} in a ${viewport.clientWidth}px viewport — it hangs ${overhang}px off the right edge` +
			(minimizeClipped ? ", clipping its own minimize button" : "") +
			", and the document cannot scroll horizontally to reach it.",
	);
	process.exit(1);
}
console.log("PASS 7.2: the maximized card fits the viewport, Escape minimizes it, and focus returns to the card.");
