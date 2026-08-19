import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
let raw = "";
await page.route("**/api/model/stream", async (route) => {
  const res = await route.fetch(); const txt = await res.text(); raw += txt;
  await route.fulfill({ response: res, body: txt });
});
await send(page, "List my open issues on GitHub.");
await page.waitForTimeout(50000);
const body = await page.locator("body").innerText();
console.log("BODY TAIL:", body.replace(/\s+/g," ").slice(-1200));
const echo = await page.evaluate(() => {
  const t = document.body.innerText;
  return { flowFence: t.includes("```flow"), ctxCall: t.includes('ctx.call('), jsonBrace: /\{\s*"(name|arguments|tool_call|type)"\s*:/.test(t) };
});
console.log("4.4 echo:", JSON.stringify(echo));
const work = await page.evaluate(() => Array.from(document.querySelectorAll('[data-slot*="tool"],[class*="tool"],[class*="activity"],[class*="step"],[data-slot="card"]')).map(e => ({ cls:(e as HTMLElement).className, txt:(e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,90)})).slice(0,15));
console.log("4.4 work elements:", JSON.stringify(work, null, 1).slice(0,1500));
console.log("MODEL RAW text deltas:", JSON.stringify(raw.split("\n").filter(l=>l.includes('"kind":"text"')).map(l=>{try{return JSON.parse(l).text}catch{return ""}}).join("")).slice(0,900));
await page.screenshot({ path: "/tmp/chatlane/4.4.png", fullPage: true });
await ctx.close();
