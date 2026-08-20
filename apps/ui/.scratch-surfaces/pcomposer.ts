import { open } from "./drv.ts";
const { context, page } = await open();
await page.waitForTimeout(4000);
const info = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('textarea, [contenteditable], input'));
  return els.map((e: any) => ({ tag: e.tagName, id: e.id, cls: e.className?.toString().slice(0,80), slot: e.getAttribute("data-slot"), aria: e.getAttribute("aria-label"), ph: e.getAttribute("placeholder"), ce: e.getAttribute("contenteditable") }));
});
console.log(JSON.stringify(info, null, 1));
await context.close();
