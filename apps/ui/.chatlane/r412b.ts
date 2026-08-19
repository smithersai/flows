import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
const V = '[data-slot="message-scroller-viewport"]';
const pos = () => page.evaluate((v) => { const e = document.querySelector(v) as HTMLElement; return { top: Math.round(e.scrollTop), h: Math.round(e.scrollHeight), c: Math.round(e.clientHeight), atBottom: e.scrollHeight - e.scrollTop - e.clientHeight < 40 }; }, V);
console.log("before:", JSON.stringify(await pos()));
await send(page, "Say a 700 word essay about bicycles.");
let grew = false, samples: any[] = [];
const start = await pos();
for (let i = 0; i < 90; i++) { await page.waitForTimeout(500); const p = await pos(); samples.push(p); if (p.h > start.h + 200) { grew = true; } if (grew && i > 40) break; }
const end = await pos();
console.log("4.12 A grew:", grew, "start h", start.h, "end h", end.h, "end", JSON.stringify(end), "atBottom:", end.atBottom);
await ctx.close();
