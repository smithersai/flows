import { chromium } from "playwright";
const BASE = "https://canary.smithers.sh";
const ctx = await chromium.launchPersistentContext("/tmp/canary-access-profile", { headless: true, viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
const post = (path: string, body: unknown) => page.evaluate(async ([p, b]: [string, unknown]) => {
  const r = await fetch(p as string, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.text() };
}, [path, body] as [string, unknown]);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
try {
  console.log("REMOVE:", JSON.stringify(await post("/api/admin/allowlist", { login: "codeplanesmithers", action: "remove" })));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  const composer = page.locator("textarea.sui-chat-composer-input");
  await composer.click();
  await page.keyboard.type("/auth.request-access", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(6000);
  const t1 = await page.locator("body").innerText();
  console.log("REQUEST-ACCESS SAYS:", t1.split("\n").filter(l => /request/i.test(l)).slice(0,4).join(" / "));
  await composer.click();
  await page.keyboard.type("/admin.requests", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(6000);
  const t2 = await page.locator("body").innerText();
  const idx = t2.indexOf("Request-access queue");
  console.log("ADMIN REQUESTS CARD:\n" + t2.slice(idx, idx + 500));
  await page.screenshot({ path: "/tmp/canary-access/1.4-queue.png", fullPage: true });
} finally {
  console.log("RESTORE:", JSON.stringify(await post("/api/admin/allowlist", { login: "codeplanesmithers", action: "add" })));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  console.log("RESTORED:", JSON.stringify(await page.evaluate(async () => (await fetch("/api/auth/session")).json())));
  await ctx.close();
}
