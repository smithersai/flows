import { launch, resetStore, composer, send } from "./lib.ts";
const { ctx, page } = await launch();
const listing = async (q: string) => {
  await composer(page).click(); await page.mouse.move(1350, 20); await composer(page).fill("");
  await page.keyboard.type(q, { delay: 40 }); await page.waitForTimeout(900);
  return page.evaluate(() => Array.from(document.querySelectorAll('[role="option"]')).map((e,i) => `${i}${e.getAttribute("aria-selected")==="true"?"*":" "}${e.getAttribute("data-gold")==="true"?"G":" "} ${(e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,44)}`));
};
await resetStore(ctx, page);
// (c) waiting recommendation
console.log("C reco-waiting:\n  " + (await listing("/")).join("\n  "));
await composer(page).fill("");
// (a) while typing/streaming
await send(page, "Write a 1200 word essay about the history of the bicycle. Say it all.");
for (let i=0;i<100;i++){ await page.waitForTimeout(100); if (await page.evaluate(()=>!!document.querySelector('[aria-label="Stop generating"]'))) break; }
await page.waitForTimeout(1200);
const streaming = await page.evaluate(()=>!!document.querySelector('[aria-label="Stop generating"]'));
const l = await listing("/");
console.log("A streaming (stop button present:", streaming, "):\n  " + (l.length ? l.join("\n  ") : "(0 items)"));
await composer(page).fill("");
await page.keyboard.press("Escape"); await page.waitForTimeout(1500);
await page.keyboard.press("Escape"); await page.waitForTimeout(1500);
// (d) off the chat surface
await composer(page).click(); await composer(page).fill(""); await page.keyboard.type("/world", { delay: 25 });
await page.keyboard.press("Enter"); await page.waitForTimeout(6000);
console.log("surface now:", (await page.locator("body").innerText()).replace(/\s+/g," ").slice(0,120));
console.log("D off-surface:\n  " + (await listing("/")).join("\n  "));
await page.screenshot({ path: "/tmp/chatlane/5.2.png" });
await ctx.close();
