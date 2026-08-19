import { open, send, cards } from "./drv.ts";
const { context, page } = await open({ width: 1280, height: 950 });
await send(page, "/billing.balance", 7000);
await send(page, "/flow.list codeplanesmithers/canary-sandbox", 20000);
console.log(JSON.stringify(await cards(page), null, 1).slice(0, 1500));

const maxBtn = page.locator('[data-flow="card.maximize"]').last();
console.log("maximize buttons:", await page.locator('[data-flow="card.maximize"]').count());
await maxBtn.click({ force: true });
await page.waitForTimeout(1200);
const info = await page.evaluate(() => {
  const el = document.querySelector('[data-maximized="true"]') as HTMLElement | null;
  if (!el) return { none: true };
  const r = el.getBoundingClientRect();
  const mins = Array.from(el.querySelectorAll('[data-flow="card.minimize"]')).map(b => { const q=(b as HTMLElement).getBoundingClientRect(); return {x:q.x,r:q.right,w:q.width}; });
  const acts = Array.from(el.querySelectorAll('button')).map(b => { const q=(b as HTMLElement).getBoundingClientRect(); return {t:(b as HTMLElement).innerText.trim().slice(0,20),x:Math.round(q.x),r:Math.round(q.right)}; }).filter(a=>a.r>1280 || a.x<0);
  return { none:false, kind: el.getAttribute("data-kind"), x:r.x, right:r.right, w:r.width, vw: window.innerWidth,
    docScrollW: document.documentElement.scrollWidth, docClientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
    mins, offscreenButtons: acts };
});
console.log("MAXIMIZED:", JSON.stringify(info, null, 1));
await page.screenshot({ path: "/tmp/cards-lane/72-max.png" });
await page.keyboard.press("Escape");
await page.waitForTimeout(1000);
const after = await page.evaluate(() => ({
  maximized: document.querySelectorAll('[data-maximized="true"]').length,
  focus: (document.activeElement as HTMLElement | null)?.getAttribute("data-flow") ?? document.activeElement?.tagName,
}));
console.log("AFTER ESC:", JSON.stringify(after));
await context.close();
