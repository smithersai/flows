import { chromium } from "playwright";
const ctx = await chromium.launchPersistentContext("/tmp/canary-access-profile", { headless: true, viewport: { width: 1280, height: 1100 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto("https://github.com/settings/installations/146401045", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
const rev = page.locator('a:has-text("Review request")').first();
if (await rev.isVisible().catch(()=>false)) { await rev.click(); await page.waitForTimeout(3000); }
console.log("URL", page.url());
console.log((await page.locator("body").innerText()).replace(/\n{2,}/g,"\n"));
await page.screenshot({ path: "/tmp/canary-access/2.2-permreq.png", fullPage: true });
await ctx.close();
