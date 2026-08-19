import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
await send(page, "Count slowly from one to two hundred, one number per line. Say the whole list.");
await page.waitForTimeout(2500);
const runIds = await page.evaluate(() => Array.from(document.querySelectorAll("[data-run-id]")).map(e => e.getAttribute("data-run-id")));
console.log("4.9 run ids:", JSON.stringify(runIds));
const before = (await page.locator("body").innerText()).length;
if (runIds.length) {
  const res = await page.evaluate(async (rid) => {
    const r = await fetch("/api/agent/turn/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: rid }) });
    return { status: r.status, body: (await r.text()).slice(0, 300) };
  }, runIds[0]);
  console.log("4.9 cancel response:", JSON.stringify(res));
}
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(500);
  const t = await page.locator("body").innerText();
  if (/stopped|cancell?ed|ended|interrupt/i.test(t.slice(Math.max(0,before - 200)))) { console.log("4.9 surfaced at", i*500, "ms"); break; }
}
const st = await page.evaluate(() => ({ b: document.querySelector('[data-slot="chat-transcript"]')?.getAttribute("aria-busy"), stop: !!document.querySelector('[aria-label="Stop generating"]') }));
console.log("4.9 state later:", JSON.stringify(st));
console.log("4.9 tail:", (await page.locator("body").innerText()).replace(/\s+/g," ").slice(-500));
await page.screenshot({ path: "/tmp/chatlane/4.9.png", fullPage: true });
await ctx.close();
