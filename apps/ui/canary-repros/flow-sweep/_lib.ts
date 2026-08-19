/*
 * Shared helpers for the "flow-sweep" lane repros (checklist Appendix A)
 * against https://canary.smithers.sh.
 *
 * The sanctioned persistent profile holds the signed-in github.com session for
 * the throwaway account `codeplanesmithers`. Never open it directly and never
 * share it between two runs — copy it first:
 *
 *   cp -R ~/.multi-e2e-profile /tmp/canary-flow-sweep-profile
 *
 * Run any repro with bun (never tsx — its CJS transform rejects top-level
 * await):
 *
 *   bun apps/ui/canary-repros/flow-sweep/A.47.ts
 */
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";

export const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
export const PROFILE = process.env.PROF ?? "/tmp/canary-flow-sweep-profile";

export interface Session {
	readonly ctx: BrowserContext;
	readonly page: Page;
	/** Type `input` into the composer, submit it, and report what changed. */
	readonly invoke: (input: string, waitMs?: number) => Promise<Outcome>;
	readonly close: () => Promise<void>;
}

export interface Outcome {
	/** Rendered lines present after the invocation and absent before it. */
	readonly added: ReadonlyArray<string>;
	/** Rendered lines present before and gone after. */
	readonly removed: ReadonlyArray<string>;
	/** `<status> <method> <path>` for every /api/ response during the wait. */
	readonly net: ReadonlyArray<string>;
}

const lines = async (page: Page): Promise<string[]> =>
	(await page.locator("body").innerText()).split("\n").filter((line) => line.trim() !== "");

const diff = (before: ReadonlyArray<string>, after: ReadonlyArray<string>): string[] => {
	const counts = new Map<string, number>();
	for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
	return after.filter((line) => {
		const seen = counts.get(line) ?? 0;
		if (seen > 0) {
			counts.set(line, seen - 1);
			return false;
		}
		return true;
	});
};

/** Open the app on the product origin with the signed-in profile copy. */
export const openApp = async (): Promise<Session> => {
	const ctx = await chromium.launchPersistentContext(PROFILE, {
		headless: true,
		viewport: { width: 1440, height: 1000 },
	});
	const page = ctx.pages()[0] ?? (await ctx.newPage());
	const net: string[] = [];
	page.on("response", (response) => {
		const url = response.url();
		if (url.includes("/api/")) {
			net.push(`${response.status()} ${response.request().method()} ${url.replace(BASE, "")}`);
		}
	});
	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(8000);
	const session = await page.evaluate(async () => (await fetch("/api/auth/session")).text());
	if (!session.includes("login")) {
		throw new Error(`the profile is signed out (${session}) — re-copy ~/.multi-e2e-profile`);
	}
	const invoke = async (input: string, waitMs = 8000): Promise<Outcome> => {
		const before = await lines(page);
		const mark = net.length;
		const composer = page.locator("textarea").first();
		await composer.click();
		await composer.fill(input);
		await page.waitForTimeout(300);
		await page.keyboard.press("Enter");
		await page.waitForTimeout(waitMs);
		const after = await lines(page);
		return { added: diff(before, after), removed: diff(after, before), net: net.slice(mark) };
	};
	return { ctx, page, invoke, close: () => ctx.close() };
};

/** Exit 0 when every failure is gone, non-zero while any is present. */
export const report = (failures: ReadonlyArray<string>): never => {
	if (failures.length === 0) {
		console.log("PASS — the bug is fixed.");
		process.exit(0);
	}
	for (const failure of failures) console.error(`FAIL: ${failure}`);
	process.exit(1);
};
