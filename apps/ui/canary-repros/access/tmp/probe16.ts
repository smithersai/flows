import { chromium } from "playwright";
const BASE = "https://canary.smithers.sh";
const ctx = await chromium.launchPersistentContext("/tmp/canary-access-profile", { headless: true, viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto("about:blank");
const client = await ctx.newCDPSession(page);
await client.send("Storage.clearDataForOrigin", { origin: BASE, storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers" });
await client.detach().catch(()=>{});
const jar = await ctx.cookies();
await ctx.clearCookies();
await ctx.addCookies(jar.filter(c => !c.domain.includes("smithers.sh")));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const text = await page.locator("body").innerText();
const terms = ["credit card", "card number", "payment", "billing", "price", "pricing", "$", "free trial", "per month", "/mo", "subscribe", "plan", "usage on us", "checkout"];
for (const t of terms) {
  const n = (text.toLowerCase().match(new RegExp(t.replace(/[$/]/g, "\\$&"), "g")) ?? []).length;
  if (n > 0) console.log(`HIT "${t}": ${n}`);
}
console.log("no other hits printed => clean");
console.log("SIGNED-OUT VISIBLE FLOWS:", JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll("[data-flow]")).map(n => n.getAttribute("data-flow")))));
console.log("BALANCE PILL PRESENT?", await page.locator('[data-flow="billing.balance"]').count());
await page.screenshot({ path: "/tmp/canary-access/1.6-signedout.png", fullPage: true });
await ctx.close();
