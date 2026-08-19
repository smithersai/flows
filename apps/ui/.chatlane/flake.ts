import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
const prompts = ["Say OK.", "What is 2+2? Just the number.", "Say the word MANGO.", "Say OK.", "Say the word MANGO.", "Say OK."];
let i = 0;
for (const p of prompts) {
  const before = await page.evaluate(() => document.querySelectorAll('[data-role="assistant"]').length);
  await send(page, p);
  let got = "";
  for (let t = 0; t < 60; t++) {
    await page.waitForTimeout(500);
    const a = await page.evaluate((b) => { const l = Array.from(document.querySelectorAll('[data-role="assistant"]')); return l.length > b ? (l[l.length-1] as HTMLElement).innerText.replace(/\s+/g," ").slice(0,90) : ""; }, before);
    if (a && !/responding/i.test(a)) { got = a; break; }
  }
  await page.waitForTimeout(2500);
  const final = await page.evaluate((b) => { const l = Array.from(document.querySelectorAll('[data-role="assistant"]')); return l.length > b ? (l[l.length-1] as HTMLElement).innerText.replace(/\s+/g," ").slice(0,90) : "<NONE>"; }, before);
  console.log(`RUN ${++i} "${p}" -> ${JSON.stringify(final)}`);
}
await ctx.close();
