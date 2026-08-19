import { open, send, cards, BASE } from "./drv.ts";
const { context, page, errors } = await open();
const s = await page.evaluate(async () => {
  const r = await fetch("/api/auth/session");
  return { status: r.status, body: await r.json().catch(() => null) };
});
console.log("session:", JSON.stringify(s));
console.log("flows attr present:", await page.evaluate(() => document.querySelector("[data-flows]")?.getAttribute("data-flows")?.split(",").length ?? 0));
console.log("BODY:\n" + (await page.locator("body").innerText()).slice(0, 2500));
console.log("CARDS:", JSON.stringify(await cards(page), null, 1));
console.log("errors:", errors.slice(0,5));
await page.screenshot({ path: "/tmp/cards-lane/smoke.png", fullPage: true });
await context.close();
