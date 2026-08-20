/*
 * Checklist 18.1 / 18.3 / 18.5 — the BYOK keys seam.
 *
 * The bug: the product Worker proxies `/api/user/byok-keys` to
 * SMITHERS_CLOUD_API_BASE_URL (api.jjhub.tech), which has no such route, so
 * every keys flow answers 404 — and the UI renders NOTHING for it: no keys
 * card, no transcript line, no toast.
 *
 *   bun canary-repros/money/18.1.ts
 */
import { chromium } from "playwright";
import { BASE, PROFILE, ensureSignedIn, report, seam, sendPrompt } from "./_lib";

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 950 } });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
await ensureSignedIn(page);
await page.waitForTimeout(2500);

const failures: Array<string> = [];

const list = await seam(page, "/api/user/byok-keys");
if (list.status !== 200) failures.push(`GET /api/user/byok-keys → HTTP ${list.status} ${list.text.trim().slice(0, 80)}`);

const before = await page.locator("body").innerText();
await sendPrompt(page, "/keys.list");
await page.waitForTimeout(7000);
const after = await page.locator("body").innerText();
const card = await page.evaluate(() => {
	const element = document.querySelector('[data-kind="keys"]');
	return element === null ? null : (element as HTMLElement).innerText;
});
if (card === null) failures.push("/keys.list rendered no keys card");
if (after === before) failures.push("/keys.list changed nothing on screen — no card, no message, no toast");

/* 18.5: removing a provider that has no key must say so, not go silent. */
const beforeRemove = await page.locator("body").innerText();
await sendPrompt(page, "/keys.remove openai");
await page.waitForTimeout(7000);
if ((await page.locator("body").innerText()) === beforeRemove) {
	failures.push("/keys.remove openai (no such key) changed nothing on screen");
}

/* 18.5, second half: no provider named at all. */
const beforeBare = await page.locator("body").innerText();
await sendPrompt(page, "/keys.remove");
await page.waitForTimeout(5000);
if ((await page.locator("body").innerText()) === beforeBare) {
	failures.push('/keys.remove with no provider never surfaced "keys.remove needs the provider name"');
}

await page.screenshot({ path: "/tmp/money-18.1.png", fullPage: true });
await context.close();
report(failures);
