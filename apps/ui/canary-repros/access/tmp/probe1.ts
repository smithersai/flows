import { chromium } from "playwright";
const BASE = "https://canary.smithers.sh";
const ctx = await chromium.launchPersistentContext("/tmp/canary-access-profile", { headless: true, viewport: { width: 1280, height: 950 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
// clear origin state + smithers cookies
await page.goto("about:blank");
const client = await ctx.newCDPSession(page);
await client.send("Storage.clearDataForOrigin", { origin: BASE, storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers" });
await client.detach().catch(()=>{});
const jar = await ctx.cookies();
await ctx.clearCookies();
await ctx.addCookies(jar.filter(c => !c.domain.includes("smithers.sh")));

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const sess = await page.evaluate(async () => (await fetch("/api/auth/session")).json());
console.log("SESSION", JSON.stringify(sess));
const flows = await page.evaluate(() => Array.from(document.querySelectorAll("[data-flow]")).map(e => e.getAttribute("data-flow")));
console.log("VISIBLE FLOWS", JSON.stringify(flows));
const reg = await page.evaluate(() => document.querySelector("[data-flows]")?.getAttribute("data-flows") ?? "");
console.log("REGISTRY COUNT", reg.split(" ").filter(Boolean).length);
console.log("REGISTRY", reg);
const text = await page.locator("body").innerText();
console.log("---BODY---\n" + text);
await page.screenshot({ path: "/tmp/canary-access/1.1-signedout.png", fullPage: true });
await ctx.close();
