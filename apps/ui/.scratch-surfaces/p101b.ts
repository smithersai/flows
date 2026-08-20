import { open, text, run } from "./drv.ts";
const { context, page, errors } = await open();
await page.waitForTimeout(5000);
const worldOpen = async () => (await page.locator(".world-surface, [class*='world']").count()) > 0;
await run(page, "/world", 4000);
console.log("after /world, world present:", await worldOpen(), "| New note visible:", await page.getByText("New note").first().isVisible().catch(()=>false));
// back button clickable?
const back = page.locator('[data-flow="chat"][aria-label="Back to the conversation"]');
console.log("back count", await back.count(), "visible", await back.first().isVisible(), "enabled", await back.first().isEnabled());
const box = await back.first().boundingBox();
console.log("back box", JSON.stringify(box));
const top = await page.evaluate((b: any) => { const el = document.elementFromPoint(b.x + b.width/2, b.y + b.height/2) as any; return el?.tagName + " aria=" + el?.getAttribute?.("aria-label") + " flow=" + el?.closest?.("button")?.getAttribute?.("data-flow"); }, box);
console.log("element at back center:", top);
await back.first().click();
await page.waitForTimeout(2500);
console.log("after back click, world present:", await worldOpen());
await page.screenshot({ path: "/tmp/surfaces/10.1-back.png" });
// re-open and use /chat
await run(page, "/world", 3500);
console.log("reopened:", await worldOpen());
await run(page, "/chat", 3500);
console.log("after /chat, world present:", await worldOpen());
await page.screenshot({ path: "/tmp/surfaces/10.1-chat.png" });
console.log("ERRORS", JSON.stringify(errors.slice(0,5)));
await context.close();
