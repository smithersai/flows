import { chromium } from "playwright";
const BASE = "https://canary.smithers.sh";
const ctx = await chromium.launchPersistentContext("/tmp/canary-access-profile", { headless: true, viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
const watched = () => page.evaluate(async () => (await fetch("/api/reco/watched")).json());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const original = await watched() as any;
console.log("ORIGINAL:", JSON.stringify(original.selected));
try {
  const composer = page.locator("textarea.sui-chat-composer-input");
  await composer.click();
  await page.keyboard.type("/repos.watch", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(6000);
  console.log("ALL data-flow:", JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll("[data-flow]")).map(n => ({ f: n.getAttribute("data-flow"), t: (n as HTMLElement).innerText.slice(0,40).replace(/\n/g,"·") })))));
  console.log("CHOOSER CARD HTML:", (await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("*")).find(e => (e as HTMLElement).innerText?.startsWith("Choose the repositories Smithers watches"));
    return el ? (el as HTMLElement).outerHTML.slice(0, 3000) : "not found";
  })));
} finally {
  await ctx.close();
}
