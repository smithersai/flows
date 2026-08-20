import { chromium, type BrowserContext, type Page } from "playwright";
export const BASE = "https://canary.smithers.sh";
export const PROFILE = "/tmp/canary-surfaces-profile";
export const open = async (opts: { reset?: boolean } = {}) => {
  const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1360, height: 950 } });
  const page = context.pages()[0] ?? (await context.newPage());
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (opts.reset) {
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    const client = await context.newCDPSession(page);
    await client.send("Storage.clearDataForOrigin", { origin: new URL(BASE).origin, storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers" });
    await client.detach().catch(() => {});
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
  }
  await page.waitForTimeout(4000);
  return { context, page, errors };
};
export const api = async (page: Page, path: string, init?: any) =>
  page.evaluate(async ([p, i]: any) => {
    const r = await fetch(p, i ?? undefined);
    return { status: r.status, body: await r.text() };
  }, [path, init ?? null]);
export const text = async (page: Page) => await page.locator("body").innerText();

export const composer = (page: any) => page.locator('textarea[aria-label="Chat message"]');
export const run = async (page: any, cmd: string, wait = 8000) => {
  const c = composer(page);
  await c.click();
  await c.fill(cmd);
  await page.waitForTimeout(400);
  const send = page.locator('[data-flow="send"]');
  if (await send.count() > 0 && await send.first().isEnabled().catch(() => false)) await send.first().click({ force: true });
  else await page.keyboard.press("Enter");
  await page.waitForTimeout(wait);
};
