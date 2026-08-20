/*
 * Repro — checklist row 24.1 (honesty lane, §24).
 *
 * "[gap] Client errors are only console.error. Decide whether the alpha ships
 *  without client error reporting; if it does, confirm no user-visible surface
 *  swallows an error silently."
 *
 * Half of this is CLOSED and verified live: the page really does post crashes
 * and unhandled rejections to POST /api/client-errors, and the canary really
 * does accept them (202). Appendix C's item 6 is correct.
 *
 * The second clause is not met. User-visible surfaces do swallow errors
 * silently. This repro drives the cleanest one: /prs.create with a real repo
 * and a real branch fires two backend reads and then says NOTHING — no message,
 * no card, no toast, and no console error either, so it is not even in the
 * client-error log.
 *
 *   bun canary-repros/honesty/24.1.ts
 *
 * Exits 1 while a user-visible surface swallows an error in silence.
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.PROF ?? "/tmp/canary-honesty-profile";

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1400, height: 1100 },
});
const page = context.pages()[0] ?? (await context.newPage());
const consoleErrors: Array<string> = [];
const reported: Array<string> = [];
const apiCalls: Array<string> = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("request", (r) => {
	const url = r.url();
	if (url.includes("/api/client-errors")) reported.push(String(r.postData()).slice(0, 160));
	else if (url.includes("/api/")) apiCalls.push(`${r.method()} ${url.replace(BASE, "")}`);
});

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);

/* ---- 1. the reporting half: it works ----------------------------------- */
await page.evaluate(() => {
	setTimeout(() => { Promise.reject(new Error("HONESTY-24.1-unhandled-rejection")); }, 50);
});
await page.waitForTimeout(2500);
await page.evaluate(() => {
	setTimeout(() => { throw new Error("HONESTY-24.1-window-error"); }, 50);
});
await page.waitForTimeout(4000);
console.log(`client-error reports posted: ${reported.length}`);
for (const report of reported) console.log(`  ${report}`);
const reportingWorks = reported.length >= 2;

/* ---- 2. the swallowing half: a surface that says nothing ---------------- */
apiCalls.length = 0;
consoleErrors.length = 0;
const before = await page.locator("body").innerText();
const TRIGGER =
	"/prs.create honesty 24.1 silent-swallow check from:codeplanesmithers-patch-1 codeplanesmithers/canary-sandbox";
const composer = page.locator("textarea.sui-chat-composer-input");
await composer.click();
await composer.fill(TRIGGER);
await composer.press("Enter");
await page.waitForTimeout(30_000);
const after = await page.locator("body").innerText();
const added = after
	.split("\n")
	.filter((line) => line.trim() !== "" && !before.includes(line.trim()));

console.log(`\ncomposer cleared (the submit fired): ${(await composer.inputValue()) === ""}`);
console.log(`backend reads it made: ${JSON.stringify([...new Set(apiCalls)])}`);
console.log(`lines it added to the UI: ${JSON.stringify(added)}`);
console.log(`console errors: ${JSON.stringify(consoleErrors)}`);
console.log(`client-error reports for it: ${reported.length - (reportingWorks ? 2 : 0)}`);
await page.screenshot({ path: "/tmp/honesty-repro-24.1.png", fullPage: true });
await context.close();
console.log("--- screenshot: /tmp/honesty-repro-24.1.png");

const failures: Array<string> = [];
if (!reportingWorks) {
	failures.push("the page did not post its crashes to /api/client-errors — Appendix C item 6 is not closed after all");
}
if (added.length === 0) {
	failures.push(
		`a user-visible surface swallowed a failure in silence: ${TRIGGER.split(" ")[0]} made ${apiCalls.length} backend read(s), rendered nothing, logged nothing, and reported nothing`,
	);
}
if (failures.length === 0) {
	console.log("PASS");
	process.exit(0);
}
for (const failure of failures) console.error(`FAIL: ${failure}`);
process.exit(1);
