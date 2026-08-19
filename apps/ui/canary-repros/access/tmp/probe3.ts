import { chromium } from "playwright";
const BASE = "https://canary.smithers.sh";
const ctx = await chromium.launchPersistentContext("/tmp/canary-access-profile", { headless: true, viewport: { width: 1280, height: 950 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto("about:blank");
const client = await ctx.newCDPSession(page);
await client.send("Storage.clearDataForOrigin", { origin: BASE, storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers" });
await client.detach().catch(()=>{});
const jar = await ctx.cookies();
await ctx.clearCookies();
await ctx.addCookies(jar.filter(c => !c.domain.includes("smithers.sh")));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const composer = page.locator("textarea.sui-chat-composer-input");
const listing = async (q: string) => {
  await composer.fill("");
  await composer.click();
  await page.keyboard.type(q, { delay: 30 });
  await page.waitForTimeout(900);
  return await page.evaluate(() => {
    const menu = document.querySelector('[class*="menu"],[role="listbox"]');
    const nodes = Array.from(document.querySelectorAll('[data-flow-menu-item], [role="option"]'));
    if (nodes.length) return nodes.map(n => (n as HTMLElement).innerText.replace(/\n/g," | "));
    return null;
  });
};
for (const q of ["/", "/sign", "/auth", "/bill", "/keys", "/issues", "/repos", "/env", "/notif", "/prs"]) {
  const l = await listing(q);
  console.log(q, "=>", JSON.stringify(l));
}
await ctx.close();
