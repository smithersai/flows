import { chromium } from "playwright";
const BASE = "https://canary.smithers.sh";
const ctx = await chromium.launchPersistentContext("/tmp/canary-access-profile", { headless: true, viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
const watched = () => page.evaluate(async () => (await fetch("/api/reco/watched")).json());
const selCount = () => page.evaluate(() => Array.from(document.querySelectorAll(".repo-chooser-row")).map(b => b.getAttribute("aria-selected")).join(","));
const confirmLabel = () => page.locator('[data-flow="repos.watch.confirm"]').first().innerText();
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
  console.log("initial selection:", await selCount(), "| confirm:", await confirmLabel());
  const rows = page.locator(".repo-chooser-row");
  await rows.first().click(); await page.waitForTimeout(600);
  console.log("after toggle row1:", await selCount(), "| confirm:", await confirmLabel());
  const none = page.locator('button:has-text("None")').first();
  await none.click(); await page.waitForTimeout(600);
  console.log("after None:", await selCount(), "| confirm:", await confirmLabel());
  const all = page.locator('button:has-text("All")').first();
  await all.click(); await page.waitForTimeout(600);
  console.log("after All:", await selCount(), "| confirm:", await confirmLabel());
  await rows.nth(1).click(); await page.waitForTimeout(600);
  console.log("after toggle row2 off:", await selCount(), "| confirm:", await confirmLabel());
  // filter box behaviour
  await page.locator(".repo-chooser-filter").fill("calendar");
  await page.waitForTimeout(800);
  console.log("filtered rows:", await page.evaluate(() => Array.from(document.querySelectorAll(".repo-chooser-name")).map(n => (n as HTMLElement).innerText)));
  await page.locator(".repo-chooser-filter").fill("");
  await page.waitForTimeout(500);
  await page.locator('[data-flow="repos.watch.confirm"]').first().click();
  await page.waitForTimeout(7000);
  console.log("WATCHED AFTER CONFIRM:", JSON.stringify(await watched()));
  console.log("BODY tail:", (await page.locator("body").innerText()).slice(-700));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);
  console.log("WATCHED AFTER RELOAD:", JSON.stringify(await watched()));
  console.log("RELOAD BODY head:", (await page.locator("body").innerText()).slice(0, 500));
  console.log("chooser present after reload?", await page.locator('[data-flow="repos.watch.confirm"]').count());
  await page.screenshot({ path: "/tmp/canary-access/3.6-after-reload.png", fullPage: true });
} finally {
  const restore = await page.evaluate(async (sel) => {
    const r = await fetch("/api/reco/watched", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ selected: sel, via: "command" }) });
    return { status: r.status, body: (await r.text()).slice(0,200) };
  }, (original as any).selected ?? []);
  console.log("RESTORE:", JSON.stringify(restore));
  await ctx.close();
}
