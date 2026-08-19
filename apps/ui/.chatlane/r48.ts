import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
const busy = () => page.evaluate(() => ({
  b: document.querySelector('[data-slot="chat-transcript"]')?.getAttribute("aria-busy"),
  stop: !!document.querySelector('[aria-label="Stop generating"],[data-flow="chat.stop"]'),
  len: document.body.innerText.length,
}));
await send(page, "Write a 900 word essay about the history of the bicycle. Say it in full.");
// wait until streaming
let started = false;
for (let i = 0; i < 80; i++) { await page.waitForTimeout(200); const s = await busy(); if (s.b === "true" || s.stop) { started = true; console.log("streaming detected at", i*200, "ms", JSON.stringify(s)); break; } }
console.log("started:", started);
await page.waitForTimeout(3000);
const lenBefore = (await busy()).len;
const t0 = Date.now();
await page.keyboard.press("Escape");
let stoppedMs = -1;
for (let i = 0; i < 100; i++) { await page.waitForTimeout(50); const s = await busy(); if (s.b !== "true" && !s.stop) { stoppedMs = Date.now()-t0; break; } }
console.log("4.8 stop ms:", stoppedMs);
await page.waitForTimeout(6000);
const body = await page.locator("body").innerText();
console.log("4.8 says:", body.replace(/\s+/g," ").slice(-700));
const lenAfter = (await busy()).len;
console.log("4.8 len before/after-6s:", lenBefore, lenAfter);
await page.waitForTimeout(10000);
console.log("4.8 len after 16s:", (await busy()).len, "busy:", JSON.stringify(await busy()));
await page.screenshot({ path: "/tmp/chatlane/4.8.png", fullPage: true });
await ctx.close();
