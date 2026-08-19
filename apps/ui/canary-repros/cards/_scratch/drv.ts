import { chromium, type Page } from "playwright";

export const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.CARDS_PROFILE ?? "/tmp/canary-cards-profile";

export const open = async (opts?: { width?: number; height?: number; reset?: boolean }) => {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: opts?.width ?? 1280, height: opts?.height ?? 950 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  if (opts?.reset !== false) {
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Storage.clearDataForOrigin", {
      origin: new URL(BASE).origin,
      storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers",
    });
    await cdp.detach().catch(() => {});
  }
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  let s: any = await page.evaluate(async () => (await fetch("/api/auth/session")).json().catch(() => null));
  if (!s?.login) {
    await page.goto(`${BASE}/api/auth/github/start`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    const authorize = page.locator('button:has-text("Authorize"), input[name="authorize"]').first();
    if (await authorize.isVisible().catch(() => false)) { await authorize.click({ force: true }); await page.waitForTimeout(6000); }
    await page.waitForTimeout(5000);
    s = await page.evaluate(async () => (await fetch("/api/auth/session")).json().catch(() => null));
  }
  await page.waitForTimeout(3000);
  return { context, page, errors, session: s };
};

export const send = async (page: Page, text: string, settleMs = 8000) => {
  const composer = page.locator("textarea").first();
  await composer.click({ force: true });
  await composer.fill("");
  await page.keyboard.type(text, { delay: 4 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(settleMs);
};

export const cards = async (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-kind]")).map((el) => ({
      kind: el.getAttribute("data-kind"),
      status: el.getAttribute("data-status"),
      max: el.getAttribute("data-maximized"),
      text: (el as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 600),
    })));

export const bodyText = async (page: Page) => page.locator("body").innerText();
