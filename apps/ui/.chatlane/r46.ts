import { launch, resetStore, send, settle } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
const PROMPT = "Reply with exactly the word PINEAPPLE and nothing else.";
const count = () => page.evaluate((p) => {
  const u = Array.from(document.querySelectorAll('[data-role="user"]')) as HTMLElement[];
  return { total: u.length, matching: u.filter(e => e.innerText.includes("PINEAPPLE")).length, texts: u.map(e => e.innerText.replace(/\s+/g," ").slice(0,60)) };
}, PROMPT);
await send(page, PROMPT); await settle(page, 90000);
const c1 = await count(); console.log("after first send:", JSON.stringify(c1));
await send(page, "/retry"); await settle(page, 90000);
const c2 = await count(); console.log("after /retry #1:", JSON.stringify(c2));
await send(page, "/retry"); await settle(page, 90000);
const c3 = await count(); console.log("after /retry #2:", JSON.stringify(c3));
const asst = await page.evaluate(() => Array.from(document.querySelectorAll('[data-role="assistant"]')).map(e => (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,80)));
console.log("assistants:", JSON.stringify(asst, null, 1));
await page.screenshot({ path: "/tmp/chatlane/4.6.png", fullPage: true });
console.log("VERDICT dup:", c2.matching !== c1.matching || c3.matching !== c1.matching);
await ctx.close();
