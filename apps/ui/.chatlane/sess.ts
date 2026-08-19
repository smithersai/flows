import { launch } from "./lib.ts";
const { ctx, page } = await launch();
for (let i = 0; i < 8; i++) {
  const s = await page.evaluate(async () => (await fetch("/api/auth/session", { cache: "no-store" })).text());
  console.log(i, s);
  await page.waitForTimeout(1500);
}
await ctx.close();
