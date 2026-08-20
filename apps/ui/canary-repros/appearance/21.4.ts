/*
 * Canary repro — MANUAL-REVIEW-CHECKLIST §21.4
 * "Escape has one meaning per context and the precedence is right: stop turn
 *  while typing -> minimize maximized card -> dismiss recommendation ->
 *  close menu."
 *
 * Three of the four steps are right. The fourth is not: closing the menu is
 * handled ONLY by the menu's own keydown handler, so it works while focus is
 * inside the menu and nowhere else. Move focus out of an open menu (Tab, or
 * any other control) and Escape skips "close menu" entirely and dismisses the
 * recommendation instead — the menu stays open, and the recommendation the
 * user did not mean to touch is gone (and suppressed for 7 days).
 *
 * Run:  bun canary-repros/appearance/21.4.ts
 * Exits 1 while the precedence is wrong.
 *
 * NOTE: this repro dismisses a recommendation for the signed-in login. Restore
 * it with the admin door: DELETE /api/admin/reco-dismissals?login=<login>.
 */
import { chromium } from "playwright";
import { resetPersistedStore } from "../../scripts/live-store-reset.ts";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.APPEARANCE_PROFILE ?? "/tmp/canary-appearance-profile";

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1280, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await resetPersistedStore(context, page, BASE);
await page.waitForTimeout(5000);

const state = () =>
	page.evaluate(() => ({
		menu: document.querySelectorAll('[role="menu"]').length,
		minimize: document.querySelectorAll('[data-flow="card.minimize"]').length,
		reco: document.querySelectorAll('section[data-kind="reco"]').length,
		busy: document.querySelector("[aria-busy]")?.getAttribute("aria-busy") ?? null,
		focus:
			(document.activeElement as HTMLElement | null)?.getAttribute("aria-label") ??
			(document.activeElement as HTMLElement | null)?.tagName ??
			null,
	}));

const failures: Array<string> = [];
const check = (label: string, ok: boolean, detail: string): void => {
	console.log(`${ok ? "ok  " : "FAIL"}: ${label} — ${detail}`);
	if (!ok) failures.push(label);
};

const baseline = await state();
console.log(`baseline: ${JSON.stringify(baseline)}`);
if (baseline.reco === 0) {
	console.error("setup failed: no recommendation card in the transcript.");
	console.error("Clear the 7-day suppression first: DELETE /api/admin/reco-dismissals?login=<login> (admin session).");
	await context.close();
	process.exit(2);
}

// step 2 of the precedence: a maximized card beats the recommendation.
await page.locator('[data-flow="card.maximize"]').first().focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(900);
const maximized = await state();
await page.keyboard.press("Escape");
await page.waitForTimeout(1000);
const afterMaximized = await state();
check(
	"Escape minimizes a maximized card and leaves the recommendation alone",
	maximized.minimize === 1 && afterMaximized.minimize === 0 && afterMaximized.reco === maximized.reco,
	JSON.stringify(afterMaximized),
);

// step 4 of the precedence: an open menu.
await page.locator('[data-flow="surfaces"]').first().focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(800);
const opened = await state();
check("the surfaces menu opens from the keyboard", opened.menu === 1, JSON.stringify(opened));

// Escape while focus is still INSIDE the menu — this half works.
await page.keyboard.press("Escape");
await page.waitForTimeout(800);
const closedFromInside = await state();
check(
	"Escape closes the menu when focus is inside it",
	closedFromInside.menu === 0 && closedFromInside.reco === opened.reco,
	JSON.stringify(closedFromInside),
);

// Reopen, move focus out of the menu the way Tab does, and press Escape.
await page.locator('[data-flow="surfaces"]').first().focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(800);
await page.locator('[data-flow="copy-message"]').first().focus();
await page.waitForTimeout(400);
const reopened = await state();
check("the menu is still open with focus elsewhere in the shell", reopened.menu === 1, JSON.stringify(reopened));
await page.keyboard.press("Escape");
await page.waitForTimeout(1400);
const afterOutside = await state();
await page.screenshot({ path: "/tmp/appearance-shots/21.4-menu-open-reco-dismissed.png" });
check(
	"Escape closes the open menu rather than dismissing the recommendation",
	afterOutside.menu === 0 && afterOutside.reco === reopened.reco,
	`menu ${reopened.menu} -> ${afterOutside.menu}, reco ${reopened.reco} -> ${afterOutside.reco}`,
);

// Tab out of an open menu leaves the document entirely, which is how a user
// reaches the broken state without touching the mouse. The previous step may
// have left the menu open, so drive it to a known-open state first.
await page.locator('[data-flow="surfaces"]').first().focus();
if ((await state()).menu === 1) {
	await page.keyboard.press("Enter");
	await page.waitForTimeout(600);
}
await page.keyboard.press("Enter");
await page.waitForTimeout(800);
await page.keyboard.press("Tab");
await page.waitForTimeout(400);
const tabbedOut = await state();
check(
	"Tab from inside an open menu does not strand focus on <body> with the menu still open",
	!(tabbedOut.menu === 1 && tabbedOut.focus === "BODY"),
	JSON.stringify(tabbedOut),
);

await context.close();
console.log("\n--- §21.4 ---");
console.log("expected: stop turn -> minimize card -> dismiss recommendation -> close menu, in that order, from anywhere");
console.log("actual:   'close menu' is only reachable while focus is inside the menu; otherwise Escape falls through");
console.log("          to 'dismiss recommendation' and the menu stays open");
if (failures.length > 0) {
	console.error(`FAIL §21.4 — ${failures.join("; ")}`);
	process.exit(1);
}
console.log("pass §21.4");
