import { open, text, run } from "./drv.ts";
const { context, page, errors } = await open();
await page.waitForTimeout(5000);
const isWorld = async () => (await page.getByText("What Smithers currently understands").count()) > 0;
if (!(await isWorld())) await run(page, "/world", 4000);
const items = page.locator('[data-flow="world.select"]');
console.log("tree item count:", await items.count());
const texts = await items.allInnerTexts();
console.log("tree items:", JSON.stringify(texts));
const meta0 = await page.locator(".world-document-meta").innerText().catch(()=>null);
console.log("selected before:", JSON.stringify(meta0?.split("\n")[0]));
// click a DIFFERENT item
const n = await items.count();
if (n > 1) {
  for (let i = 0; i < n; i++) {
    const label = (await items.nth(i).innerText()).trim();
    if (!meta0?.startsWith(label)) { await items.nth(i).click(); break; }
  }
  await page.waitForTimeout(2000);
  const meta1 = await page.locator(".world-document-meta").innerText().catch(()=>null);
  console.log("selected after click:", JSON.stringify(meta1?.split("\n")[0]));
  console.log("selection changed:", meta0?.split("\n")[0] !== meta1?.split("\n")[0]);
  const editorAria = await page.locator('[aria-label^="Edit "]').getAttribute("aria-label").catch(()=>null);
  console.log("editor aria:", editorAria);
}
await page.screenshot({ path: "/tmp/surfaces/10.3.png", fullPage: true });
console.log("ERRORS", JSON.stringify(errors.slice(0,5)));
await context.close();
