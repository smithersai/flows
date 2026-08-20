/*
 * Shared helpers for the "money" lane repros (checklist §17–§19) against
 * https://canary.smithers.sh.
 *
 * The sanctioned persistent profile holds the signed-in github.com session for
 * the throwaway account `codeplanesmithers`. Never open it directly and never
 * share it between two runs — copy it first:
 *
 *   cp -R ~/.multi-e2e-profile /tmp/canary-money-profile
 */
import type { BrowserContext, Page } from "playwright";

export const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
export const PROFILE = process.env.PROF ?? "/tmp/canary-money-profile";

/**
 * Clear this origin's persisted app state, and optionally its cookie, WITHOUT
 * touching github.com. `Storage.clearDataForOrigin` with `cookies` in the type
 * list clears the whole cookie jar, not just the origin's — that wipes the
 * GitHub session the profile exists to carry, so the cookie is dropped by
 * filtering the jar instead.
 */
export const resetOrigin = async (
	context: BrowserContext,
	page: Page,
	options: { readonly signOut: boolean },
): Promise<void> => {
	await page.goto("about:blank", { waitUntil: "domcontentloaded" });
	const client = await context.newCDPSession(page);
	await client.send("Storage.clearDataForOrigin", {
		origin: new URL(BASE).origin,
		storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers",
	});
	await client.detach().catch(() => {});
	if (options.signOut) {
		const jar = await context.cookies();
		const keep = jar.filter((cookie) => !cookie.domain.includes("smithers.sh"));
		await context.clearCookies();
		await context.addCookies(keep);
	}
};

/** The identity seam's answer, read through the product origin. */
export const session = (page: Page): Promise<unknown> =>
	page.evaluate(async () => (await fetch("/api/auth/session")).json().catch(() => null));

/** Every `data-flow` name currently in the DOM, in document order. */
export const visibleFlows = (page: Page): Promise<Array<string>> =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll("[data-flow]")).map((element) => element.getAttribute("data-flow") ?? ""),
	);

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

/**
 * Drive the real GitHub sign-in when the origin has no session. The profile's
 * github.com session and the existing app authorization make this a redirect
 * round trip; the Authorize button is clicked when GitHub asks for it.
 */
export const ensureSignedIn = async (page: Page): Promise<unknown> => {
	const current = await session(page);
	if (JSON.stringify(current).includes('"login"')) return current;
	/* The in-message CTA can sit under the composer; the composer's own gold
	 * suggestion pill is the one that is always clickable. */
	await page.locator('[data-flow="auth.sign-in"]').last().click();
	await page.waitForTimeout(5000);
	const authorize = page.locator('button:has-text("Authorize")').first();
	if (await authorize.isVisible().catch(() => false)) await authorize.click();
	await page.waitForURL(/canary\.smithers\.sh/, { timeout: 60_000 }).catch(() => {});
	await page.waitForTimeout(8000);
	return await session(page);
};

/** Focus the composer, type `text`, press Enter. Returns the transcript before. */
export const sendPrompt = async (page: Page, text: string): Promise<string> => {
	const before = await page.locator("body").innerText();
	const composer = page.locator("textarea").first();
	await composer.click();
	await composer.fill("");
	await composer.type(text, { delay: 12 });
	/* The slash menu intercepts Enter as "accept the highlighted flow"; Escape
	 * closes it so Enter submits the literal line that was typed. */
	await page.keyboard.press("Escape");
	await page.waitForTimeout(150);
	await composer.press("Enter");
	return before;
};

/** The transcript text that arrived after `before`. */
export const replyRegion = (before: string, after: string): string =>
	after.startsWith(before) ? after.slice(before.length) : after;

/** Poll the page text until `predicate` holds or the budget runs out. */
export const waitForText = async (
	page: Page,
	predicate: (text: string) => boolean,
	budgetMs = 30_000,
): Promise<{ readonly ok: boolean; readonly text: string }> => {
	const deadline = Date.now() + budgetMs;
	let text = "";
	for (;;) {
		text = await page.locator("body").innerText();
		if (predicate(text)) return { ok: true, text };
		if (Date.now() > deadline) return { ok: false, text };
		await page.waitForTimeout(700);
	}
};

/** Run a flow and return the transcript region it produced. */
export const runFlow = async (page: Page, line: string, budgetMs = 30_000): Promise<string> => {
	const before = await sendPrompt(page, line);
	const settled = await waitForText(page, (text) => text.length > before.length + 8, budgetMs);
	await page.waitForTimeout(1200);
	const after = await page.locator("body").innerText();
	return replyRegion(before, after);
};

/** A JSON seam read through the product origin (carries the session cookie). */
export const seam = (
	page: Page,
	path: string,
	init?: RequestInit,
): Promise<{ status: number; body: unknown; text: string }> =>
	page.evaluate(
		async ([p, i]) => {
			const response = await fetch(p as string, (i ?? undefined) as RequestInit);
			const text = await response.text();
			let body: unknown = null;
			try {
				body = JSON.parse(text);
			} catch {
				body = null;
			}
			return { status: response.status, body, text };
		},
		[path, init ?? null] as const,
	);
