import { launch, resetStore, send, settle } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
const snap = async (label: string) => {
  const s = await page.evaluate(() => ({
    users: Array.from(document.querySelectorAll('[data-role="user"]')).map(e => (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,70)),
    assts: Array.from(document.querySelectorAll('[data-role="assistant"]')).map(e => (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,90)),
  }));
  console.log(`== ${label}\n  users(${s.users.length}):`, JSON.stringify(s.users), `\n  assts(${s.assts.length}):`, JSON.stringify(s.assts));
  return s;
};
await send(page, "What is 7 times 6? Answer with just the number."); await settle(page, 90000);
await snap("after send");
await send(page, "/retry"); await settle(page, 90000);
await snap("after retry1");
await send(page, "/retry"); await settle(page, 90000);
await snap("after retry2");
await page.screenshot({ path: "/tmp/chatlane/4.6b.png", fullPage: true });
await ctx.close();
