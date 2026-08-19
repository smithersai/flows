import { open, text, api } from "./drv.ts";
const { context, page, errors } = await open();
const clear = await api(page, "/api/admin/reco-dismissals?login=codeplanesmithers", { method: "DELETE" });
console.log("CLEARED", clear.status, clear.body);
// fresh slate
await page.goto("about:blank", { waitUntil: "domcontentloaded" });
const cdp = await context.newCDPSession(page);
await cdp.send("Storage.clearDataForOrigin", { origin: "https://canary.smithers.sh", storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers" });
await cdp.detach().catch(()=>{});
await page.goto("https://canary.smithers.sh", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
const resp: string[] = [];
page.on("response", (r) => { if (r.url().includes("/api/reco")) resp.push(`${r.status()} ${r.request().method()} ${r.url().replace("https://canary.smithers.sh","")}`); });
const before = await text(page);
console.log("HEADLINE:", before.split("Proposes")[0].slice(-200).trim());
console.log("dismiss affordance count:", await page.locator('[data-flow="reco.dismiss"]').count());
// PART A: focus the COMPOSER, press Escape once.
const c = page.locator('textarea[aria-label="Chat message"]');
await c.click();
console.log("focus:", await page.evaluate(() => document.activeElement?.tagName + "/" + ((document.activeElement as any)?.getAttribute?.("aria-label") ?? "")));
await page.keyboard.press("Escape");
await page.waitForTimeout(4000);
console.log("RECO CALLS", JSON.stringify(resp));
const after = await text(page);
console.log("AFTER-ESC-COMPOSER>>>", after.slice(-1400));
await page.screenshot({ path: "/tmp/surfaces/9.3a.png", fullPage: true });
console.log("ERRORS", JSON.stringify(errors.slice(0,5)));
await context.close();
