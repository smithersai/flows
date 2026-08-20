/*
 * Repro — checklist row 23.4 (honesty lane, §23 Durability, interruption, resume).
 *
 * "Two tabs on the same session: state stays consistent; no duplicated cards or
 *  divergent transcripts."
 *
 * There is no cross-tab sync. A turn sent in tab A never reaches tab B: B's
 * transcript stays behind for as long as it is left open (45s measured, and the
 * shape is "never", not "slowly"). Only a reload of B reconciles it. Nothing is
 * duplicated and nothing is fabricated, but the two tabs show different
 * conversations at the same moment.
 *
 *   bun canary-repros/honesty/23.4.ts
 *
 * Exits 1 while tab B stays stale.
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.PROF ?? "/tmp/canary-honesty-profile";
/* A marker no earlier turn can contain. Date.now() is fine here — this is a script, not a workflow. */
const MARK = `TWOTAB${Date.now().toString(36).toUpperCase()}`;

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1300, height: 1000 },
});
const a = context.pages()[0] ?? (await context.newPage());
await a.goto(BASE, { waitUntil: "domcontentloaded" });
await a.waitForTimeout(4000);
const b = await context.newPage();
await b.goto(BASE, { waitUntil: "domcontentloaded" });
await b.waitForTimeout(6000);

const composer = a.locator("textarea.sui-chat-composer-input");
await composer.click();
await composer.fill(`Say exactly: ${MARK} and nothing else.`);
await composer.press("Enter");

let sawInB = false;
for (let elapsed = 10; elapsed <= 45; elapsed += 10) {
	await a.waitForTimeout(10_000);
	const inA = (await a.locator("body").innerText()).includes(MARK);
	const inB = (await b.locator("body").innerText()).includes(MARK);
	console.log(`t≈${elapsed}s  tabA=${inA}  tabB=${inB}`);
	if (inB) sawInB = true;
}

await b.screenshot({ path: "/tmp/honesty-repro-23.4-tabB-stale.png", fullPage: true });
await a.screenshot({ path: "/tmp/honesty-repro-23.4-tabA-live.png", fullPage: true });

await b.reload({ waitUntil: "domcontentloaded" });
await b.waitForTimeout(9000);
const afterReload = (await b.locator("body").innerText()).includes(MARK);
console.log(`tab B after an explicit reload: ${afterReload}`);
console.log("--- screenshots: /tmp/honesty-repro-23.4-tabA-live.png, /tmp/honesty-repro-23.4-tabB-stale.png");
await context.close();

if (sawInB) {
	console.log("PASS — the second tab received the turn without a reload.");
	process.exit(0);
}
console.error(
	`FAIL: tab A showed ${MARK} and tab B never did (45s). The two tabs showed different transcripts` +
		(afterReload ? "; only an explicit reload of B reconciled them." : "; a reload of B did not reconcile them either."),
);
process.exit(1);
