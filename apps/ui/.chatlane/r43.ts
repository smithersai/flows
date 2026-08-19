import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
await send(page, "Think hard about this, reason at length, then say the word ELEPHANT.");
const seen: any[] = [];
for (let i = 0; i < 70; i++) {
  await page.waitForTimeout(250);
  const s = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('details, [data-slot*="reason"], [class*="reason"], [class*="think"], [aria-expanded]'));
    return els.map(e => ({ tag: e.tagName, slot: e.getAttribute("data-slot"), cls: (e as HTMLElement).className, exp: e.getAttribute("aria-expanded"), open: (e as any).open ?? null, txt: (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,80) }));
  });
  if (s.length) seen.push({ i, s });
}
console.log("4.3 samples with reasoning-ish elements:", seen.length);
console.log(JSON.stringify(seen.slice(0, 4), null, 1).slice(0, 2500));
console.log("FINAL body tail:", (await page.locator("body").innerText()).replace(/\s+/g," ").slice(-400));
await ctx.close();
