import { open, run } from "./drv.ts";
const { context, page } = await open();
await page.waitForTimeout(5000);
const isWorld = async () => (await page.getByText("What Smithers currently understands").count()) > 0;
if (!(await isWorld())) await run(page, "/world", 4000);
const dump = await page.evaluate(() => {
  const ed = document.querySelector('[aria-label^="Edit "]');
  if (!ed) return "none";
  const walk = (el: Element, d = 0): string[] => {
    const out = [`${"  ".repeat(d)}<${el.tagName.toLowerCase()} class="${(el.className?.toString?.() ?? "").slice(0,60)}" ce=${el.getAttribute("contenteditable")} aria=${el.getAttribute("aria-label")}>`];
    if (d < 3) for (const c of Array.from(el.children).slice(0, 6)) out.push(...walk(c, d + 1));
    return out;
  };
  return walk(ed).join("\n") + "\n---TEXTAREAS in pane: " + document.querySelectorAll("textarea").length;
});
console.log(dump);
await context.close();
