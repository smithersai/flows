/*
 * Shared helpers for the "admin" lane repros (checklist §25–§28) against
 * https://canary.smithers.sh.
 *
 * The sanctioned persistent profile holds the signed-in github.com session for
 * the throwaway account `codeplanesmithers`. Never open it directly and never
 * share it between two runs — copy it first:
 *
 *   cp -R ~/.multi-e2e-profile /tmp/canary-admin-profile
 *
 * The admin rows need `admin: true`, which the identity worker answers from its
 * ADMIN_LOGINS var. During this run `codeplanesmithers` was added to that var
 * (Cloudflare Worker settings PATCH, no code deploy). If the session reports
 * admin:false, that fixture is gone — restore it before reading a failure here
 * as a product defect.
 */
import { chromium, type BrowserContext, type Page } from "playwright";

export const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
export const PROFILE = process.env.PROF ?? "/tmp/canary-admin-profile";

export const open = async (): Promise<{ context: BrowserContext; page: Page; errors: Array<string>; requests: Array<string> }> => {
	const context = await chromium.launchPersistentContext(PROFILE, {
		headless: true,
		viewport: { width: 1400, height: 1000 },
	});
	const page = context.pages()[0] ?? (await context.newPage());
	const errors: Array<string> = [];
	const requests: Array<string> = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("pageerror", (error) => errors.push(String(error)));
	page.on("response", (response) => {
		if (response.status() >= 400) requests.push(`${response.status()} ${response.request().method()} ${response.url()}`);
	});
	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(6000);
	return { context, page, errors, requests };
};

/** The identity seam's answer, read through the product origin. */
export const session = (page: Page): Promise<{ login?: string; admin?: boolean; allowlisted?: boolean }> =>
	page.evaluate(async () => (await fetch("/api/auth/session")).json().catch(() => ({})));

/** The app shell's whole registry (`data-flows`), split into names. */
export const registry = async (page: Page): Promise<Array<string>> => {
	const attribute = await page.evaluate(() => document.querySelector("[data-flows]")?.getAttribute("data-flows") ?? "");
	return attribute.split(" ").filter((name) => name !== "");
};

/** Type a slash flow into the composer and submit it. */
export const run = async (page: Page, text: string, settle = 4000): Promise<void> => {
	const composer = page.locator("textarea.sui-chat-composer-input");
	await composer.click();
	await composer.fill(text);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(settle);
};

export const body = (page: Page): Promise<string> => page.locator("body").innerText();

export const report = (failures: ReadonlyArray<string>): never => {
	if (failures.length === 0) {
		console.log("PASS — the bug is fixed.");
		process.exit(0);
	}
	for (const failure of failures) console.error(`FAIL: ${failure}`);
	process.exit(1);
};
