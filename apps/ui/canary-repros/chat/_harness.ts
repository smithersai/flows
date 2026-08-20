/*
 * Shared launch for the chat-lane canary repros.
 *
 * Every repro in this directory drives https://canary.smithers.sh with the
 * sanctioned throwaway GitHub session (`codeplanesmithers`). Copy the
 * persistent profile FIRST — Chrome locks a user-data-dir, so two repros must
 * never share one:
 *
 *   cp -R ~/.multi-e2e-profile /tmp/canary-chat-profile
 *   bun apps/ui/canary-repros/chat/<rowId>.ts
 *
 * Override the copy with CHAT_PROFILE=<dir>.
 */
import { chromium, type BrowserContext, type Page } from "playwright";

export const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
export const PROFILE = process.env.CHAT_PROFILE ?? "/tmp/canary-chat-profile";

export interface Harness {
	readonly ctx: BrowserContext;
	readonly page: Page;
}

/** Launch the profile copy and make sure the session is signed in. */
export const launch = async (): Promise<Harness> => {
	const ctx = await chromium.launchPersistentContext(PROFILE, {
		headless: process.env.HEADED !== "1",
		viewport: { width: 1400, height: 1000 },
	});
	const page = ctx.pages()[0] ?? (await ctx.newPage());
	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(3500);
	const session = await page.evaluate(async () => (await fetch("/api/auth/session")).text());
	if (!session.includes("login")) {
		await page.locator('[data-flow="auth.sign-in"]').first().click();
		await page.waitForTimeout(7000);
		const authorize = page.locator('button:has-text("Authorize")').first();
		if (await authorize.isVisible().catch(() => false)) {
			await authorize.click();
			await page.waitForTimeout(7000);
		}
		await page.waitForTimeout(3000);
	}
	return { ctx, page };
};

/** The one composer textarea. */
export const composer = (page: Page) => page.locator("textarea").first();

/** Clear this origin's persisted transcript at the browser level (cookies stay). */
export const resetStore = async ({ ctx, page }: Harness): Promise<void> => {
	await page.goto("about:blank", { waitUntil: "domcontentloaded" });
	const client = await ctx.newCDPSession(page);
	await client.send("Storage.clearDataForOrigin", {
		origin: BASE,
		storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers",
	});
	await client.detach().catch(() => {});
	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(4000);
};

/** Submit `text` as one message (fill, so embedded newlines do not submit). */
export const send = async (page: Page, text: string): Promise<void> => {
	const box = composer(page);
	await box.click();
	await box.fill(text);
	await page.waitForTimeout(250);
	await page.keyboard.press("Enter");
};

/** Wait until the rendered text stops growing. */
export const settle = async (page: Page, budgetMs = 40_000): Promise<void> => {
	let last = -1;
	let stable = 0;
	const started = Date.now();
	while (Date.now() - started < budgetMs) {
		await page.waitForTimeout(500);
		const length = await page.evaluate(() => document.body.innerText.length);
		if (length === last) {
			stable += 1;
			if (stable >= 6) return;
		} else {
			stable = 0;
			last = length;
		}
	}
};

/** Open the slash menu on `query` with the pointer parked away from the list. */
export const openSlashMenu = async (page: Page, query: string): Promise<void> => {
	const box = composer(page);
	await box.click();
	await box.fill("");
	await page.mouse.move(1350, 20);
	await page.waitForTimeout(250);
	await page.keyboard.type(query, { delay: 35 });
	await page.waitForTimeout(700);
};
