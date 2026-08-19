import { chromium } from "playwright";
const ctx = await chromium.launchPersistentContext("/tmp/canary-access-profile", { headless: true, viewport: { width: 1280, height: 1100 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
for (const u of ["https://github.com/settings/apps/authorizations", "https://github.com/settings/connections/applications/Iv23liwHER62HVHMWcGS"]) {
  await page.goto(u, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  console.log("=== requested", u, "-> landed", page.url());
  console.log((await page.locator("body").innerText()).slice(0,1800));
}
await page.screenshot({ path: "/tmp/canary-access/2.2-auths.png", fullPage: true });
await ctx.close();
