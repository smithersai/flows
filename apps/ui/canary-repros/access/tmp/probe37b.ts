import { chromium } from "playwright";
const BASE = "https://canary.smithers.sh";
const ctx = await chromium.launchPersistentContext("/tmp/canary-access-profile", { headless: true, viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
const watched = () => page.evaluate(async () => (await fetch("/api/reco/watched")).json());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const original = await watched() as any;
console.log("ORIGINAL:", JSON.stringify(original.selected));
// wipe persisted client state but KEEP the session cookie
await page.goto("about:blank");
const client = await ctx.newCDPSession(page);
await client.send("Storage.clearDataForOrigin", { origin: BASE, storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers" });
await client.detach().catch(()=>{});
await page.route("**/api/reco/watched", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  await new Promise((r) => setTimeout(r, 45000));
  await route.continue();
});
try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const composer = page.locator("textarea.sui-chat-composer-input");
  await composer.click();
  await page.keyboard.type("/flow.run canary-access-probe-flow", { delay: 5 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(4000);
  console.log("=== AFTER FLOW (selection unknown) ===\n" + (await page.locator("body").innerText()).slice(0, 1500));
  await page.screenshot({ path: "/tmp/canary-access/3.7-deferred.png", fullPage: true });
  const confirm = page.locator('[data-flow="repos.watch.confirm"]').first();
  if (await confirm.count() > 0) {
    console.log("CHOOSER APPEARED, confirm label:", await confirm.innerText());
    await confirm.click();
    await page.waitForTimeout(10000);
    console.log("=== AFTER CONFIRM ===\n" + (await page.locator("body").innerText()).slice(0, 2000));
    await page.screenshot({ path: "/tmp/canary-access/3.7-resumed.png", fullPage: true });
  } else console.log("NO CHOOSER APPEARED");
} finally {
  await page.unroute("**/api/reco/watched");
  console.log("RESTORE:", JSON.stringify(await page.evaluate(async (sel) => {
    const r = await fetch("/api/reco/watched", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ selected: sel, via: "command" }) });
    return { status: r.status, body: (await r.text()).slice(0,220) };
  }, (original as any).selected ?? [])));
  await ctx.close();
}
