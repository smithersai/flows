import { open, text, api } from "./drv.ts";
const { context, page, errors } = await open();
const clear = await api(page, "/api/admin/reco-dismissals?login=codeplanesmithers", { method: "DELETE" });
console.log("CLEARED", clear.status, clear.body);
await page.goto("about:blank", { waitUntil: "domcontentloaded" });
const cdp = await context.newCDPSession(page);
await cdp.send("Storage.clearDataForOrigin", { origin: "https://canary.smithers.sh", storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers" });
await cdp.detach().catch(()=>{});
await page.goto("https://canary.smithers.sh", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
const resp: string[] = [];
page.on("response", (r) => { if (r.url().includes("/api/reco")) resp.push(`${r.status()} ${r.request().method()} ${r.url().replace("https://canary.smithers.sh","")}`); });
// Find the card element containing the reco.dismiss control, and focus IT.
const focused = await page.evaluate(() => {
  const btn = document.querySelector('[data-flow="reco.dismiss"]');
  if (!btn) return "no dismiss button";
  let el: HTMLElement | null = btn as HTMLElement;
  // walk up to the card container
  while (el && !(el.getAttribute("data-slot")?.includes("card") || el.className?.toString().includes("card"))) el = el.parentElement;
  const target = (el ?? (btn as HTMLElement));
  const info = { tag: target.tagName, slot: target.getAttribute("data-slot"), cls: target.className?.toString().slice(0,90), tabindex: target.getAttribute("tabindex") };
  (target as HTMLElement).focus?.();
  return JSON.stringify(info);
});
console.log("CARD CONTAINER:", focused);
console.log("activeElement after focus():", await page.evaluate(() => { const a: any = document.activeElement; return a?.tagName + " slot=" + a?.getAttribute?.("data-slot") + " flow=" + a?.getAttribute?.("data-flow") + " cls=" + (a?.className?.toString?.().slice(0,60) ?? ""); }));
// Also try clicking on the card body text (focus on the card itself, not a control)
await page.locator('text=Why now').first().click({ force: true });
console.log("activeElement after click on card body:", await page.evaluate(() => { const a: any = document.activeElement; return a?.tagName + " slot=" + a?.getAttribute?.("data-slot") + " flow=" + a?.getAttribute?.("data-flow") + " cls=" + (a?.className?.toString?.().slice(0,60) ?? ""); }));
await page.keyboard.press("Escape");
await page.waitForTimeout(4000);
console.log("RECO CALLS", JSON.stringify(resp));
console.log("AFTER-ESC-CARD>>>", (await text(page)).slice(-1400));
console.log("dismiss affordance count after:", await page.locator('[data-flow="reco.dismiss"]').count());
await page.screenshot({ path: "/tmp/surfaces/9.3b.png", fullPage: true });
await context.close();
