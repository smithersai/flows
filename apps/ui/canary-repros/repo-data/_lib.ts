/*
 * Shared helpers for the "repo-data" lane repros (checklist §15–§16) against
 * https://canary.smithers.sh.
 *
 * The sanctioned persistent profile holds the signed-in github.com session for
 * the throwaway account `codeplanesmithers`. Never open it directly and never
 * share it between two runs — copy it first:
 *
 *   cp -R ~/.multi-e2e-profile /tmp/canary-repo-data-profile
 */
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";

export const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
export const PROFILE = process.env.PROF ?? "/tmp/canary-repo-data-profile";

export interface Driver {
	readonly context: BrowserContext;
	readonly page: Page;
}

export const open = async (): Promise<Driver> => {
	const context = await chromium.launchPersistentContext(PROFILE, {
		headless: true,
		viewport: { width: 1280, height: 1000 },
	});
	const page = context.pages()[0] ?? (await context.newPage());
	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(3500);
	return { context, page };
};

/** The identity seam's answer, read through the product origin. */
export const session = (page: Page): Promise<unknown> =>
	page.evaluate(async () => (await fetch("/api/auth/session")).json().catch(() => null));

/** Type a slash flow into the composer and submit it. */
export const runFlow = async (page: Page, line: string): Promise<void> => {
	await page
		.waitForFunction(() => document.querySelector('[data-flow="chat.stop"]') === null, undefined, { timeout: 90_000 })
		.catch(() => {});
	const composer = page.locator("textarea").first();
	await composer.click();
	await composer.fill(line);
	await composer.press("Enter");
};

/** The whole rendered transcript, whitespace-collapsed. */
export const transcript = async (page: Page): Promise<string> => {
	const text = (await page.locator(".smithers-transcript").innerText().catch(() => "")) || (await page.locator("body").innerText());
	return text.replace(/\s+/g, " ");
};

/** Wait until the transcript grows past `before` and settles. */
export const settle = async (page: Page, before: string, timeoutMs = 60_000): Promise<string> => {
	const deadline = Date.now() + timeoutMs;
	let last = before;
	let stable = 0;
	while (Date.now() < deadline) {
		await page.waitForTimeout(1200);
		const now = await transcript(page);
		if (now === last && now !== before) {
			stable += 1;
			if (stable >= 2) return now;
		} else stable = 0;
		last = now;
	}
	return last;
};

/** Every card in the transcript as `kind::text`, in document order. */
export const cards = (page: Page): Promise<Array<string>> =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll("[data-kind]")).map(
			(element) =>
				`${element.getAttribute("data-kind")}::${(element.textContent ?? "").replace(/\s+/g, " ").trim()}`,
		),
	);

/**
 * Run one row and answer with what it ADDED: the cards that were not in the
 * transcript before, and the prose the turn appended. The transcript persists
 * across rows (the profile keeps it), so a row is graded on its delta, never
 * on the whole transcript — an earlier row's card must not read as this one's.
 *
 * The slash menu swallows Enter while it is open, so a bare `/flow` with no
 * argument runs the highlighted entry. Rows here always pass an argument,
 * which closes the menu and makes Enter a real submit.
 */
export const row = async (
	page: Page,
	line: string,
	options: { readonly shot?: string; readonly waitMs?: number } = {},
): Promise<{ readonly text: string; readonly newCards: Array<string>; readonly kinds: Array<string> }> => {
	const before = await cards(page);
	const beforeText = await transcript(page);
	await runFlow(page, line);
	const deadline = Date.now() + (options.waitMs ?? 60_000);
	while (Date.now() < deadline) {
		await page.waitForTimeout(1200);
		const now = await cards(page);
		if (now.length > before.length) break;
		const text = await transcript(page);
		if (text.length > beforeText.length + line.length + 60) break;
	}
	await page.waitForTimeout(3000);
	const after = await cards(page);
	const text = await transcript(page);
	if (options.shot !== undefined) await page.screenshot({ path: options.shot, fullPage: true });
	const newCards = after.filter((card) => !before.includes(card));
	return {
		text: text.slice(beforeText.length),
		newCards,
		kinds: newCards.map((card) => card.split("::")[0] ?? ""),
	};
};
