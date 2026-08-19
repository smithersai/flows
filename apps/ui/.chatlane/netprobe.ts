import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
page.on("response", async (r) => {
  const u = r.url();
  if (u.includes("/api/")) {
    let body = "";
    try { body = (await r.text()).slice(0, 500); } catch { body = "<stream>"; }
    console.log("RESP", r.status(), u.replace("https://canary.smithers.sh",""), "|", body.replace(/\s+/g," ").slice(0,400));
  }
});
page.on("console", (m) => { const t = m.text(); if (/error|fail|relay|model/i.test(t)) console.log("CONSOLE", m.type(), t.slice(0,300)); });
await send(page, "What is 7 times 6? Answer with just the number.");
await page.waitForTimeout(25000);
console.log("ASSTS:", JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('[data-role="assistant"]')).map(e => (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,120)))));
await ctx.close();
