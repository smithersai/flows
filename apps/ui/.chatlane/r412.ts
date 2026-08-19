import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
const V = '[data-slot="message-scroller-viewport"]';
const pos = () => page.evaluate((v) => { const e = document.querySelector(v) as HTMLElement; return { top: Math.round(e.scrollTop), h: Math.round(e.scrollHeight), c: Math.round(e.clientHeight), atBottom: e.scrollHeight - e.scrollTop - e.clientHeight < 40 }; }, V);
// Case A: at bottom -> should follow
await send(page, "Say a 700 word essay about bicycles.");
await page.waitForTimeout(6000);
const a1 = await pos(); await page.waitForTimeout(6000); const a2 = await pos();
console.log("4.12 A follow:", JSON.stringify(a1), JSON.stringify(a2), "followed:", a2.atBottom);
await page.waitForTimeout(30000);
const a3 = await pos(); console.log("4.12 A end:", JSON.stringify(a3));
// Case B: scroll up -> should stay put
await send(page, "Say another 700 word essay about trains.");
await page.waitForTimeout(4000);
await page.evaluate((v) => { const e = document.querySelector(v) as HTMLElement; e.scrollTop = 0; }, V);
await page.waitForTimeout(500);
const b1 = await pos();
await page.waitForTimeout(9000);
const b2 = await pos();
console.log("4.12 B scrolled-up:", JSON.stringify(b1), "->", JSON.stringify(b2), "stayedPut:", Math.abs(b2.top - b1.top) < 30);
await page.waitForTimeout(30000);
const b3 = await pos();
console.log("4.12 B end:", JSON.stringify(b3), "stayedPut:", Math.abs(b3.top - b1.top) < 30);
await page.screenshot({ path: "/tmp/chatlane/4.12.png" });
await ctx.close();
