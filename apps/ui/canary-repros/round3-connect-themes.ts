import { chromium } from "playwright";
const context = await chromium.launchPersistentContext("/tmp/round3-appearance-profile", { headless: true, viewport: { width: 1440, height: 1200 } });
const page = context.pages()[0] ?? await context.newPage();
await page.goto("https://canary.smithers.sh", { waitUntil: "networkidle" });
const composer = page.getByRole("textbox", { name: "Chat message" });
await composer.fill("/theme");
await composer.press("Enter");
await page.waitForTimeout(500);
await page.locator('[data-flow="connect"]').first().click();
await page.waitForTimeout(700);
const results: unknown[] = [];
for (const theme of ["Night Owl", "Paper", "Gruvbox"]) {
	await page.locator('[data-flow="theme"]').filter({ has: page.getByText(theme, { exact: true }) }).click();
	await page.waitForTimeout(150);
	results.push(await page.evaluate((themeName) => {
		const surfaces = [...document.querySelectorAll<HTMLElement>('section,[class*="surface"],[class*="connector"],[class*="connect"]')]
			.filter((el) => /Connect|GitHub|repository/i.test(el.innerText))
			.slice(0, 20)
			.map((el) => { const css = getComputedStyle(el); return { tag: el.tagName, cls: el.className, text: el.innerText.slice(0, 100), color: css.color, background: css.backgroundColor }; });
		return { themeName, palette: document.documentElement.dataset.palette, surfaces };
	}, theme));
}
console.log(JSON.stringify({ body: (await page.locator("body").innerText()).slice(0, 10000), results }, null, 2));
await page.screenshot({ path: "/tmp/round3-appearance-connect-gruvbox.png", fullPage: true });
await context.close();
