import { launch, resetStore, send } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
const waitAnswer = async (before: number, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { await page.waitForTimeout(500);
    const a = await page.evaluate((b) => { const l = Array.from(document.querySelectorAll('[data-role="assistant"]')); return l.length > b ? (l[l.length-1] as HTMLElement).innerText.replace(/\s+/g," ") : ""; }, before);
    if (a && !/responding/i.test(a)) { await page.waitForTimeout(2500); return a; } }
  return "<NONE>";
};
let before = await page.evaluate(() => document.querySelectorAll('[data-role="assistant"]').length);
await send(page, "Think carefully step by step, then say the word ELEPHANT.");
console.log("answer:", (await waitAnswer(before)).slice(0, 200));
// 4.3 reasoning block
const reasoning = await page.evaluate(() => {
  const cands = Array.from(document.querySelectorAll('details, [data-slot*="reason"], [class*="reason"], [class*="thinking"], [data-slot="disclosure"]'));
  return cands.map(e => ({ tag: e.tagName, cls: (e as HTMLElement).className, open: (e as HTMLDetailsElement).open ?? null, txt: (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,120), h: (e as HTMLElement).getBoundingClientRect().height }));
});
console.log("4.3 reasoning candidates:", JSON.stringify(reasoning, null, 1).slice(0, 1500));
// 4.4 tool render / raw echo
const bodyTxt = await page.locator("body").innerText();
console.log("4.4 raw-json-echo present:", /"type"\s*:\s*"tool|ctx\.call\(|```flow/.test(bodyTxt), "| flow fence in body:", bodyTxt.includes("```flow"));
const toolEls = await page.evaluate(() => Array.from(document.querySelectorAll('[data-slot*="tool"], [class*="tool-call"], [class*="sui-tool"]')).map(e => ({ cls: (e as HTMLElement).className, txt: (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,100) })));
console.log("4.4 tool elements:", JSON.stringify(toolEls).slice(0, 800));
// 4.5 copy
const copyBtns = page.locator('[data-flow="copy-message"]');
console.log("4.5 copy buttons:", await copyBtns.count());
await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(e => console.log("perm err", e.message));
await copyBtns.last().click();
await page.waitForTimeout(400);
const labelAfter = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('[data-flow="copy-message"]')).pop() as HTMLElement; return { aria: b?.getAttribute("aria-label"), title: b?.getAttribute("title"), txt: b?.innerText, near: (b?.parentElement as HTMLElement)?.innerText?.replace(/\s+/g," ").slice(0,80) }; });
console.log("4.5 after click:", JSON.stringify(labelAfter));
const clip = await page.evaluate(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return "ERR " + (e as Error).message; } });
console.log("4.5 clipboard:", JSON.stringify(clip.slice(0, 200)));
await page.waitForTimeout(3000);
const labelLater = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('[data-flow="copy-message"]')).pop() as HTMLElement; return { aria: b?.getAttribute("aria-label"), title: b?.getAttribute("title") }; });
console.log("4.5 after 3s:", JSON.stringify(labelLater));
await page.screenshot({ path: "/tmp/chatlane/4.3-4.5.png", fullPage: true });
await ctx.close();
