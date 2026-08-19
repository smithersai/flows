import { launch, resetStore, send, composer } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
// 4.11 second prompt while streaming
await send(page, "Write a 900 word essay about the history of the bicycle. Say the whole thing.");
for (let i = 0; i < 100; i++) { await page.waitForTimeout(100); if (await page.evaluate(() => !!document.querySelector('[aria-label="Stop generating"]'))) break; }
await page.waitForTimeout(1500);
const box = composer(page);
const disabled = await box.isDisabled();
console.log("4.11 composer disabled while streaming:", disabled);
await box.click(); await box.fill("SECOND PROMPT: say the word ZEBRA.");
await page.waitForTimeout(200);
await page.keyboard.press("Enter");
await page.waitForTimeout(2000);
const mid = await page.evaluate(() => ({
  users: Array.from(document.querySelectorAll('[data-role="user"]')).map(e => (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,50)),
  streams: document.querySelectorAll('[aria-label="Stop generating"]').length,
  draft: (document.querySelector("textarea") as HTMLTextAreaElement)?.value,
  notes: Array.from(document.querySelectorAll('.sui-marker, .bubble-system-note')).map(e => (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,80)),
}));
console.log("4.11 mid-stream:", JSON.stringify(mid, null, 1));
await page.waitForTimeout(45000);
const after = await page.evaluate(() => ({
  users: Array.from(document.querySelectorAll('[data-role="user"]')).map(e => (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,50)),
  assts: Array.from(document.querySelectorAll('[data-role="assistant"]')).map(e => (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,60)),
  zebra: document.body.innerText.includes("ZEBRA"),
}));
console.log("4.11 after:", JSON.stringify(after, null, 1));
await page.screenshot({ path: "/tmp/chatlane/4.11.png", fullPage: true });
await ctx.close();
