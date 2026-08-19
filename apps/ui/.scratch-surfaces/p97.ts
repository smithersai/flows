import { open, text, run, api } from "./drv.ts";
const { context, page, errors } = await open({ reset: true });
await page.waitForTimeout(6000);
const resp: string[] = [];
page.on("response", (r) => { if (r.url().includes("/api/reco")) resp.push(`${r.status()} ${r.request().method()} ${r.url().replace("https://canary.smithers.sh","")}`); });
// Produce a feedback event: accept the card.
const stamp = Date.now();
await page.locator('[data-flow="reco.accept"]').first().click({ force: true });
await page.waitForTimeout(6000);
console.log("RECO REQS", JSON.stringify(resp));
await run(page, "/admin.feedback", 12000);
const t = await text(page);
console.log("TAIL>>>", t.slice(-2500));
await page.screenshot({ path: "/tmp/surfaces/9.7.png", fullPage: true });
console.log("ERRORS", JSON.stringify(errors.slice(0,5)));
await context.close();
