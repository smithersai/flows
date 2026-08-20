/*
 * Checklist 17.4 — "No top-up or checkout flow is exposed to MVP users."
 *
 * The bug: `/billing.upgrade` and `/billing.portal` are offered in the MVP
 * slash menu, advertised as Stripe checkout, and running one fires a real
 * POST at the billing seam. Exits non-zero while either is reachable.
 *
 *   bun canary-repros/money/17.4.ts
 */
import { chromium } from "playwright";
import { BASE, PROFILE, ensureSignedIn, registry, report, sendPrompt } from "./_lib";

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 950 } });
const page = context.pages()[0] ?? (await context.newPage());
const billingCalls: Array<string> = [];
page.on("response", async (response) => {
	if (/\/api\/billing\/(checkout|portal)/.test(response.url())) {
		billingCalls.push(`${response.request().method()} ${new URL(response.url()).pathname} → ${response.status()}`);
	}
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
await ensureSignedIn(page);
await page.waitForTimeout(2500);

const failures: Array<string> = [];

const registered = await registry(page);
const exposed = registered.filter((name) => name === "billing.upgrade" || name === "billing.portal");
if (exposed.length > 0) failures.push(`checkout flows are registered for an MVP account: ${exposed.join(", ")}`);

/* The slash menu is the surface an MVP user actually sees. */
const composer = page.locator("textarea").first();
await composer.click();
await composer.fill("");
await composer.type("/billing", { delay: 25 });
await page.waitForTimeout(1200);
const menu = await page.evaluate(() =>
	Array.from(document.querySelectorAll('[role="option"],[cmdk-item]')).map((item) => (item as HTMLElement).innerText.replace(/\n/g, " ")),
);
const offered = menu.filter((entry) => /billing\.(upgrade|portal)/.test(entry));
if (offered.length > 0) failures.push(`the slash menu offers checkout to an MVP user: ${JSON.stringify(offered)}`);
await page.keyboard.press("Escape");
await composer.fill("");

/* And running it is a live call, not a refusal. */
await sendPrompt(page, "/billing.upgrade");
await page.waitForTimeout(6000);
if (billingCalls.length > 0) failures.push(`/billing.upgrade reached the billing seam: ${billingCalls.join("; ")}`);

await page.screenshot({ path: "/tmp/money-17.4.png", fullPage: true });
await context.close();
report(failures);
