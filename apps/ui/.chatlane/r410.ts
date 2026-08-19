import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
// A) mid-stream cut: deliver a partial ndjson prefix then end the body abruptly.
await page.route("**/api/model/stream", async (route) => {
  const res = await route.fetch();
  const txt = await res.text();
  const lines = txt.split("\n").filter(Boolean);
  const keep = lines.slice(0, Math.max(1, Math.min(lines.length - 1, Math.ceil(lines.length * 0.6))));
  const body = keep.join("\n") + "\n" + '{"type":"delta","kind":"text","text":"...partial';  // truncated mid-frame
  console.log("CUT: sent", keep.length, "of", lines.length, "frames, no done frame");
  await route.fulfill({ status: 200, headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" }, body });
});
await send(page, "Say a 120 word paragraph about bicycles.");
await page.waitForTimeout(35000);
const body = await page.locator("body").innerText();
console.log("4.10 tail:", body.replace(/\s+/g," ").slice(-900));
const blanks = await page.evaluate(() => Array.from(document.querySelectorAll('[data-role="assistant"]')).map(e => (e as HTMLElement).innerText.trim().length));
console.log("4.10 assistant bubble lengths:", JSON.stringify(blanks));
await page.screenshot({ path: "/tmp/chatlane/4.10.png", fullPage: true });
await ctx.close();
