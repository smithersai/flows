/*
 * Shared helpers for the "github" lane repros (checklist §12–§14) against
 * https://canary.smithers.sh.
 *
 * The sanctioned persistent profile holds the signed-in github.com session for
 * the throwaway account `codeplanesmithers`. Never open it directly and never
 * share it between two runs — copy it first:
 *
 *   cp -R ~/.multi-e2e-profile /tmp/canary-github-profile
 */
import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

export const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
export const PROFILE = process.env.PROF ?? "/tmp/canary-github-profile";

export const open = async (): Promise<{ context: BrowserContext; page: Page }> => {
	const context = await chromium.launchPersistentContext(PROFILE, {
		headless: true,
		viewport: { width: 1280, height: 1000 },
	});
	const page = context.pages()[0] ?? (await context.newPage());
	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	/* First paint on the canary can take well over 10s once the transcript is
	 * large; wait for the composer itself rather than a fixed sleep. */
	await page.locator("textarea").last().waitFor({ state: "visible", timeout: 120_000 }).catch(() => {});
	await page.waitForTimeout(2500);
	return { context, page };
};

/** The identity seam's answer, read through the product origin. */
export const session = (page: Page): Promise<unknown> =>
	page.evaluate(async () => (await fetch("/api/auth/session")).json().catch(() => null));

/** Drive the real GitHub sign-in when the origin has no session. */
export const ensureSignedIn = async (page: Page): Promise<unknown> => {
	const current = await session(page);
	if (JSON.stringify(current).includes('"login"')) return current;
	await page.locator('[data-flow="auth.sign-in"]').last().click();
	await page.waitForTimeout(5000);
	const authorize = page.locator('button:has-text("Authorize")').first();
	if (await authorize.isVisible().catch(() => false)) await authorize.click();
	await page.waitForURL(/canary\.smithers\.sh/, { timeout: 60_000 }).catch(() => {});
	await page.waitForTimeout(8000);
	return await session(page);
};

/** Type a slash flow into the composer and submit it. */
export const runFlow = async (page: Page, line: string, settleMs = 9000): Promise<string> => {
	const composer = page.locator("textarea, [contenteditable=true]").last();
	await composer.click();
	await composer.fill?.(line).catch(async () => {
		await page.keyboard.type(line);
	});
	await page.waitForTimeout(400);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(settleMs);
	return await page.locator("body").innerText();
};

/** The app shell's whole registry (`data-flows`), split into names. */
export const registry = async (page: Page): Promise<Array<string>> => {
	const attribute = await page.evaluate(() => document.querySelector("[data-flows]")?.getAttribute("data-flows") ?? "");
	return attribute.split(" ").filter((name) => name !== "");
};

export const report = (failures: ReadonlyArray<string>): never => {
	if (failures.length === 0) {
		console.log("PASS — the bug is fixed.");
		process.exit(0);
	}
	for (const failure of failures) console.error(`FAIL: ${failure}`);
	process.exit(1);
};
