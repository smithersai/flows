import { launch, resetStore, openSlash, composer } from "./lib.ts";
const { ctx, page } = await launch();
await resetStore(ctx, page);
const dump = async (q: string) => {
  await openSlash(page, q);
  const d = await page.evaluate(() => {
    const menu = document.querySelector('.slash-menu, [data-slot="slash-menu"], [class*="slash"]') as HTMLElement | null;
    const opts = Array.from(document.querySelectorAll('[role="option"], .slash-menu [role="option"], .slash-option'));
    const r = menu?.getBoundingClientRect();
    const cs = menu ? getComputedStyle(menu) : null;
    return {
      menuCls: menu?.className ?? null,
      rect: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) } : null,
      overflowY: cs?.overflowY, maxHeight: cs?.maxHeight,
      n: opts.length,
      items: opts.map(e => ({ t: (e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,70), sel: e.getAttribute("aria-selected"), gold: e.hasAttribute("data-gold") || (e as HTMLElement).dataset.gold !== undefined })),
      viewportH: window.innerHeight,
    };
  });
  console.log(`\n### "${q}" -> ${d.n} items | rect ${JSON.stringify(d.rect)} overflowY=${d.overflowY} maxHeight=${d.maxHeight} viewportH=${d.viewportH} cls=${d.menuCls}`);
  d.items.slice(0, 12).forEach((it, i) => console.log(`  ${i}${it.sel === "true" ? "*" : " "}${it.gold ? "G" : " "} ${it.t}`));
  if (d.n > 12) console.log(`  ... (${d.n - 12} more)`);
  return d;
};
for (const q of ["/", "/a", "/re", "/i", "/s", "/list", "/th", "/stop", "/chat", "/world", "/clear"]) await dump(q);
await page.screenshot({ path: "/tmp/chatlane/slash.png", fullPage: false });
await ctx.close();
