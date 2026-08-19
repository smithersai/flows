import { launch, resetStore, send, composer } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
const st = () => page.evaluate(() => ({
  stop: !!document.querySelector('[aria-label="Stop generating"]'),
  busy: document.querySelector('[data-slot="chat-transcript"]')?.getAttribute("aria-busy"),
  users: document.querySelectorAll('[data-role="user"]').length,
  draft: (document.querySelector("textarea") as HTMLTextAreaElement)?.value ?? "",
  disabled: (document.querySelector("textarea") as HTMLTextAreaElement)?.disabled,
  sendBtn: (document.querySelector('[data-flow="send"]') as HTMLButtonElement)?.disabled,
  placeholder: (document.querySelector("textarea") as HTMLTextAreaElement)?.placeholder,
}));
await send(page, "Write a 1200 word essay about the history of the bicycle. Say the whole thing.");
for (let i = 0; i < 100; i++) { await page.waitForTimeout(100); if ((await st()).stop) break; }
console.log("streaming state:", JSON.stringify(await st()));
const box = composer(page);
await box.click(); await box.fill("SECOND: say ZEBRA.");
console.log("before Enter:", JSON.stringify(await st()));
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);
console.log("after Enter:", JSON.stringify(await st()));
const notes = await page.evaluate(() => Array.from(document.querySelectorAll('[class*="marker"],[class*="note"],[role="status"],[role="alert"],[class*="toast"]')).map(e => (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,120)).filter(Boolean));
console.log("notes:", JSON.stringify(notes));
await page.waitForTimeout(60000);
console.log("final:", JSON.stringify(await st()));
console.log("zebra in body:", (await page.locator("body").innerText()).includes("ZEBRA"));
await page.screenshot({ path: "/tmp/chatlane/4.11.png", fullPage: true });
await ctx.close();
