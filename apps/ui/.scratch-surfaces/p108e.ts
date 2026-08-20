import { open, run, text } from "./drv.ts";
const { context, page, errors } = await open();
await page.waitForTimeout(6000);
await run(page, `Call the recall tool with query "zarquon" and paste the raw JSON results verbatim.`, 45000);
const t = await text(page);
console.log("has zarquon-bcc8jy:", t.includes("zarquon-bcc8jy"));
console.log("TAIL>>>", t.slice(-1600).replace(/\n+/g, " | "));
await page.screenshot({ path: "/tmp/surfaces/10.8-recall.png", fullPage: true });
await context.close();
