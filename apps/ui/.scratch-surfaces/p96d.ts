import { open, text, run, api } from "./drv.ts";
const { context, page, errors } = await open();
await page.waitForTimeout(4000);
const before = (await text(page)).slice(-900);
console.log("BEFORE-CARD>>>", before.split("Proposes")[0].slice(-300));
// Narrow the watched set so the recommendation MUST change, then refresh.
const put = await api(page, "/api/reco/watched", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ selected: ["codeplanesmithers/demo-calendar"] }) });
console.log("PUT watched", put.status, put.body.slice(0,200));
await run(page, "/reco.refresh", 14000);
const mid = await text(page);
console.log("AFTER-NARROW>>>", mid.slice(-1400));
// restore
const restore = await api(page, "/api/reco/watched", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ selected: ["codeplanesmithers/canary-sandbox","codeplanesmithers/demo-calendar","codeplanesmithers/smithers-demo"] }) });
console.log("RESTORE", restore.status, restore.body.slice(0,200));
await run(page, "/reco.refresh", 14000);
console.log("AFTER-RESTORE>>>", (await text(page)).slice(-1000));
await context.close();
