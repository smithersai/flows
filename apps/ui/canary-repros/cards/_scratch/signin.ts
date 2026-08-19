import { open } from "./drv.ts";
const { context, page } = await open({ reset: false });
let s: any = await page.evaluate(async () => (await fetch("/api/auth/session")).json().catch(()=>null));
console.log("before:", JSON.stringify(s));
if (!s?.login) {
  await page.goto("https://canary.smithers.sh/api/auth/github/start", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  console.log("url:", page.url());
  const authorize = page.locator('button:has-text("Authorize"), input[name="authorize"]').first();
  if (await authorize.isVisible().catch(()=>false)) { await authorize.click({force:true}); await page.waitForTimeout(6000); }
  console.log("url2:", page.url());
  console.log("txt:", (await page.locator("body").innerText()).slice(0,600));
  await page.waitForURL(/canary\.smithers\.sh\/?($|\?)/, { timeout: 60000 }).catch(()=>{});
  await page.waitForTimeout(6000);
  s = await page.evaluate(async () => (await fetch("/api/auth/session")).json().catch(()=>null));
  console.log("after:", JSON.stringify(s));
}
console.log("BODY:\n" + (await page.locator("body").innerText()).slice(0, 2000));
await page.screenshot({ path: "/tmp/cards-lane/signin.png", fullPage: true });
await context.close();
