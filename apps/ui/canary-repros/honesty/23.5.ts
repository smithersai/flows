/*
 * Repro — checklist row 23.5 (honesty lane, §23).
 *
 * "/reset starts a fresh conversation and states that nothing is kept."
 *
 * On canary, typing /reset as an ordinary (non-admin) user does neither. The
 * flow is registered in `adminFlows` — it exists only for a session carrying
 * admin:true — so `parseSubmit` finds no such command, falls through to
 * "prompt", and hands the literal text "/reset" to the model. The model then
 * invoked an unrelated flow (`/retry`) and answered "What would you like to do
 * next?". The conversation was NOT cleared and nothing said so.
 *
 * The honest shapes would be either the reset itself, or "there is no /reset
 * here — /clear is the fresh-chat command". Silently running a different flow
 * is neither.
 *
 *   bun canary-repros/honesty/23.5.ts
 *
 * Exits 1 while /reset neither resets nor says it cannot.
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.PROF ?? "/tmp/canary-honesty-profile";

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1400, height: 1100 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);

const session = await page.evaluate(async () => (await fetch("/api/auth/session")).text());
console.log("session:", session);

/* Put a marker in the transcript so "was it cleared?" is decidable. */
const composer = page.locator("textarea.sui-chat-composer-input");
const MARK = `RESETMARK${Date.now().toString(36).toUpperCase()}`;
await composer.click();
await composer.fill(`Say exactly: ${MARK} and nothing else.`);
await composer.press("Enter");
await page.waitForTimeout(25_000);
const seeded = await page.locator("body").innerText();
console.log("marker seeded into the transcript:", seeded.includes(MARK));

await composer.click();
await composer.fill("/reset");
await composer.press("Enter");
await page.waitForTimeout(25_000);
const after = await page.locator("body").innerText();
await page.screenshot({ path: "/tmp/honesty-repro-23.5.png", fullPage: true });
await context.close();

const cleared = !after.includes(MARK);
const saidSomething = /nothing (is |was )?kept|fresh (conversation|chat)|no \/reset|not available|isn'?t available|can'?t/i.test(
	after.slice(after.lastIndexOf("/reset")),
);
console.log(`conversation cleared: ${cleared}`);
console.log(`the app said what happened: ${saidSomething}`);
console.log("--- what followed /reset ---");
console.log(after.slice(after.lastIndexOf("/reset"), after.lastIndexOf("/reset") + 400));
console.log("--- screenshot: /tmp/honesty-repro-23.5.png");

if (cleared) {
	console.log("PASS — /reset started a fresh conversation.");
	process.exit(0);
}
console.error(
	"FAIL: /reset did not clear the conversation" +
		(saidSomething ? ", though it did say something about it." : " and said nothing about why."),
);
process.exit(1);
