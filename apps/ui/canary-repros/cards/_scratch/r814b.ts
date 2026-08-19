import { open, send, cards } from "./drv.ts";
const REPO = "codeplanesmithers/canary-sandbox";
const { context, page } = await open({ width: 1280, height: 950 });
const reqs: string[] = [];
page.on("request", r => { if (r.url().includes("/api/approvals/decision")) reqs.push(`${r.method()} ${r.url()}`); });
page.on("response", async r => { if (r.url().includes("/api/approvals/decision")) console.log("RESP approvals/decision", r.status()); });
await send(page, `/flow.list ${REPO}`, 25000);
await page.locator('[data-flow="flow.run"]').nth(1).click({ force: true });
let last = "";
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(4000);
  const snap = await page.evaluate(() => ({
    cards: Array.from(document.querySelectorAll("[data-kind]")).map(el => ({
      k: el.getAttribute("data-kind"), s: el.getAttribute("data-status"),
      pill: (Array.from(el.querySelectorAll('span.sui-badge')) as HTMLElement[]).map(p=>p.innerText.trim()).join("|"),
      acts: Array.from(el.querySelectorAll('[data-flow]')).map(b=>b.getAttribute("data-flow")).join(","),
      t: (el as HTMLElement).innerText.replace(/\s+/g," ").slice(0,180),
    })),
    composer: (document.querySelector('[data-slot="composer"]') as HTMLElement|null)?.innerText.replace(/\s+/g," ").slice(0,120) ?? "",
  }));
  const line = JSON.stringify(snap);
  if (line !== last) { console.log(`t+${(i+1)*4}s ${line}`); last = line; }
  if (/flow.run.stop/.test(line)) { console.log("QUIET PHASE REACHED"); break; }
}
await page.screenshot({ path: "/tmp/cards-lane/814b.png", fullPage: true });
// try the acts if present
if (await page.locator('[data-flow="flow.run.stop"]').count() > 0) {
  await page.locator('[data-flow="flow.run.retry"]').first().click({force:true});
  await page.waitForTimeout(6000);
  console.log("after retry:", JSON.stringify(await cards(page)).slice(0,600));
  await page.locator('[data-flow="flow.run.stop"]').first().click({force:true});
  await page.waitForTimeout(6000);
  console.log("after stop:", JSON.stringify(await cards(page)).slice(0,600));
}
console.log("approval decision requests:", reqs);
await context.close();
