import { chromium } from "playwright";
const BASE = "https://canary.smithers.sh";
const ctx = await chromium.launchPersistentContext(process.env.CHAT_PROFILE ?? "/tmp/canary-chat-profile", {
  headless: process.env.HEADED !== "1", viewport: { width: 1400, height: 1000 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
console.log("SESSION:", await page.evaluate(async () => (await fetch("/api/auth/session")).text()));
console.log("BODY:\n", (await page.locator("body").innerText()).slice(0, 1500));
await page.screenshot({ path: "/tmp/chatlane/probe.png", fullPage: false });
await ctx.close();
