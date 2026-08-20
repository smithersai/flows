import { chromium } from "playwright";
const context = await chromium.launchPersistentContext("/tmp/round3-appearance-profile", { headless: true, viewport: { width: 1440, height: 1000 } });
const page = context.pages()[0] ?? await context.newPage();
await page.goto("https://canary.smithers.sh", { waitUntil: "networkidle", timeout: 60_000 });
await page.locator('[data-flow="auth.sign-in"]').first().evaluate((el) => (el as HTMLElement).click());
await page.waitForTimeout(5_000);
const body = await page.locator("body").innerText({ timeout: 10_000 });
console.log(JSON.stringify({ url: page.url().replace(/([?&]state=)[^&]+/, "$1<redacted>"), body: body.slice(0, 4000) }, null, 2));
await context.close();
