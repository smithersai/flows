import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto("https://canary.smithers.sh", { waitUntil: "networkidle" });
await page.locator('[data-flow="surfaces"]').click();
await page.waitForTimeout(300);
console.log(JSON.stringify({
	body: await page.locator("body").innerText(),
	flows: await page.locator("[data-flow]").evaluateAll((els) => els.map((el) => ({ flow: (el as HTMLElement).dataset.flow, text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 120) }))),
}, null, 2));
await page.screenshot({ path: "/tmp/round3-appearance-surfaces.png", fullPage: true });
await browser.close();
