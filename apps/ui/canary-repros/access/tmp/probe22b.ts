import { chromium } from "playwright";
const ctx = await chromium.launchPersistentContext("/tmp/canary-access-profile", { headless: true, viewport: { width: 1280, height: 1100 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto("https://github.com/settings/installations", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
console.log("URL", page.url());
console.log((await page.locator("body").innerText()).replace(/\n{2,}/g,"\n").slice(0,1500));
const cfg = page.locator('a:has-text("Configure")').first();
if (await cfg.isVisible().catch(()=>false)) {
  await cfg.click(); await page.waitForTimeout(3000);
  console.log("=== CONFIGURE", page.url());
  console.log((await page.locator("body").innerText()).replace(/\n{2,}/g,"\n").slice(0,4000));
  await page.screenshot({ path: "/tmp/canary-access/2.2-installation.png", fullPage: true });
}
await ctx.close();
