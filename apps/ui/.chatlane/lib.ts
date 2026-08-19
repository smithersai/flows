import { chromium, type BrowserContext, type Page } from "playwright";
export const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
export const PROFILE = process.env.CHAT_PROFILE ?? "/tmp/canary-chat-profile";

export const launch = async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: process.env.HEADED !== "1", viewport: { width: 1400, height: 1000 },
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  let s = await page.evaluate(async () => (await fetch("/api/auth/session")).text());
  if (!s.includes("login")) {
    await page.locator('[data-flow="auth.sign-in"]').last().click({ force: true });
    await page.waitForTimeout(9000);
    const a = page.locator('button:has-text("Authorize")').first();
    if (await a.isVisible().catch(() => false)) { await a.click(); await page.waitForTimeout(9000); }
    await page.waitForTimeout(3000);
    s = await page.evaluate(async () => (await fetch("/api/auth/session")).text());
  }
  // Guard: the identity upstream intermittently answers allowlisted:false.
  for (let i = 0; i < 10 && !s.includes('"allowlisted":true'); i++) {
    await page.waitForTimeout(2000);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    s = await page.evaluate(async () => (await fetch("/api/auth/session", { cache: "no-store" })).text());
  }
  console.log("[session]", s);
  return { ctx, page };
};
export const composer = (page: Page) => page.locator("textarea").first();
export const resetStore = async (ctx: BrowserContext, page: Page) => {
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  const c = await ctx.newCDPSession(page);
  await c.send("Storage.clearDataForOrigin", { origin: BASE, storageTypes: "local_storage,indexeddb,cache_storage,websql,file_systems,service_workers" });
  await c.detach().catch(() => {});
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
};
export const send = async (page: Page, text: string) => {
  const b = composer(page); await b.click(); await b.fill(text); await page.waitForTimeout(200); await page.keyboard.press("Enter");
};
export const settle = async (page: Page, budget = 60000, stableNeeded = 6) => {
  let last = -1, stable = 0; const t0 = Date.now();
  while (Date.now() - t0 < budget) {
    await page.waitForTimeout(500);
    const n = await page.evaluate(() => document.body.innerText.length);
    if (n === last) { stable++; if (stable >= stableNeeded) return true; } else { stable = 0; last = n; }
  }
  return false;
};
export const openSlash = async (page: Page, q: string) => {
  const b = composer(page); await b.click(); await b.fill("");
  await page.mouse.move(1350, 20); await page.waitForTimeout(200);
  await page.keyboard.type(q, { delay: 30 }); await page.waitForTimeout(800);
};
