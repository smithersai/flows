import { open, run, text } from "./drv.ts";
const { context, page, errors } = await open();
await page.waitForTimeout(6000);
const isWorld = async () => (await page.getByText("What Smithers currently understands").count()) > 0;
if (!(await isWorld())) await run(page, "/world", 4000);
for (let guard = 0; guard < 10; guard++) {
  const items = page.locator('[data-flow="world.select"]');
  const n = await items.count();
  if (n === 0) break;
  await items.first().click();
  await page.waitForTimeout(900);
  await page.locator('[data-flow="world.delete"]').first().click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /^Delete$/ }).first().click();
  await page.waitForTimeout(1800);
}
console.log("remaining notes:", await page.locator('[data-flow="world.select"]').count());
const pane = await page.locator(".world-surface, [class*='world']").first().innerText().catch(async () => await text(page));
console.log("EMPTY PANE TEXT>>>", pane.slice(0, 600));
const empty = page.locator("[class*='world-empty'], [class*='empty']");
console.log("empty node count:", await empty.count());
const btn = page.getByRole("button", { name: /Create a note/i });
console.log("Create a note button count:", await btn.count());
await page.screenshot({ path: "/tmp/surfaces/10.7-empty.png", fullPage: true });
if (await btn.count() > 0) {
  await btn.first().click();
  await page.waitForTimeout(2500);
  console.log("after click, notes:", await page.locator('[data-flow="world.select"]').count(), JSON.stringify(await page.locator('[data-flow="world.select"]').allInnerTexts()));
}
await page.screenshot({ path: "/tmp/surfaces/10.7-after.png", fullPage: true });
console.log("ERRORS", JSON.stringify(errors.slice(0,5)));
await context.close();
