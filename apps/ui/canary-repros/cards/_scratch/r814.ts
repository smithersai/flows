import { open, send, cards } from "./drv.ts";
const REPO = "codeplanesmithers/canary-sandbox";
const { context, page } = await open({ width: 1280, height: 950 });
await send(page, `/flow.list ${REPO}`, 25000);
console.log("after flow.list:", JSON.stringify(await cards(page)).slice(0,900));
const runBtns = page.locator('[data-flow="flow.run"]');
console.log("run buttons:", await runBtns.count());
await runBtns.nth(1).click({ force: true });
const snaps: any[] = [];
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  const c = await page.evaluate(() => Array.from(document.querySelectorAll('[data-kind="flow-run"]')).map(el => ({
    status: el.getAttribute("data-status"),
    pill: (Array.from(el.querySelectorAll('span.sui-badge')) as HTMLElement[]).map(p=>p.innerText.trim()).join("|"),
    acts: Array.from(el.querySelectorAll('[data-flow]')).map(b=>b.getAttribute("data-flow")).join(","),
    text: (el as HTMLElement).innerText.replace(/\s+/g," ").slice(0,220),
  })));
  const line = JSON.stringify(c);
  if (line !== snaps.at(-1)) { snaps.push(line); console.log(`t+${(i+1)*2}s ${line}`); }
  if (/DONE|FAILED|Stopped|CANCEL/i.test(line) && i > 2) break;
}
await page.screenshot({ path: "/tmp/cards-lane/814-flowrun.png", fullPage: true });
await context.close();
