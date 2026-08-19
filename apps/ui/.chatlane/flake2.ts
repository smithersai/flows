import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
let last = "";
await page.route("**/api/model/stream", async (route) => {
  const res = await route.fetch(); const txt = await res.text();
  const texts = txt.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((d: any) => d.type === "delta" && d.kind === "text").map((d: any) => d.text).join("");
  last = texts;
  await route.fulfill({ response: res, body: txt });
});
for (const p of ["Say the word MANGO.", "What is 2+2? Just the number.", "Name three colors.", "Say OK."]) {
  const before = await page.evaluate(() => document.querySelectorAll('[data-role="assistant"]').length);
  last = "";
  await send(page, p);
  await page.waitForTimeout(22000);
  const final = await page.evaluate((b) => { const l = Array.from(document.querySelectorAll('[data-role="assistant"]')); return l.length > b ? (l[l.length-1] as HTMLElement).innerText.replace(/\s+/g," ").slice(0,90) : "<NONE>"; }, before);
  console.log(`PROMPT ${JSON.stringify(p)}\n  MODEL-> ${JSON.stringify(last).slice(0,400)}\n  UI-> ${JSON.stringify(final)}`);
}
await ctx.close();
