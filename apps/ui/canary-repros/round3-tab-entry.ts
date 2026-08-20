import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("https://canary.smithers.sh", { waitUntil: "networkidle" });
await page.bringToFront();
await page.evaluate(() => window.focus());
const stops: unknown[] = [];
for (let i = 0; i < 12; i += 1) {
	await page.keyboard.press("Tab");
	stops.push(await page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		return { tag: el?.tagName, flow: el?.dataset.flow, name: (el?.innerText || el?.getAttribute("aria-label") || "").trim().slice(0, 100) };
	}));
}
console.log(JSON.stringify(stops, null, 2));
await browser.close();
