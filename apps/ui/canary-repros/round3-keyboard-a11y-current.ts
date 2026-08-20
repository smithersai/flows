import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto("https://canary.smithers.sh", { waitUntil: "networkidle" });
const output: Record<string, unknown> = {};

const tabStops: unknown[] = [];
for (let index = 0; index < 22; index += 1) {
	await page.keyboard.press("Tab");
	tabStops.push(await page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		if (!el) return null;
		const css = getComputedStyle(el);
		return {
			index: (globalThis as any).__tabIndex = ((globalThis as any).__tabIndex ?? 0) + 1,
			tag: el.tagName,
			flow: el.dataset.flow ?? null,
			name: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 120),
			outline: `${css.outlineStyle} ${css.outlineWidth} ${css.outlineColor}`,
			boxShadow: css.boxShadow,
			border: `${css.borderStyle} ${css.borderWidth} ${css.borderColor}`,
			visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
		};
	}));
	const flow = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.flow ?? "");
	if (flow === "send") await page.screenshot({ path: "/tmp/round3-appearance-current-focus.png" });
}
output.tabStops = tabStops;

const beforeShortcut = await page.locator("body").innerText();
await page.keyboard.press("Control+Shift+D");
await page.waitForTimeout(200);
output.nonAdminShortcut = { changed: beforeShortcut !== await page.locator("body").innerText(), devtoolsText: (await page.locator("body").innerText()).includes("Devtools") };

await page.locator('[data-flow="surfaces"]').click();
const surfaceMenuOpen = await page.locator("body").innerText();
await page.keyboard.press("Escape");
const surfaceMenuClosed = await page.locator("body").innerText();
output.escapeMenu = { openedWorldChoice: surfaceMenuOpen.includes("World"), closedWorldChoice: !surfaceMenuClosed.includes("World") };

const composer = page.getByRole("textbox", { name: "Chat message" });
await page.evaluate(() => {
	const events: Array<{ text: string; at: number }> = [];
	(globalThis as any).__liveEvents = events;
	const read = () => {
		for (const el of document.querySelectorAll<HTMLElement>("[aria-live]")) events.push({ text: el.innerText.trim().slice(0, 500), at: performance.now() });
	};
	read();
	new MutationObserver(read).observe(document.body, { childList: true, subtree: true, characterData: true });
});
await composer.fill("/theme");
await composer.press("Enter");
await page.waitForTimeout(1_000);
output.liveEvents = await page.evaluate(() => (globalThis as any).__liveEvents);
output.accessibility = await page.evaluate(() => ({
	conversation: [...document.querySelectorAll<HTMLElement>('[role="region"][aria-label="Conversation messages"],[role="log"]')].map((el) => ({ role: el.getAttribute("role"), label: el.getAttribute("aria-label") })),
	composer: [...document.querySelectorAll<HTMLElement>('textarea[aria-label="Chat message"],input[aria-label="Message Smithers"]')].map((el) => ({ tag: el.tagName, label: el.getAttribute("aria-label") })),
	live: [...document.querySelectorAll<HTMLElement>("[aria-live]")].map((el) => ({ live: el.getAttribute("aria-live"), text: el.innerText.trim().slice(0, 500) })),
	card: [...document.querySelectorAll<HTMLElement>(".smithers-card")].map((el) => ({ tag: el.tagName, aria: el.getAttribute("aria-label"), heading: el.querySelector("h1,h2,h3,[role=heading]")?.textContent?.trim() ?? null })),
	buttonsMissingName: [...document.querySelectorAll<HTMLButtonElement>("button")].filter((el) => !(el.innerText.trim() || el.getAttribute("aria-label") || el.getAttribute("title"))).length,
}));

const max = page.locator('[data-flow="card.maximize"]');
if (await max.count()) {
	await max.click();
	await page.waitForTimeout(200);
	const maximized = { minimizeCount: await page.locator('[data-flow="card.minimize"]').count(), body: (await page.locator("body").innerText()).slice(0, 2000) };
	await page.keyboard.press("Escape");
	await page.waitForTimeout(200);
	output.escapeMaximizedCard = { maximized, afterEscape: { minimizeCount: await page.locator('[data-flow="card.minimize"]').count(), maximizeCount: await page.locator('[data-flow="card.maximize"]').count() } };
}

await browser.close();

const authBrowser = await chromium.launch({ headless: true });
const authPage = await authBrowser.newPage({ viewport: { width: 1440, height: 1000 } });
await authPage.goto("https://canary.smithers.sh", { waitUntil: "networkidle" });
const firstRunTabs: unknown[] = [];
for (let index = 0; index < 15; index += 1) {
	await authPage.keyboard.press("Tab");
	const stop = await authPage.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		return { flow: el?.dataset.flow ?? null, name: (el?.innerText || el?.getAttribute("aria-label") || "").trim().slice(0, 100) };
	});
	firstRunTabs.push(stop);
	if ((stop as any).flow === "auth.sign-in") {
		await authPage.keyboard.press("Enter");
		break;
	}
}
await authPage.waitForTimeout(3_000);
output.keyboardFirstRun = {
	tabs: firstRunTabs,
	url: authPage.url().replace(/([?&]state=)[^&]+/, "$1<redacted>"),
	body: (await authPage.locator("body").innerText()).slice(0, 3000),
};
await authBrowser.close();

console.log(JSON.stringify(output, null, 2));
