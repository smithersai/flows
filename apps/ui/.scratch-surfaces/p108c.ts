import { open, run, text } from "./drv.ts";
const { context, page, errors } = await open();
await page.waitForTimeout(6000);
await run(page, "/debug.snapshot", 8000);
const t = await text(page);
const i = t.indexOf("world");
console.log("SNAPSHOT tail>>>", t.slice(-3000));
await page.screenshot({ path: "/tmp/surfaces/10.8-snapshot.png", fullPage: true });
await context.close();
