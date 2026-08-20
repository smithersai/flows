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
console.log("delete control count:", await del.count(), "aria:", await del.first().getAttribute("aria-label").catch(()=>null));
await del.first().click();
await page.waitForTimeout(1800);
const dlg = page.locator('[role="dialog"], [role="alertdialog"]');
console.log("dialog count:", await dlg.count());
const dlgText = await dlg.first().innerText().catch(async ()=>await text(page));
console.log("DIALOG TEXT>>>", dlgText.slice(0,600));
console.log("names the note title:", /Untitled 1/.test(dlgText));
await page.screenshot({ path: "/tmp/surfaces/10.6-dialog.png", fullPage: true });
// CANCEL
const cancel = page.locator('[data-flow="world.delete.cancel"]');
console.log("cancel count:", await cancel.count());
await cancel.first().click();
await page.waitForTimeout(1500);
console.log("dialog after cancel:", await dlg.count());
console.log("tree after cancel:", JSON.stringify(await items.allInnerTexts()));
// CONFIRM
await del.first().click();
await page.waitForTimeout(1500);
await page.locator('[data-flow="world.delete.confirm"]').first().click();
await page.waitForTimeout(2500);
console.log("tree after confirm:", JSON.stringify(await page.locator('[data-flow="world.select"]').allInnerTexts()));
await page.screenshot({ path: "/tmp/surfaces/10.6-after.png", fullPage: true });
console.log("ERRORS", JSON.stringify(errors.slice(0,5)));
await context.close();
