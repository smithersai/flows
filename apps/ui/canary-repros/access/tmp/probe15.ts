import { chromium } from "playwright";
const BASE = "https://canary.smithers.sh";
const ctx = await chromium.launchPersistentContext("/tmp/canary-access-profile", { headless: true, viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
const post = (path: string, body: unknown) => page.evaluate(async ([p, b]: [string, unknown]) => {
  const r = await fetch(p as string, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.text() };
}, [path, body] as [string, unknown]);
const get = (path: string) => page.evaluate(async (p) => {
  const r = await fetch(p as string);
  return { status: r.status, body: (await r.text()).slice(0, 400) };
}, path);
const sess = () => page.evaluate(async () => (await fetch("/api/auth/session")).json());
const reg = () => page.evaluate(() => (document.querySelector("[data-flows]")?.getAttribute("data-flows") ?? "").split(" ").filter(Boolean));
try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  console.log("BASELINE session:", JSON.stringify(await sess()));
  console.log("BASELINE /api/admin/requests:", JSON.stringify(await get("/api/admin/requests")));
  console.log("BASELINE admin flows in registry:", JSON.stringify((await reg()).filter(f => f.startsWith("admin."))));
  // de-allowlist self
  console.log("REMOVE:", JSON.stringify(await post("/api/admin/allowlist", { login: "codeplanesmithers", action: "remove" })));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  const s = await sess();
  console.log("NON-ALLOWLISTED session:", JSON.stringify(s));
  console.log("registry admin flows:", JSON.stringify((await reg()).filter(f => f.startsWith("admin."))));
  console.log("GET /api/admin/requests:", JSON.stringify(await get("/api/admin/requests")));
  console.log("GET /api/admin/health:", JSON.stringify(await get("/api/admin/health")));
  console.log("GET /api/reco/first-run:", JSON.stringify(await get("/api/reco/first-run")));
  console.log("--- BODY (non-allowlisted) ---\n" + (await page.locator("body").innerText()).slice(0, 2000));
  await page.screenshot({ path: "/tmp/canary-access/1.5-nonallowlisted.png", fullPage: true });
  // 1.4 request access
  const composer = page.locator("textarea.sui-chat-composer-input");
  await composer.click();
  await page.keyboard.type("/auth.request-access", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(6000);
  console.log("--- AFTER request-access ---\n" + (await page.locator("body").innerText()).slice(0, 2500));
  await page.screenshot({ path: "/tmp/canary-access/1.4-requested.png", fullPage: true });
} finally {
  console.log("RESTORE:", JSON.stringify(await post("/api/admin/allowlist", { login: "codeplanesmithers", action: "add" })));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  console.log("RESTORED session:", JSON.stringify(await sess()));
  console.log("ADMIN REQUESTS after restore:", JSON.stringify(await get("/api/admin/requests")));
  await ctx.close();
}
