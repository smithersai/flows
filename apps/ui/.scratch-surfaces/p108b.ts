import { open, run, text } from "./drv.ts";
const { context, page, errors } = await open();
await page.waitForTimeout(6000);
const isWorld = async () => (await page.getByText("What Smithers currently understands").count()) > 0;
if (!(await isWorld())) await run(page, "/world", 4000);
const items = page.locator('[data-flow="world.select"]');
console.log("tree:", JSON.stringify(await items.allInnerTexts()));
for (let i = 0; i < await items.count(); i++) if ((await items.nth(i).innerText()).trim().startsWith("Untitled")) { await items.nth(i).click(); break; }
await page.waitForTimeout(1500);
const noteText = await page.locator(".ProseMirror").first().innerText();
console.log("PERSISTED NOTE:", JSON.stringify(noteText.slice(0,220)));
const m = noteText.match(/zarquon-[a-z0-9]+/);
const code = m ? m[0] : "(none)";
console.log("codeword in note:", code);
await run(page, "/chat", 3000);
for (const q of [
  `Read my World notes and tell me the canary codeword. It is written in a note in my World.`,
  `/recall canary codeword`,
]) {
  await run(page, q, 45000);
  const t = await text(page);
  console.log(`Q=${JSON.stringify(q)} -> containsCode=${t.includes(code)}`);
  console.log("   tail:", t.slice(-700).replace(/\n+/g, " | "));
}
await page.screenshot({ path: "/tmp/surfaces/10.8b.png", fullPage: true });
console.log("ERRORS", JSON.stringify(errors.slice(0,5)));
await context.close();
