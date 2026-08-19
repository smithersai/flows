import { open } from "./drv.ts";
const { context, page } = await open();
const flows = await page.evaluate(() => document.querySelector("[data-flows]")?.getAttribute("data-flows") ?? "");
console.log(flows.split(",").sort().join("\n"));
await context.close();
