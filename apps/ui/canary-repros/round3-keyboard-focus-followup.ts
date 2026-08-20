import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto("https://canary.smithers.sh", { waitUntil: "networkidle" });
const first = page.locator('[data-flow="auth.sign-in"]').first();
await first.focus();
const states: unknown[] = [];
for (let i = 0; i < 12; i += 1) {
	states.push(await page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		const css = el ? getComputedStyle(el) : null;
		return {
			tag: el?.tagName,
			flow: el?.dataset.flow,
			name: (el?.innerText || el?.getAttribute("aria-label") || "").trim().slice(0, 100),
			outline: css ? `${css.outlineStyle} ${css.outlineWidth} ${css.outlineColor}` : null,
			boxShadow: css?.boxShadow,
			border: css ? `${css.borderStyle} ${css.borderWidth} ${css.borderColor}` : null,
		};
	}));
	if (i === 0) await page.screenshot({ path: "/tmp/round3-appearance-forced-focus.png" });
	await page.keyboard.press("Tab");
}
const before = await page.evaluate(() => ({ body: document.body.innerText, flows: [...document.querySelectorAll<HTMLElement>("[data-flow]")].map((el) => el.dataset.flow) }));
await page.keyboard.press("Control+Shift+D");
await page.waitForTimeout(300);
const after = await page.evaluate(() => ({ body: document.body.innerText, flows: [...document.querySelectorAll<HTMLElement>("[data-flow]")].map((el) => el.dataset.flow) }));
console.log(JSON.stringify({ states, shortcut: { before, after } }, null, 2));
await browser.close();
