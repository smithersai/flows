import { open, api, text } from "./drv.ts";
const { context, page, errors } = await open();
const s = await api(page, "/api/auth/session");
console.log("SESSION-BEFORE", s.status, s.body.slice(0,200));
if (!s.body.includes('"login"')) {
  await page.locator('[data-flow="auth.sign-in"]').last().click({ force: true });
  await page.waitForURL(/github\.com|canary\.smithers\.sh/, { timeout: 40000 });
  console.log("URL after click:", page.url());
  const auth = page.locator('button:has-text("Authorize"), input[value*="Authorize"]').first();
  if (await auth.isVisible().catch(() => false)) { await auth.click(); console.log("clicked authorize"); }
  await page.waitForURL(/canary\.smithers\.sh/, { timeout: 60000 }).catch((e) => console.log("waitURL err", String(e).slice(0,200)));
  await page.waitForTimeout(6000);
}
console.log("FINAL URL", page.url());
const s2 = await api(page, "/api/auth/session");
console.log("SESSION-AFTER", s2.status, s2.body.slice(0,400));
const w = await api(page, "/api/reco/watched");
console.log("WATCHED", w.status, w.body.slice(0,500));
console.log("BODY>>>", (await text(page)).slice(0,1500));
await context.close();
