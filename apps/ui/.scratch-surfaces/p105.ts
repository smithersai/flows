import { open, run } from "./drv.ts";
const { context, page, errors } = await open();
await page.waitForTimeout(5000);
const isWorld = async () => (await page.getByText("What Smithers currently understands").count()) > 0;
if (!(await isWorld())) await run(page, "/world", 4000);
const items = page.locator('[data-flow="world.select"]');
for (let i = 0; i < await items.count(); i++) if ((await items.nth(i).innerText()).trim().startsWith("Untitled")) { await items.nth(i).click(); break; }
await page.waitForTimeout(1200);
const pm = page.locator(".ProseMirror").first();
await pm.click();
await page.keyboard.press("Meta+a"); await page.keyboard.press("Backspace");
const marker = "PERSIST-MARKER-" + Date.now();
await page.keyboard.type(marker, { delay: 12 });
await page.waitForTimeout(2500);
console.log("typed:", marker);
// surface switch: world -> chat -> world
await run(page, "/chat", 3000);
console.log("world closed:", !(await isWorld()));
await run(page, "/world", 4000);
for (let i = 0; i < await items.count(); i++) if ((await items.nth(i).innerText()).trim().startsWith("Untitled")) { await items.nth(i).click(); break; }
await page.waitForTimeout(1500);
const afterSwitch = await page.locator(".ProseMirror").first().innerText();
console.log("AFTER SURFACE SWITCH contains marker:", afterSwitch.includes(marker), JSON.stringify(afterSwitch.slice(0,120)));
// reload
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
if (!(await isWorld())) await run(page, "/world", 4000);
const items2 = page.locator('[data-flow="world.select"]');
console.log("tree after reload:", JSON.stringify(await items2.allInnerTexts()));
for (let i = 0; i < await items2.count(); i++) if ((await items2.nth(i).innerText()).trim().startsWith("Untitled")) { await items2.nth(i).click(); break; }
await page.waitForTimeout(2000);
const afterReload = await page.locator(".ProseMirror").first().innerText();
console.log("AFTER RELOAD contains marker:", afterReload.includes(marker), JSON.stringify(afterReload.slice(0,140)));
await page.screenshot({ path: "/tmp/surfaces/10.5.png", fullPage: true });
console.log("ERRORS", JSON.stringify(errors.slice(0,5)));
await context.close();
