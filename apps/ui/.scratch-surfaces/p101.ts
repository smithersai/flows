import { open, text, run } from "./drv.ts";
const { context, page, errors } = await open();
await page.waitForTimeout(5000);
await run(page, "/world", 5000);
console.log("WORLD PANE>>>", (await text(page)).slice(0, 1800));
await page.screenshot({ path: "/tmp/surfaces/10.1-world.png", fullPage: true });
// back button in the pane header
const backs = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b: any) => ({ t: b.innerText?.slice(0,30), aria: b.getAttribute("aria-label"), flow: b.getAttribute("data-flow"), cls: b.className?.toString().slice(0,60) })).filter(b => /back|chat|close/i.test((b.t ?? "") + (b.aria ?? "") + (b.flow ?? "") + b.cls)));
console.log("BACKISH BUTTONS", JSON.stringify(backs, null, 1));
await context.close();
