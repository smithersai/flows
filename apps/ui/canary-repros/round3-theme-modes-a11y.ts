import { chromium } from "playwright";
const themes = ["Night Owl", "Paper", "Fucory", "One", "GitHub", "Catppuccin", "Solarized", "Gruvbox", "Rosé Pine"];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, colorScheme: "light" });
const page = await context.newPage();
await page.goto("https://canary.smithers.sh", { waitUntil: "networkidle" });
const composer = page.getByRole("textbox", { name: "Chat message" });
await composer.fill("/theme");
await composer.press("Enter");
await page.waitForTimeout(500);
await page.locator('[data-flow="surfaces"]').click();
await page.locator('[data-flow="world"]').click();
await page.waitForTimeout(500);
const axeSource = await (await fetch("https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.3/axe.min.js")).text();
await page.addScriptTag({ content: axeSource });
const results: unknown[] = [];
for (const theme of themes) {
	await page.locator('[data-flow="theme"]').filter({ has: page.getByText(theme, { exact: true }) }).click();
	for (const mode of ["light", "dark"] as const) {
		const current = await page.locator("html").getAttribute("data-theme");
		if (current !== mode) await page.locator('[data-flow="dark-mode"]').click();
		await page.waitForTimeout(100);
		results.push(await page.evaluate(async ({ themeName, modeName }) => {
			const axeResult = await (globalThis as any).axe.run(document, { runOnly: { type: "rule", values: ["color-contrast"] } });
			const describe = (el: HTMLElement) => {
				const css = getComputedStyle(el);
				return { text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 100), color: css.color, background: css.backgroundColor, opacity: css.opacity };
			};
			return {
				themeName,
				modeName,
				palette: document.documentElement.dataset.palette,
				mode: document.documentElement.dataset.theme,
				violations: axeResult.violations.map((v: any) => ({ id: v.id, nodes: v.nodes.map((n: any) => ({ target: n.target, summary: n.failureSummary })) })),
				status: [...document.querySelectorAll<HTMLElement>(".smithers-card-status,.world-document-meta span")].map(describe),
				disabled: [...document.querySelectorAll<HTMLElement>("button:disabled,input:disabled,textarea:disabled")].map(describe),
				codeBlocks: document.querySelectorAll("pre,code").length,
				diffs: document.querySelectorAll('[class*="diff"],[data-diff]').length,
			};
		}, { themeName: theme, modeName: mode }));
	}
}
await page.screenshot({ path: "/tmp/round3-appearance-allthemes-final-dark.png", fullPage: true });
console.log(JSON.stringify(results, null, 2));
await context.close();
await browser.close();
