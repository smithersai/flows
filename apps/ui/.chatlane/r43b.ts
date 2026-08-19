import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
let modelHadReasoning = false;
await page.route("**/api/model/stream", async (route) => {
  const res = await route.fetch(); const txt = await res.text();
  if (txt.includes('"kind":"reasoning"')) modelHadReasoning = true;
  await route.fulfill({ response: res, body: txt });
});
let hits = 0, sample: any = null;
const poll = setInterval(async () => {
  try {
    const s = await page.evaluate(() => Array.from(document.querySelectorAll('[class*="sui-reasoning"], [data-slot="reasoning"]')).map(e => ({ cls: (e as HTMLElement).className, txt: (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,80) })));
    if (s.length) { hits++; if (!sample) sample = s; }
  } catch {}
}, 150);
await send(page, "Solve this and show your work: a train leaves at 3pm going 60mph, another at 4pm going 80mph. When does the second catch the first? Then say the answer.");
await page.waitForTimeout(45000);
clearInterval(poll);
console.log("4.3 model emitted reasoning deltas:", modelHadReasoning);
console.log("4.3 sui-reasoning element sightings:", hits, JSON.stringify(sample));
console.log("body tail:", (await page.locator("body").innerText()).replace(/\s+/g," ").slice(-500));
await page.screenshot({ path: "/tmp/chatlane/4.3.png", fullPage: true });
await ctx.close();
