import { chromium } from "playwright";

const themes = ["Night Owl", "Paper", "Fucory", "One", "GitHub", "Catppuccin", "Solarized", "Gruvbox", "Rosé Pine"];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await context.newPage();
await page.goto("https://canary.smithers.sh", { waitUntil: "networkidle" });
const composer = page.getByRole("textbox", { name: "Chat message" });
await composer.fill("/theme");
await composer.press("Enter");
await page.waitForTimeout(600);
await page.locator('[data-flow="surfaces"]').click();
await page.locator('[data-flow="world"]').click();
await page.waitForTimeout(600);

const results: unknown[] = [];
for (const theme of themes) {
	const button = page.locator('[data-flow="theme"]').filter({ has: page.getByText(theme, { exact: true }) });
	await button.click();
	await page.waitForTimeout(150);
	results.push(await page.evaluate((themeName) => {
		const style = (selector: string) => {
			const el = document.querySelector<HTMLElement>(selector);
			if (!el) return null;
			const css = getComputedStyle(el);
			return { color: css.color, background: css.backgroundColor, border: css.borderColor };
		};
		const selected = [...document.querySelectorAll<HTMLElement>('[data-flow="theme"]')]
			.filter((el) => /current/.test(el.innerText))
			.map((el) => el.innerText.trim());
		return {
			themeName,
			palette: document.documentElement.dataset.palette,
			mode: document.documentElement.dataset.theme,
			selected,
			chat: style(".sui-chat-transcript"),
			card: style(".smithers-card"),
			world: style(".world-surface"),
			editor: style(".ProseMirror"),
			cssVars: {
				background: getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
				foreground: getComputedStyle(document.documentElement).getPropertyValue("--foreground").trim(),
				primary: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
				accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
			},
		};
	}, theme));
	if (["Night Owl", "Catppuccin", "Gruvbox"].includes(theme)) {
		await page.screenshot({ path: `/tmp/round3-appearance-palette-${theme.toLowerCase().replaceAll(" ", "-")}.png`, fullPage: true });
	}
}

await page.addInitScript(() => {
	const trace: Array<{ palette: string | null; theme: string | null; at: number }> = [];
	(globalThis as any).__paletteTrace = trace;
	const record = () => trace.push({ palette: document.documentElement?.getAttribute("data-palette") ?? null, theme: document.documentElement?.getAttribute("data-theme") ?? null, at: performance.now() });
	record();
	new MutationObserver(record).observe(document.documentElement, { attributes: true, attributeFilter: ["data-palette", "data-theme"] });
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(300);
const persistence = await page.evaluate(() => ({
	palette: document.documentElement.dataset.palette,
	theme: document.documentElement.dataset.theme,
	trace: (globalThis as any).__paletteTrace,
}));

console.log(JSON.stringify({ results, persistence }, null, 2));
await context.close();
await browser.close();
