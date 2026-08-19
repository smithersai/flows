import { open, send, cards } from "./drv.ts";
const REPO = "codeplanesmithers/canary-sandbox";
const { context, page } = await open({ width: 1280, height: 950 });
const net: string[] = [];
page.on("response", async r => { if (r.url().includes("/api/approvals/decision")) { let b=""; try{b=(await r.text()).slice(0,200);}catch{} net.push(`${r.request().method()} ${r.url()} -> ${r.status()} ${b}`);} });
const decision = async (which: "approve"|"deny") => {
  await send(page, `/flow.list ${REPO}`, 22000);
  await page.locator('[data-flow="flow.run"]').nth(1).click({ force: true });
  for (let i=0;i<40;i++){ await page.waitForTimeout(3000); if (await page.locator('[data-kind="approval"] button[data-decision]').count()>0) break; }
  const n = await page.locator('[data-kind="approval"]').count();
  if (n===0) { console.log(`${which}: NO APPROVAL CARD`); return; }
  await page.locator(`[data-kind="approval"] button[data-decision="${which}"]`).last().click({force:true});
  await page.waitForTimeout(9000);
  const st = await page.evaluate(() => Array.from(document.querySelectorAll('[data-kind="approval"],[data-kind="flow-run"]')).map(el=>({k:el.getAttribute("data-kind"),s:el.getAttribute("data-status"),t:(el as HTMLElement).innerText.replace(/\s+/g," ").slice(0,240)})));
  console.log(`AFTER ${which}:`, JSON.stringify(st, null, 1));
  console.log("net:", net);
};
await decision("approve");
await page.screenshot({ path: "/tmp/cards-lane/82-approve.png", fullPage: true });
await decision("deny");
await page.screenshot({ path: "/tmp/cards-lane/82-deny.png", fullPage: true });
console.log("ALL NET:", net);
await context.close();
