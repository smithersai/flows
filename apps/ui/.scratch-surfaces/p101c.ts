import { open, text, run } from "./drv.ts";
const { context, page, errors } = await open();
await page.waitForTimeout(5000);
const isWorld = async () => (await page.getByText("What Smithers currently understands").count()) > 0;
console.log("world open at load:", await isWorld());
await run(page, "/world", 4000);
console.log("after /world:", await isWorld());
if (!(await isWorld())) { await run(page, "/world", 4000); console.log("after 2nd /world:", await isWorld()); }
const back = page.locator('button[aria-label="Back to the conversation"]');
console.log("back count", await back.count());
if (await back.count() > 0) {
  const box = await back.first().boundingBox();
  const top = await page.evaluate((b: any) => { const el = document.elementFromPoint(b.x + b.width/2, b.y + b.height/2) as any; return el?.tagName + "|" + (el?.closest?.("button")?.getAttribute?.("aria-label") ?? "none"); }, box);
  console.log("hit-test at back center:", top, JSON.stringify(box));
  await back.first().click();
  await page.waitForTimeout(2500);
  console.log("after back click, world open:", await isWorld());
}
await run(page, "/world", 4000);
console.log("reopened via /world:", await isWorld());
await run(page, "/chat", 4000);
console.log("after /chat, world open:", await isWorld());
await page.screenshot({ path: "/tmp/surfaces/10.1-final.png" });
console.log("ERRORS", JSON.stringify(errors.slice(0,5)));
await context.close();
