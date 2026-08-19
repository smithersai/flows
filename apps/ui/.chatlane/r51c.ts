import { launch, resetStore, composer } from "./lib.ts";
const { ctx, page } = await launch();
const snap = async (l: string) => {
  const b = await page.locator("body").innerText();
  console.log(`--- ${l} ---\n${b.replace(/\n{2,}/g,"\n").slice(0, 1600)}\n`);
};
// A: bare "/" + Enter
await resetStore(ctx, page);
await snap("A before");
await composer(page).click(); await page.mouse.move(1350, 20); await composer(page).fill("");
await page.keyboard.type("/", { delay: 40 }); await page.waitForTimeout(1000);
await page.keyboard.press("Enter"); await page.waitForTimeout(12000);
await snap("A after bare-slash Enter");
// B: explicit /reco.accept
await resetStore(ctx, page);
await composer(page).click(); await page.mouse.move(1350, 20); await composer(page).fill("");
await page.keyboard.type("/reco.accept", { delay: 20 }); await page.waitForTimeout(800);
await page.keyboard.press("Enter"); await page.waitForTimeout(12000);
await snap("B after /reco.accept");
await ctx.close();
