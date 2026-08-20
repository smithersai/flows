import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto("https://canary.smithers.sh", { waitUntil: "networkidle" });
await page.getByRole("textbox", { name: "Chat message" }).focus();
console.log(JSON.stringify(await page.evaluate(() => {
	const el = document.activeElement as HTMLElement;
	const parent = el.parentElement as HTMLElement;
	const shell = el.closest<HTMLElement>(".sui-chat-composer,form") ?? parent;
	return [el, parent, shell].map((node) => { const css = getComputedStyle(node); return { cls: node.className, outline: css.outline, boxShadow: css.boxShadow, border: css.border }; });
}), null, 2));
await page.screenshot({ path: "/tmp/round3-appearance-composer-focus.png" });
await browser.close();
