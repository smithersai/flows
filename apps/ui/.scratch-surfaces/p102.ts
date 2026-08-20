import { open, text, run } from "./drv.ts";
const { context, page, errors } = await open();
await page.waitForTimeout(5000);
const isWorld = async () => (await page.getByText("What Smithers currently understands").count()) > 0;
if (!(await isWorld())) await run(page, "/world", 4000);
const before = await page.locator(".world-tree-item, [class*='world-tree'] button, aside button").allInnerTexts().catch(()=>[]);
console.log("tree before:", JSON.stringify(before));
const nn = page.getByRole("button", { name: /New note/i }).first();
console.log("new-note data-flow:", await nn.getAttribute("data-flow"));
await nn.click();
await page.waitForTimeout(2500);
const active = await page.evaluate(() => {
  const a: any = document.activeElement;
  const editor = document.querySelector('[aria-label^="Edit "]');
  return { tag: a?.tagName, aria: a?.getAttribute?.("aria-label"), cls: a?.className?.toString?.().slice(0,70), insideEditor: !!(editor && (editor === a || editor.contains(a))), editorAria: editor?.getAttribute("aria-label") ?? null };
});
console.log("ACTIVE AFTER NEW NOTE:", JSON.stringify(active));
const meta = await page.locator(".world-document-meta").innerText().catch(()=>null);
console.log("doc meta:", meta);
// type immediately
const probe = "CANARY-FOCUS-PROBE-" + Date.now();
await page.keyboard.type(probe, { delay: 15 });
await page.waitForTimeout(2000);
const editorText = await page.locator('[aria-label^="Edit "]').innerText().catch(()=>null);
console.log("editor text after typing:", JSON.stringify(editorText?.slice(0,200)));
console.log("typed landed in note:", editorText?.includes(probe) ?? false);
await page.screenshot({ path: "/tmp/surfaces/10.2.png", fullPage: true });
console.log("ERRORS", JSON.stringify(errors.slice(0,5)));
await context.close();
