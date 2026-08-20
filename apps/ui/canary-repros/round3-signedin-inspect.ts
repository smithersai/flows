import { chromium } from "playwright";
const context = await chromium.launchPersistentContext("/tmp/round3-appearance-profile", { headless: true, viewport: { width: 1440, height: 1000 } });
const page = context.pages()[0] ?? await context.newPage();
await page.goto("https://canary.smithers.sh", { waitUntil: "networkidle" });
const composer = page.getByRole("textbox", { name: "Chat message" });
await composer.fill("/");
await page.waitForTimeout(500);
console.log(JSON.stringify({
	body: (await page.locator("body").innerText()).slice(0, 12000),
	flows: await page.locator("[data-flow]").evaluateAll((els) => els.map((el) => ({ flow: (el as HTMLElement).dataset.flow, text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 120) }))),
}, null, 2));
await context.close();
