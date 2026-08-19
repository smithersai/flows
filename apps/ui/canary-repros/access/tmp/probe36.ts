import { chromium } from "playwright";
const BASE = "https://canary.smithers.sh";
const ctx = await chromium.launchPersistentContext("/tmp/canary-access-profile", { headless: true, viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
const watched = () => page.evaluate(async () => (await fetch("/api/reco/watched")).json());
const flows = () => page.evaluate(() => Array.from(document.querySelectorAll("[data-flow]")).map(n => n.getAttribute("data-flow")));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const original = await watched() as any;
console.log("ORIGINAL WATCHED:", JSON.stringify(original));
try {
  const composer = page.locator("textarea.sui-chat-composer-input");
  await composer.click();
  await page.keyboard.type("/repos.watch", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(6000);
  const body = await page.locator("body").innerText();
  const i = body.indexOf("watch");
  console.log("=== CHOOSER ===\n" + body.slice(Math.max(0,i-300), i+1200));
  console.log("CHOOSER FLOWS:", JSON.stringify((await flows()).filter(f => f?.startsWith("repos"))));
  await page.screenshot({ path: "/tmp/canary-access/3.6-chooser.png", fullPage: true });
  // toggle first repo
  const toggles = page.locator('[data-flow="repos.watch.toggle"]');
  console.log("toggle count:", await toggles.count());
  await toggles.first().click();
  await page.waitForTimeout(1200);
  console.log("after toggle:", (await page.locator("body").innerText()).match(/\d+ of \d+|selected/gi));
  // none
  await page.locator('[data-flow="repos.watch.none"]').first().click();
  await page.waitForTimeout(1200);
  const noneText = await page.locator("body").innerText();
  console.log("after NONE:", noneText.match(/\d+ of \d+ selected|None selected|nothing/gi));
  // all
  await page.locator('[data-flow="repos.watch.all"]').first().click();
  await page.waitForTimeout(1200);
  const allText = await page.locator("body").innerText();
  console.log("after ALL:", allText.match(/\d+ of \d+ selected/gi));
  // toggle one off then confirm
  await toggles.first().click();
  await page.waitForTimeout(800);
  console.log("after toggle-off:", (await page.locator("body").innerText()).match(/\d+ of \d+ selected/gi));
  await page.locator('[data-flow="repos.watch.confirm"]').first().click();
  await page.waitForTimeout(6000);
  console.log("WATCHED AFTER CONFIRM:", JSON.stringify(await watched()));
  const afterConfirm = await page.locator("body").innerText();
  console.log("=== AFTER CONFIRM (tail) ===\n" + afterConfirm.slice(-900));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(7000);
  console.log("WATCHED AFTER RELOAD:", JSON.stringify(await watched()));
  console.log("=== AFTER RELOAD (head) ===\n" + (await page.locator("body").innerText()).slice(0, 700));
  await page.screenshot({ path: "/tmp/canary-access/3.6-after-reload.png", fullPage: true });
} finally {
  const restore = await page.evaluate(async (sel) => {
    const r = await fetch("/api/reco/watched", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ selected: sel, via: "command" }) });
    return { status: r.status, body: await r.text() };
  }, (original as any).selected ?? []);
  console.log("RESTORE WATCHED:", JSON.stringify(restore));
  await ctx.close();
}
