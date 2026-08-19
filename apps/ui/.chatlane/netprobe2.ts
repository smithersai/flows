import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
await page.route("**/api/model/stream", async (route) => {
  const req = route.request();
  console.log("REQ BODY:", (req.postData() ?? "").slice(0, 800));
  const res = await route.fetch();
  const txt = await res.text();
  console.log("RES STATUS:", res.status(), "LEN", txt.length);
  console.log("RES BODY:", txt.slice(0, 2500));
  await route.fulfill({ response: res, body: txt });
});
await send(page, "What is 7 times 6? Answer with just the number.");
await page.waitForTimeout(30000);
console.log("ASSTS:", JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('[data-role="assistant"]')).map(e => (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,150)))));
await ctx.close();
