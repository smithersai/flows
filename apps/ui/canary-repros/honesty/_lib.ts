/*
 * Shared helpers for the "honesty" lane repros (checklist §22–§24) against
 * https://canary.smithers.sh.
 *
 * Copy the sanctioned profile first — never open it directly, never share it:
 *
 *   cp -R ~/.multi-e2e-profile /tmp/canary-honesty-profile
 */
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";

export const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
export const PROFILE = process.env.PROF ?? "/tmp/canary-honesty-profile";

export const open = async (options?: { readonly headless?: boolean }): Promise<{
	readonly context: BrowserContext;
	readonly page: Page;
	readonly consoleErrors: Array<string>;
}> => {
	const context = await chromium.launchPersistentContext(PROFILE, {
		headless: options?.headless ?? true,
		viewport: { width: 1400, height: 1000 },
	});
	const page = context.pages()[0] ?? (await context.newPage());
	const consoleErrors: Array<string> = [];
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(String(error)));
	return { context, page, consoleErrors };
};

/** Clear this origin's persisted app state without touching the github.com cookie jar. */
export const clearOrigin = async (context: BrowserContext, page: Page): Promise<void> => {
	await page.goto("about:blank", { waitUntil: "domcontentloaded" });
	const cdp = await context.newCDPSession(page);
	await cdp.send("Storage.clearDataForOrigin", {
		origin: new URL(BASE).origin,
		storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers",
	});
	await cdp.detach().catch(() => {});
};

export const session = (page: Page): Promise<string> =>
	page.evaluate(async () => (await fetch("/api/auth/session")).text());

/** Type a prompt into the composer and submit it. */
export const ask = async (page: Page, prompt: string): Promise<void> => {
	const composer = page.locator("textarea.sui-chat-composer-input");
	await composer.click();
	await composer.fill(prompt);
	await composer.press("Enter");
};

/** Wait until the transcript stops growing (the turn has settled). */
export const settle = async (page: Page, budgetMs = 60_000): Promise<string> => {
	const started = Date.now();
	let previous = "";
	let stable = 0;
	while (Date.now() - started < budgetMs) {
		await page.waitForTimeout(2000);
		const text = await page.locator("body").innerText();
		if (text === previous) {
			stable += 1;
			if (stable >= 3) return text;
		} else {
			stable = 0;
			previous = text;
		}
	}
	return await page.locator("body").innerText();
};

export const report = (failures: ReadonlyArray<string>): never => {
	if (failures.length === 0) {
		console.log("PASS — the bug is fixed.");
		process.exit(0);
	}
	for (const failure of failures) console.error(`FAIL: ${failure}`);
	process.exit(1);
};
