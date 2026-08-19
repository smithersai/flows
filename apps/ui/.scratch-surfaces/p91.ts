import { open, api, text } from "./drv.ts";
const { context, page, errors } = await open({ reset: true });
await page.waitForTimeout(5000);
const t = await text(page);
console.log("HAS proposes:", /Proposes/i.test(t), "| why now:", /Why now/i.test(t), "| what happens:", /What happens/i.test(t));
for (const f of ["reco.accept","reco.edit","reco.dismiss","reco.refresh"]) {
  const l = page.locator(`[data-flow="${f}"]`);
  console.log(f, "count=", await l.count(), "text=", JSON.stringify(await l.first().innerText().catch(()=>null)));
}
console.log("DATAFLOWS:", await page.locator("[data-flows]").first().getAttribute("data-flows"));
const card = page.locator('[data-kind="recommendation"]');
console.log("reco card count:", await card.count());
console.log("CARDTEXT>>>", await card.first().innerText().catch(()=>"(none)"));
await page.screenshot({ path: "/tmp/surfaces/9.1.png", fullPage: false });
console.log("ERRORS", JSON.stringify(errors.slice(0,5)));
await context.close();
