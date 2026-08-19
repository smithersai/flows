import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
let n = 0;
await page.route("**/api/model/stream", async (route) => {
  const res = await route.fetch();
  const txt = await res.text();
  n++;
  console.log(`--- call ${n} status ${res.status()} len ${txt.length}`);
  console.log(JSON.stringify(txt).slice(0, 1800));
  await route.fulfill({ response: res, body: txt });
});
for (const p of ["What is 7 times 6? Answer with just the number.", "Say OK.", "Name three colors."]) {
  await send(page, p);
  await page.waitForTimeout(20000);
  console.log("PROMPT:", p, "=> ASSTS:", JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('[data-role="assistant"]')).map(e => (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,100)))));
}
await ctx.close();
