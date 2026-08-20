import { open, text, api } from "./drv.ts";
const { context, page, errors } = await open();
const clear = await api(page, "/api/admin/reco-dismissals?login=codeplanesmithers", { method: "DELETE" });
console.log("CLEARED", clear.status, clear.body);
const fresh = async () => {
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Storage.clearDataForOrigin", { origin: "https://canary.smithers.sh", storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers" });
  await cdp.detach().catch(()=>{});
  await page.goto("https://canary.smithers.sh", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(9000);
};
const headline = async () => {
  const t = await text(page);
  const m = t.match(/The read behind this\s*\n\s*([^\n]+)/);
  return m ? m[1] : "(no reco card) tail=" + t.slice(-260).replace(/\n+/g," | ");
};
await fresh();
const h1 = await headline();
console.log("RECO #1:", h1);
console.log("dismiss count:", await page.locator('[data-flow="reco.dismiss"]').count());
// ONE KEY dismiss: focus composer, Escape.
await page.locator('textarea[aria-label="Chat message"]').click();
await page.keyboard.press("Escape");
await page.waitForTimeout(5000);
console.log("dismiss count after one key:", await page.locator('[data-flow="reco.dismiss"]').count());
await fresh();
const h2 = await headline();
console.log("RECO #2 (after reload):", h2);
console.log("SAME UNCHANGED?", h1 === h2);
await page.screenshot({ path: "/tmp/surfaces/9.2.png", fullPage: true });
console.log("ERRORS", JSON.stringify(errors.slice(0,5)));
await context.close();
