/*
 * Checklist 18.3 — "`/keys.remove <provider>` removes it and the change
 * survives a reload."
 *
 * The bug: DELETE /api/user/byok-keys/{provider} answers 404 (the jjhub
 * platform has no BYOK route), the UI shows nothing, and there is no key list
 * to survive a reload — the keys card never renders at all, before or after.
 *
 *   bun canary-repros/money/18.3.ts
 */
import { chromium } from "playwright";
import { BASE, PROFILE, ensureSignedIn, report, seam, sendPrompt } from "./_lib";

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 950 } });
const page = context.pages()[0] ?? (await context.newPage());
const deletes: Array<string> = [];
page.on("response", (response) => {
	if (response.request().method() === "DELETE" && /byok-keys/.test(response.url())) {
		deletes.push(`DELETE ${new URL(response.url()).pathname} → ${response.status()}`);
	}
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
await ensureSignedIn(page);
await page.waitForTimeout(2500);

const failures: Array<string> = [];
const keysCard = () =>
	page.evaluate(() => {
		const element = document.querySelector('[data-kind="keys"]');
		return element === null ? null : (element as HTMLElement).innerText;
	});

const before = await page.locator("body").innerText();
await sendPrompt(page, "/keys.remove anthropic");
await page.waitForTimeout(7000);
const removal = await seam(page, "/api/user/byok-keys/anthropic", { method: "DELETE" });
if (removal.status !== 200 && removal.status !== 204) {
	failures.push(`DELETE /api/user/byok-keys/anthropic → HTTP ${removal.status} ${removal.text.trim().slice(0, 60)}`);
}
if (deletes.length > 0 && !deletes.every((entry) => /→ (200|204)/.test(entry))) {
	failures.push(`the flow's own removal call failed: ${deletes.join("; ")}`);
}
if ((await page.locator("body").innerText()) === before) {
	failures.push("/keys.remove anthropic changed nothing on screen — no card, no message, no toast");
}

/* The reload half: the keys card must be renderable at all for a removal to survive one. */
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
await sendPrompt(page, "/keys.list");
await page.waitForTimeout(7000);
if ((await keysCard()) === null) failures.push("after reload, /keys.list still renders no keys card, so no state survives");

await page.screenshot({ path: "/tmp/money-18.3.png", fullPage: true });
await context.close();
report(failures);
