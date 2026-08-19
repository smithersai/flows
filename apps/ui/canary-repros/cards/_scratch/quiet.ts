import { open, send, cards } from "./drv.ts";
const REPO = "codeplanesmithers/canary-sandbox";
const { context, page } = await open({ width: 1280, height: 950 });
await send(page, `/flow.list ${REPO}`, 25000);
await page.locator('[data-flow="flow.run"]').nth(1).click({ force: true });
let quiet = false;
for (let i=0;i<200;i++) {
  await page.waitForTimeout(5000);
  const n = await page.locator('[data-flow="flow.run.stop"]').count();
  if (n>0) { quiet = true; console.log(`QUIET at t+${(i+1)*5}s`); break; }
  if (i%12===0) {
    const s = await page.evaluate(()=>Array.from(document.querySelectorAll('[data-kind="flow-run"]')).map(e=>({s:e.getAttribute("data-status"),t:(e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,140)})));
    console.log(`t+${(i+1)*5}s`, JSON.stringify(s));
  }
}
if (quiet) {
  const before = await page.evaluate(()=>Array.from(document.querySelectorAll('[data-kind="flow-run"]')).map(e=>({s:e.getAttribute("data-status"),t:(e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,260)})));
  console.log("QUIET CARD:", JSON.stringify(before,null,1));
  await page.screenshot({path:"/tmp/cards-lane/quiet.png", fullPage:true});
  await page.locator('[data-flow="flow.run.retry"]').first().click({force:true});
  await page.waitForTimeout(10000);
  console.log("AFTER RETRY:", JSON.stringify(await page.evaluate(()=>Array.from(document.querySelectorAll('[data-kind="flow-run"]')).map(e=>({s:e.getAttribute("data-status"),t:(e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,260)}))),null,1));
  // wait for quiet again or click stop if available
  for (let i=0;i<10;i++){ await page.waitForTimeout(3000); if (await page.locator('[data-flow="flow.run.stop"]').count()>0) break; }
  if (await page.locator('[data-flow="flow.run.stop"]').count()>0) {
    await page.locator('[data-flow="flow.run.stop"]').first().click({force:true});
    await page.waitForTimeout(8000);
    console.log("AFTER STOP:", JSON.stringify(await page.evaluate(()=>Array.from(document.querySelectorAll('[data-kind="flow-run"]')).map(e=>({s:e.getAttribute("data-status"),t:(e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,260)}))),null,1));
  } else console.log("stop button gone after retry");
} else console.log("NEVER WENT QUIET");
await context.close();
