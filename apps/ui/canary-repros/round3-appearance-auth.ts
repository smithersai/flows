import { chromium } from "playwright";

const context = await chromium.launchPersistentContext("/tmp/round3-appearance-profile", {
	headless: true,
	viewport: { width: 1440, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://canary.smithers.sh", { waitUntil: "networkidle", timeout: 60_000 });
const signIn = page.getByRole("button", { name: /Sign in with GitHub|Continue with GitHub/ }).first();
await signIn.click();
await page.waitForTimeout(4_000);
console.log(JSON.stringify({ url: page.url(), body: (await page.locator("body").innerText()).slice(0, 5000) }, null, 2));
await page.screenshot({ path: "/tmp/round3-appearance-auth.png", fullPage: true });
await context.close();
