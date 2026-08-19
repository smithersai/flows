import { launch, resetStore, send, settle } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
const alen = () => page.evaluate(() => {
  const a = Array.from(document.querySelectorAll('[data-role="assistant"]'));
  const last = a[a.length - 1] as HTMLElement | undefined;
  return { n: a.length, len: last ? last.innerText.length : 0, text: last ? last.innerText.slice(0, 200) : "" };
});
const before = await alen();
console.log("before:", JSON.stringify(before));
const t0 = Date.now();
await send(page, "Count from 1 to 40, one number per line. No preamble.");
let first = -1, firstText = "";
for (let i = 0; i < 200; i++) {
  await page.waitForTimeout(200);
  const a = await alen();
  if (a.n > before.n && a.len > 5) { first = Date.now() - t0; firstText = a.text; break; }
}
console.log("4.1 first assistant token ms:", first, JSON.stringify(firstText));
await settle(page, 90000);
const after = await alen();
console.log("4.1 total ms:", Date.now() - t0, "assistant bubbles:", after.n);
console.log("4.1 final text head:", after.text);
await page.screenshot({ path: "/tmp/chatlane/4.1.png" });
await ctx.close();
