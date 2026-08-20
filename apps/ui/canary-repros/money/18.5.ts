/*
 * Checklist 18.5 — "`/keys.remove` for a provider with no key."
 *
 * The bug: two silent paths. With a provider that has no key the flow issues
 * DELETE /api/user/byok-keys/{provider}, gets 404 from the platform, and the
 * UI shows nothing. With NO provider named the seam's own refusal
 * ("keys.remove needs the provider name") is returned as a string that the
 * composer path throws away — `send` calls `commands.run` without
 * `surfaceCommandFailure`, so no toast and no transcript line appear.
 *
 *   bun canary-repros/money/18.5.ts
 */
import { chromium } from "playwright";
import { BASE, PROFILE, ensureSignedIn, report, sendPrompt } from "./_lib";

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 950 } });
const page = context.pages()[0] ?? (await context.newPage());
const calls: Array<string> = [];
page.on("response", (response) => {
	if (/byok-keys/.test(response.url())) calls.push(`${response.request().method()} ${new URL(response.url()).pathname} → ${response.status()}`);
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
await ensureSignedIn(page);
await page.waitForTimeout(2500);

const failures: Array<string> = [];
const toastCount = () => page.locator(".toast").count();

for (const line of ["/keys.remove gemini", "/keys.remove"]) {
	calls.length = 0;
	const before = await page.locator("body").innerText();
	await sendPrompt(page, line);
	let toasts = 0;
	for (let tick = 0; tick < 20; tick += 1) {
		await page.waitForTimeout(400);
		toasts = Math.max(toasts, await toastCount());
	}
	const after = await page.locator("body").innerText();
	if (after === before && toasts === 0) {
		failures.push(`"${line}" produced nothing at all — no transcript line, no toast (calls: ${calls.join("; ") || "none"})`);
	}
}

await page.screenshot({ path: "/tmp/money-18.5.png", fullPage: true });
await context.close();
report(failures);
