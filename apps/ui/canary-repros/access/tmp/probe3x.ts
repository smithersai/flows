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
await page.waitForTimeout(4000);
const t0 = Date.now();
await page.locator('[data-flow="auth.sign-in"]').last().click();
// poll for the first useful message
let firstUsefulMs = -1; let seen = "";
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000);
  const text = await page.locator("body").innerText().catch(() => "");
  if (/open issues|open pull request|repos/.test(text) && !text.includes("design-partner preview")) { firstUsefulMs = Date.now() - t0; seen = text; break; }
}
console.log("FIRST USEFUL MS:", firstUsefulMs);
await page.waitForTimeout(6000);
const full = await page.locator("body").innerText();
console.log("=== FULL FIRST RUN TEXT ===\n" + full);
const html = await page.content();
for (const term of ["clone", "git clone", "npm install", "install", "configure", "brew", "CLI", "terminal", "$500 of usage on us", "of usage on us"]) {
  const re = new RegExp(term.replace(/[$]/g, "\\$"), "gi");
  const inText = (full.match(re) ?? []).length;
  console.log(`TERM "${term}": text=${inText}`);
}
const questions = full.split("\n").filter(l => l.trim().endsWith("?"));
console.log("QUESTION LINES:", JSON.stringify(questions));
console.log("WATCHED:", JSON.stringify(await page.evaluate(async () => (await fetch("/api/reco/watched")).json())));
await page.screenshot({ path: "/tmp/canary-access/3.1-firstrun.png", fullPage: true });
await ctx.close();
