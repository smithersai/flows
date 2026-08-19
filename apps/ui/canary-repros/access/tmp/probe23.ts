import { chromium } from "playwright";
const BASE = "https://canary.smithers.sh";
const ctx = await chromium.launchPersistentContext("/tmp/canary-access-profile", { headless: true, viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
const revoke = async () => {
  await page.goto("https://github.com/settings/connections/applications/Iv23liwHER62HVHMWcGS", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const btn = page.locator('summary:has-text("Revoke access"), button:has-text("Revoke access")').first();
  if (!(await btn.isVisible().catch(()=>false))) { console.log("no revoke button (already revoked?)"); return false; }
  await btn.click(); await page.waitForTimeout(1200);
  const confirm = page.locator('button:has-text("I understand, revoke access"), button:has-text("Revoke access")').last();
  await confirm.click().catch(()=>{});
  await page.waitForTimeout(3000);
  console.log("after revoke:", (await page.locator("body").innerText()).includes("Never used") ? "?" : "ok");
  return true;
};
try {
  await revoke();
  // clear our origin session
  await page.goto("about:blank");
  const client = await ctx.newCDPSession(page);
  await client.send("Storage.clearDataForOrigin", { origin: BASE, storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers" });
  await client.detach().catch(()=>{});
  const jar = await ctx.cookies();
  await ctx.clearCookies();
  await ctx.addCookies(jar.filter(c => !c.domain.includes("smithers.sh")));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await page.locator('[data-flow="auth.sign-in"]').last().click();
  await page.waitForTimeout(6000);
  console.log("CONSENT URL:", page.url());
  console.log("CONSENT BODY:\n" + (await page.locator("body").innerText()).replace(/\n{2,}/g,"\n").slice(0,2500));
  await page.screenshot({ path: "/tmp/canary-access/2.3-consent.png", fullPage: true });
  const cancel = page.locator('button:has-text("Cancel"), a:has-text("Cancel")').first();
  if (await cancel.isVisible().catch(()=>false)) {
    await cancel.click();
    await page.waitForTimeout(7000);
    console.log("AFTER CANCEL URL:", page.url());
    console.log("AFTER CANCEL BODY:\n" + (await page.locator("body").innerText()).replace(/\n{2,}/g,"\n").slice(0,2500));
    await page.screenshot({ path: "/tmp/canary-access/2.3-cancel.png", fullPage: true });
  } else { console.log("NO CANCEL BUTTON VISIBLE"); }
} finally {
  // restore: sign in again, authorizing
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.locator('[data-flow="auth.sign-in"]').last().click().catch(()=>{});
  await page.waitForTimeout(5000);
  const authorize = page.locator('button:has-text("Authorize"), button:has-text("Continue")').first();
  if (await authorize.isVisible().catch(()=>false)) { await authorize.click(); await page.waitForTimeout(6000); }
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  console.log("RESTORED SESSION:", JSON.stringify(await page.evaluate(async () => (await fetch("/api/auth/session")).json())));
  await ctx.close();
}
