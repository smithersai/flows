/*
 * Checklist 19.3 — "Toasts appear for the events that warrant them, stack
 * without overlapping, and auto-dismiss."
 *
 * Stacking and auto-dismiss are fine. The clause that fails is the first one:
 * a flow the user typed into the composer that FAILS produces no toast at all.
 * `send` (AppController.ts) calls `commands.run(name, args)` without the
 * `.then(surfaceCommandFailure)` that the pointer paths (`runCommand`,
 * `runCommandArgs`) use, so the flow's honest failure string is dropped on the
 * floor. `withToast` compounds it: work that settles inside the 300 ms
 * debounce returns before any toast is dispatched, so a fast failure is silent
 * even on the wrapped flows.
 *
 * Exits non-zero while a failing composer flow raises no toast.
 *
 *   bun canary-repros/money/19.3.ts
 */
import { chromium } from "playwright";
import { BASE, PROFILE, ensureSignedIn, report, sendPrompt } from "./_lib";

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 950 } });
const page = context.pages()[0] ?? (await context.newPage());
const seen: Array<string> = [];
page.on("response", (response) => {
	if (/\/api\/(user\/byok-keys|billing\/checkout|tools\/browser-fetch)/.test(response.url()) && response.status() >= 400) {
		seen.push(`${response.request().method()} ${new URL(response.url()).pathname} → ${response.status()}`);
	}
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
await ensureSignedIn(page);
await page.waitForTimeout(2500);

const failures: Array<string> = [];

/*
 * Three flows that genuinely fail on the canary right now. Each one is an
 * event that warrants a toast; none of them raises one.
 */
const cases: ReadonlyArray<readonly [string, string]> = [
	["/keys.list", "the platform answers 404"],
	["/billing.upgrade", "the billing seam answers 400"],
	["/browser https://127.0.0.1/secret", "the browser tool answers 422 (private host)"],
];
for (const [line, why] of cases) {
	seen.length = 0;
	const before = await page.locator("body").innerText();
	await sendPrompt(page, line);
	let peak = 0;
	for (let tick = 0; tick < 25; tick += 1) {
		await page.waitForTimeout(400);
		peak = Math.max(peak, await page.locator(".toast").count());
	}
	const changed = (await page.locator("body").innerText()) !== before;
	if (peak === 0) failures.push(`"${line}" failed (${why}; observed ${seen.join("; ") || "no 4xx"}) and raised no toast (transcript changed: ${changed})`);
}

await page.screenshot({ path: "/tmp/money-19.3.png", fullPage: true });
await context.close();
report(failures);
