import { launch, resetStore, composer } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
const attrs = async () => page.evaluate(() => Array.from(document.querySelectorAll('[role="option"]')).map(e => ({ t:(e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,50), sel:e.getAttribute("aria-selected"), gold:e.getAttribute("data-gold"), all: Array.from(e.attributes).map(a=>a.name).join(",") })));
// PASS 1: pointer parked away
await composer(page).click();
await page.mouse.move(1350, 20);
await composer(page).fill(""); await page.keyboard.type("/", { delay: 40 });
await page.waitForTimeout(900);
console.log("PASS1 (pointer away):", JSON.stringify(await attrs(), null, 1).slice(0, 1200));
const geo = await page.evaluate(() => { const m = document.querySelector(".slash-menu") as HTMLElement; const c = document.querySelector("textarea") as HTMLElement; const mr = m.getBoundingClientRect(), cr = c.getBoundingClientRect(); return { menu:{top:Math.round(mr.top),bottom:Math.round(mr.bottom)}, composer:{top:Math.round(cr.top),bottom:Math.round(cr.bottom)}, overlap: mr.bottom > cr.top }; });
console.log("PASS1 geometry:", JSON.stringify(geo));
await page.keyboard.press("Enter");
await page.waitForTimeout(6000);
console.log("PASS1 after Enter body tail:", (await page.locator("body").innerText()).replace(/\s+/g," ").slice(-350));
await page.screenshot({ path: "/tmp/chatlane/5.1-pass1.png" });
// PASS 2: pointer is where a user's pointer would be — on the composer they just clicked
await ctx.close();
