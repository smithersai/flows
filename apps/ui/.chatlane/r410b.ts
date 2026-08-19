import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
// B) connection dropped after headers (closest to "the server died mid-stream")
let mode = "abort";
await page.route("**/api/model/stream", async (route) => {
  if (mode === "abort") { console.log("ABORTING stream"); await route.abort("connectionreset"); return; }
  if (mode === "500") { console.log("500 mid"); await route.fulfill({ status: 503, headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "error", message: "The model service is unreachable: upstream terminated the connection." }) }); return; }
  await route.continue();
});
await send(page, "Say a short paragraph about bicycles.");
await page.waitForTimeout(25000);
console.log("A) abort tail:", (await page.locator("body").innerText()).replace(/\s+/g," ").slice(-450));
mode = "500";
await send(page, "Say a short paragraph about trains.");
await page.waitForTimeout(25000);
console.log("B) 503 tail:", (await page.locator("body").innerText()).replace(/\s+/g," ").slice(-450));
await page.screenshot({ path: "/tmp/chatlane/4.10b.png", fullPage: true });
await ctx.close();
