import { open, text, run } from "./drv.ts";
const { context, page, errors } = await open();
await context.grantPermissions(["clipboard-read","clipboard-write"], { origin: "https://canary.smithers.sh" }).catch((e)=>console.log("perm err", String(e).slice(0,80)));
await page.waitForTimeout(5000);
const isWorld = async () => (await page.getByText("What Smithers currently understands").count()) > 0;
if (!(await isWorld())) await run(page, "/world", 4000);
// select Untitled 1
const items = page.locator('[data-flow="world.select"]');
for (let i = 0; i < await items.count(); i++) if ((await items.nth(i).innerText()).trim() === "Untitled 1") { await items.nth(i).click(); break; }
await page.waitForTimeout(1500);
const ed = page.locator('[aria-label^="Edit "]');
const info = await ed.evaluate((e: any) => ({ tag: e.tagName, ce: e.getAttribute("contenteditable"), cls: e.className?.toString().slice(0,90) }));
console.log("EDITOR", JSON.stringify(info));
await ed.click();
await page.keyboard.press("Meta+a"); await page.keyboard.press("Backspace");
await page.waitForTimeout(500);
// TYPING + FORMATTING
await page.keyboard.type("# Heading One\n\nSome **bold** and `code` text.\n\n- item a\n- item b\n", { delay: 8 });
await page.waitForTimeout(1500);
console.log("after typing, editor innerText:", JSON.stringify((await ed.innerText()).slice(0,300)));
const html = await ed.innerHTML();
console.log("has <h1>:", /<h1/i.test(html), "| has <strong>:", /<strong|font-weight/i.test(html), "| has <code>:", /<code/i.test(html), "| has <li>:", /<li/i.test(html));
await page.screenshot({ path: "/tmp/surfaces/10.4-typed.png", fullPage: true });
// UNDO
const beforeUndo = await ed.innerText();
await page.keyboard.press("Meta+z");
await page.waitForTimeout(1200);
const afterUndo = await ed.innerText();
console.log("undo changed text:", beforeUndo !== afterUndo, "| after undo tail:", JSON.stringify(afterUndo.slice(-120)));
// PASTE
await page.evaluate(async () => { await navigator.clipboard.writeText("PASTED-CANARY-BLOCK-XYZ"); });
await ed.click();
await page.keyboard.press("Meta+ArrowDown");
await page.keyboard.press("Meta+v");
await page.waitForTimeout(1500);
const afterPaste = await ed.innerText();
console.log("paste landed:", afterPaste.includes("PASTED-CANARY-BLOCK-XYZ"));
// VERY LONG DOCUMENT
const long = Array.from({length: 400}, (_, i) => `Line ${i} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod.`).join("\n");
await page.evaluate(async (t) => { await navigator.clipboard.writeText(t); }, long);
await page.keyboard.press("Meta+v");
const t0 = Date.now();
await page.waitForTimeout(4000);
const finalText = await ed.innerText();
console.log("long doc chars in editor:", finalText.length, "| contains Line 399:", finalText.includes("Line 399"), "| elapsed", Date.now()-t0);
await page.screenshot({ path: "/tmp/surfaces/10.4-long.png" });
console.log("ERRORS", JSON.stringify(errors.slice(0,6)));
await context.close();
