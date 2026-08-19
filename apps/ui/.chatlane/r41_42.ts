import { launch, resetStore, send, settle, composer } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);

// 4.1 streaming promptness
const t0 = Date.now();
await send(page, "Say the word BANANA and then count from 1 to 40, one number per line.");
let first = -1;
const base = await page.evaluate(() => document.body.innerText.length);
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(250);
  const n = await page.evaluate(() => document.body.innerText.length);
  if (n > base + 30) { first = Date.now() - t0; break; }
}
console.log("4.1 first-visible-growth ms:", first);
const doneAt0 = Date.now();
await settle(page, 90000);
console.log("4.1 settle ms:", Date.now() - doneAt0, "total", Date.now() - t0);
const txt1 = await page.locator("body").innerText();
console.log("4.1 tail:", txt1.slice(-600));
await page.screenshot({ path: "/tmp/chatlane/4.1.png" });

// 4.2 markdown
await resetStore(ctx, page);
const LONG = "Z".repeat(220);
const prompt = [
  "Reply with EXACTLY this markdown and nothing else (no preface, no commentary):",
  "",
  "# Heading One",
  "## Heading Two",
  "- item alpha",
  "- item beta",
  "",
  "| Col A | Col B |",
  "|---|---|",
  "| 1 | 2 |",
  "| 3 | 4 |",
  "",
  "A [link](https://example.com) and inline `code_sample` here.",
  "",
  "```ts",
  "const x: number = 1",
  "```",
  "",
  LONG,
].join("\n");
await composer(page).click();
await composer(page).fill(prompt);
await page.waitForTimeout(300);
await page.keyboard.press("Enter");
await settle(page, 120000);
const m = await page.evaluate(() => {
  const q = (s: string) => document.querySelectorAll(s).length;
  const asst = Array.from(document.querySelectorAll('[data-role="assistant"]'));
  const last = asst[asst.length - 1] as HTMLElement | undefined;
  return {
    tables: q("table"), cells: q("td") + q("th"), rows: q("tr"),
    h1: q("h1") + q(".sui-md-h1"), h2: q("h2") + q(".sui-md-h2"),
    ul: q("ul"), li: q("li"), a: q('a[href*="example.com"]'), code: q("code"), pre: q("pre"),
    scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
    lastHtml: last ? last.innerHTML.slice(0, 3000) : "NONE",
  };
});
console.log("4.2 metrics:", JSON.stringify({ ...m, lastHtml: undefined }, null, 1));
console.log("4.2 lastHtml:\n", m.lastHtml);
await page.screenshot({ path: "/tmp/chatlane/4.2.png", fullPage: true });
await ctx.close();
