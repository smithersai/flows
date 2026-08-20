import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("https://canary.smithers.sh", { waitUntil: "networkidle" });
await page.locator('[data-flow="auth.sign-in"]').first().evaluate((el) => (el as HTMLElement).click());
await page.waitForTimeout(5_000);
console.log(JSON.stringify({ url: page.url().replace(/([?&]state=)[^&]+/, "$1<redacted>"), body: (await page.locator("body").innerText({ timeout: 5_000 })).slice(0, 3000) }, null, 2));
await browser.close();
