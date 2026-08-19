import { open, send, cards } from "./drv.ts";
const REPO = "codeplanesmithers/canary-sandbox";
const { context, page } = await open({ width: 1280, height: 950 });
const net: string[] = [];
page.on("response", async r => { if (r.url().includes("/api/approvals/decision")) net.push(`${r.request().method()} ${r.url()} -> ${r.status()}`); });
await send(page, `/flow.list ${REPO}`, 25000);
await page.locator('[data-flow="flow.run"]').nth(1).click({ force: true });
for (let i=0;i<40;i++){ await page.waitForTimeout(3000); if (await page.locator('[data-kind="approval"]').count()>0) break; }
const info = await page.evaluate(() => {
  const el = document.querySelector('[data-kind="approval"]') as HTMLElement|null;
  if (!el) return null;
  return { html: el.outerHTML.slice(0, 4000), text: el.innerText, buttons: Array.from(el.querySelectorAll("button")).map(b=>({t:(b as HTMLElement).innerText.trim(), f:b.getAttribute("data-flow")})) };
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: "/tmp/cards-lane/82-approval.png", fullPage: true });
await context.close();
