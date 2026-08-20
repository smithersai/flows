import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
await page.goto("https://canary.smithers.sh", { waitUntil: "networkidle" });
const composer = page.getByRole("textbox", { name: "Chat message" });
await composer.fill("/theme");
await composer.press("Enter");
await page.waitForTimeout(800);
await page.locator('[data-flow="surfaces"]').click();
await page.locator('[data-flow="world"]').click();
await page.waitForTimeout(800);
console.log(JSON.stringify(await page.evaluate(() => ({
	body: document.body.innerText,
	classes: [...document.querySelectorAll<HTMLElement>("body *")].filter((el) => /World|Color themes|Night Owl/.test(el.innerText) && el.children.length < 12).slice(0, 100).map((el) => ({ tag: el.tagName, cls: el.className, flow: el.dataset.flow, text: el.innerText.slice(0, 100) })),
	inputs: [...document.querySelectorAll<HTMLElement>("input,textarea,[contenteditable=true]")].map((el) => ({ tag: el.tagName, cls: el.className, label: el.getAttribute("aria-label"), placeholder: el.getAttribute("placeholder") })),
})), null, 2));
await page.screenshot({ path: "/tmp/round3-appearance-theme-world.png", fullPage: true });
await browser.close();
