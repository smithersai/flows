import { open, run, text } from "./drv.ts";
const { context, page } = await open();
await page.waitForTimeout(6000);
await run(page, `Use the remember tool to write a worldview note titled "Canary Remember Probe" whose text is exactly: the canary probe token is quuxtoken123`, 60000);
await page.waitForTimeout(10000);
let t = await text(page);
console.log("STEP1 tail>>>", t.slice(t.lastIndexOf("Use the remember tool")).replace(/\n+/g," | ").slice(0,900));
// check world pane
await run(page, "/world", 5000);
const items = page.locator('[data-flow="world.select"]');
console.log("tree:", JSON.stringify(await items.allInnerTexts()));
for (let i = 0; i < await items.count(); i++) {
  await items.nth(i).click(); await page.waitForTimeout(900);
  console.log("  doc", i, JSON.stringify((await page.locator(".ProseMirror").first().innerText()).slice(0,140)));
}
await run(page, "/chat", 3000);
await run(page, `Run recall with query "quuxtoken123" and tell me what it returned.`, 60000);
await page.waitForTimeout(10000);
t = await text(page);
console.log("STEP2 has token:", t.includes("quuxtoken123"));
console.log("STEP2 tail>>>", t.slice(t.lastIndexOf("Run recall with query")).replace(/\n+/g," | ").slice(0,900));
await page.screenshot({ path: "/tmp/surfaces/10.8-remember.png", fullPage: true });
await context.close();
