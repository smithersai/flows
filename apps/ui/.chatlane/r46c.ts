import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
const state = () => page.evaluate(() => ({
  busy: document.querySelector('[data-slot="chat-transcript"]')?.getAttribute("aria-busy"),
  stop: !!document.querySelector('[aria-label="Stop generating"], [data-flow="chat.stop"]'),
  users: document.querySelectorAll('[data-role="user"]').length,
  assts: Array.from(document.querySelectorAll('[data-role="assistant"]')).map(e => (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,70)),
}));
const waitIdle = async (max = 120000) => {
  const t0 = Date.now();
  await page.waitForTimeout(800);
  while (Date.now() - t0 < max) {
    const s = await state();
    if (s.busy === "false" && !s.stop) { await page.waitForTimeout(1500); const s2 = await state(); if (s2.busy === "false" && !s2.stop) return Date.now() - t0; }
    await page.waitForTimeout(400);
  }
  return -1;
};
await send(page, "What is 7 times 6? Answer with just the number.");
console.log("idle after", await waitIdle(), JSON.stringify(await state()));
await send(page, "/retry");
console.log("after retry1", await waitIdle(), JSON.stringify(await state()));
await send(page, "/retry");
console.log("after retry2", await waitIdle(), JSON.stringify(await state()));
await ctx.close();
