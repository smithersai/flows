import { chromium } from "playwright";
const BASE = "https://canary.smithers.sh";
const ctx = await chromium.launchPersistentContext("/tmp/canary-access-profile", { headless: true, viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
const watched = () => page.evaluate(async () => (await fetch("/api/reco/watched")).json());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const original = await watched() as any;
console.log("ORIGINAL:", JSON.stringify(original.selected));
// Hold the watched read open so the client is in its genuine "selection unknown"
// state — the same state a cold load on a slow connection is in.
await page.route("**/api/reco/watched", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  await new Promise((r) => setTimeout(r, 30000));
  await route.continue();
});
try {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const composer = page.locator("textarea.sui-chat-composer-input");
  await composer.click();
  await page.keyboard.type("/flow.run canary-access-probe-flow", { delay: 5 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(4000);
  const deferred = await page.locator("body").innerText();
  console.log("=== AFTER DEFERRED FLOW ===\n" + deferred.slice(0, 1800));
  console.log("FLOWS:", JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll("[data-flow]")).map(n => n.getAttribute("data-flow")))));
  await page.screenshot({ path: "/tmp/canary-access/3.7-deferred.png", fullPage: true });
  const confirm = page.locator('[data-flow="repos.watch.confirm"]').first();
  if (await confirm.count() > 0) {
    console.log("confirm label:", await confirm.innerText());
    await confirm.click();
    await page.waitForTimeout(9000);
    const resumed = await page.locator("body").innerText();
    console.log("=== AFTER CONFIRM (resume?) ===\n" + resumed.slice(0, 2500));
    await page.screenshot({ path: "/tmp/canary-access/3.7-resumed.png", fullPage: true });
  } else {
    console.log("NO CHOOSER APPEARED");
  }
} finally {
  await page.unroute("**/api/reco/watched");
  const restore = await page.evaluate(async (sel) => {
    const r = await fetch("/api/reco/watched", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ selected: sel, via: "command" }) });
    return { status: r.status, body: (await r.text()).slice(0,220) };
  }, (original as any).selected ?? []);
  console.log("RESTORE:", JSON.stringify(restore));
  await ctx.close();
}
