import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
const st = () => page.evaluate(() => ({
  b: document.querySelector('[data-slot="chat-transcript"]')?.getAttribute("aria-busy"),
  stop: !!document.querySelector('[aria-label="Stop generating"],[data-flow="chat.stop"]'),
  txt: document.body.innerText.replace(/\s+/g," "),
}));
await send(page, "Write a 1500 word essay about the history of the bicycle. Say the whole thing.");
for (let i = 0; i < 100; i++) { await page.waitForTimeout(100); const s = await st(); if (s.stop) break; }
await page.waitForTimeout(1200);
const pre = await st();
console.log("pre-escape len:", pre.txt.length, "streaming:", pre.stop);
const t0 = Date.now();
await page.keyboard.press("Escape");
let ms = -1;
for (let i = 0; i < 200; i++) { await page.waitForTimeout(50); const s = await st(); if (!s.stop && s.b !== "true") { ms = Date.now()-t0; break; } }
console.log("4.8 stop ms:", ms);
const at = await st();
console.log("4.8 at-stop tail:", at.txt.slice(-400));
await page.waitForTimeout(20000);
const later = await st();
console.log("4.8 +20s len:", later.txt.length, "vs at-stop", at.txt.length, "| resumed:", later.txt.length > at.txt.length + 20, "| busy:", later.b, later.stop);
console.log("4.8 +20s tail:", later.txt.slice(-500));
await page.screenshot({ path: "/tmp/chatlane/4.8.png", fullPage: true });
await ctx.close();
