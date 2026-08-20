import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
for (const command of ["/theme", "/dark-mode"]) {
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
	const page = await context.newPage();
	await page.goto("https://canary.smithers.sh", { waitUntil: "networkidle", timeout: 60_000 });
	const composer = page.getByRole("textbox", { name: /Chat message|Message Smithers/ });
	await composer.fill(command);
	await composer.press("Enter");
	await page.waitForTimeout(1_500);
	console.log(JSON.stringify({
		command,
		url: page.url(),
		body: (await page.locator("body").innerText()).slice(0, 10000),
		htmlTheme: await page.locator("html").getAttribute("data-theme"),
		palette: await page.locator("html").getAttribute("data-palette"),
		flows: await page.locator("[data-flow]").evaluateAll((els) => els.map((el) => ({ flow: (el as HTMLElement).dataset.flow, text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 100) }))),
	}, null, 2));
	await page.screenshot({ path: `/tmp/round3-appearance-${command.slice(1)}.png`, fullPage: true });
	await context.close();
}
await browser.close();
