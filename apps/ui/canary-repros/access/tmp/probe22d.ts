import { chromium } from "playwright";
const ctx = await chromium.launchPersistentContext("/tmp/canary-access-profile", { headless: true, viewport: { width: 1280, height: 1200 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto("https://github.com/settings/installations/146401045/permissions/update", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const t = page.locator('text=Show unchanged permissions').first();
if (await t.isVisible().catch(()=>false)) { await t.click(); await page.waitForTimeout(1500); }
console.log((await page.locator("body").innerText()).replace(/\n{2,}/g,"\n").slice(0,3000));
await page.screenshot({ path: "/tmp/canary-access/2.2-permreq-full.png", fullPage: true });
await ctx.close();
