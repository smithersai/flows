import { chromium } from "playwright";
const BASE = "https://canary.smithers.sh";
const ctx = await chromium.launchPersistentContext(process.env.CHAT_PROFILE ?? "/tmp/canary-chat-profile", {
  headless: process.env.HEADED !== "1", viewport: { width: 1400, height: 1000 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const btns = page.locator('[data-flow="auth.sign-in"]');
console.log("signin buttons:", await btns.count());
await btns.last().click({ force: true });
await page.waitForTimeout(9000);
console.log("URL:", page.url());
const authorize = page.locator('button:has-text("Authorize"), input[value*="Authorize"]').first();
if (await authorize.isVisible().catch(() => false)) { console.log("clicking authorize"); await authorize.click(); await page.waitForTimeout(9000); }
console.log("URL2:", page.url());
await page.waitForTimeout(4000);
console.log("SESSION:", await page.evaluate(async () => (await fetch("/api/auth/session")).text()));
console.log("BODY:\n", (await page.locator("body").innerText()).slice(0, 900));
await ctx.close();
