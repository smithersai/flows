import { open, run, text } from "./drv.ts";
const { context, page, errors } = await open();
await page.waitForTimeout(5000);
const isWorld = async () => (await page.getByText("What Smithers currently understands").count()) > 0;
if (!(await isWorld())) await run(page, "/world", 4000);
const items = page.locator('[data-flow="world.select"]');
console.log("tree:", JSON.stringify(await items.allInnerTexts()));
for (let i = 0; i < await items.count(); i++) if ((await items.nth(i).innerText()).trim().startsWith("Untitled")) { await items.nth(i).click(); break; }
await page.waitForTimeout(1200);
const del = page.locator('[data-flow="world.delete"]');
console.log("delete count:", await del.count(), "aria:", await del.first().getAttribute("aria-label").catch(()=>null));
await del.first().click();
await page.waitForTimeout(1500);
const dlg = page.locator('[role="dialog"], [role="alertdialog"]').first();
const btns = await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')).map((b: any) => ({ t: b.innerText, flow: b.getAttribute("data-flow"), aria: b.getAttribute("aria-label") })));
console.log("DIALOG BUTTONS:", JSON.stringify(btns));
// CANCEL by text
await page.getByRole("button", { name: /^Cancel$/ }).first().click();
await page.waitForTimeout(1500);
console.log("dialog after cancel:", await page.locator('[role="dialog"], [role="alertdialog"]').count());
console.log("tree after cancel:", JSON.stringify(await items.allInnerTexts()));
const stillSelected = await page.locator(".world-document-meta").innerText().catch(()=>null);
console.log("selected after cancel:", JSON.stringify(stillSelected?.split("\n")[0]));
// CONFIRM
await del.first().click();
await page.waitForTimeout(1500);
await page.getByRole("button", { name: /^Delete$/ }).first().click();
await page.waitForTimeout(2500);
console.log("tree after confirm:", JSON.stringify(await page.locator('[data-flow="world.select"]').allInnerTexts()));
await page.screenshot({ path: "/tmp/surfaces/10.6-after.png", fullPage: true });
console.log("ERRORS", JSON.stringify(errors.slice(0,5)));
await context.close();
