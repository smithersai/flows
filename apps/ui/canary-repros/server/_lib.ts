/*
 * Shared helpers for the "server" lane repros — the ones whose root cause is in
 * the product Worker (`smithers-mvp-web`, flows `apps/server`) or in one of the
 * upstream Cloudflare Workers (`~/flows/ui/workers/*`), against
 * https://canary.smithers.sh.
 *
 * The sanctioned persistent profile holds the signed-in github.com session for
 * the throwaway account `codeplanesmithers`. Never open it directly and never
 * share it between two runs — copy it first:
 *
 *   cp -R ~/.multi-e2e-profile /tmp/canary-server-profile
 */
import type { Page } from "playwright";

export const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
export const PROFILE = process.env.PROF ?? "/tmp/canary-server-profile";

/** The identity seam's answer, read through the product origin. */
export const session = (page: Page): Promise<unknown> =>
	page.evaluate(async () => (await fetch("/api/auth/session")).json().catch(() => null));

/**
 * Drive the real GitHub sign-in when the origin has no session. The profile's
 * github.com session and the existing app authorization make this a redirect
 * round trip; the Authorize button is clicked when GitHub asks for it.
 */
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

export interface SeamAnswer {
	readonly status: number;
	readonly body: string;
}

/** Call a same-origin route from inside the page, so the session cookie rides. */
export const seam = (
	page: Page,
	method: string,
	path: string,
	body?: unknown,
): Promise<SeamAnswer> =>
	page.evaluate(
		async ([method, path, body]: [string, string, unknown]) => {
			const init: RequestInit = { method };
			if (body !== undefined) {
				init.headers = { "content-type": "application/json" };
				init.body = JSON.stringify(body);
			}
			const response = await fetch(path, init);
			return { status: response.status, body: (await response.text()).slice(0, 600) };
		},
		[method, path, body] as [string, string, unknown],
	);

export const report = (failures: ReadonlyArray<string>): never => {
	if (failures.length === 0) {
		console.log("PASS — the bug is fixed.");
		process.exit(0);
	}
	for (const failure of failures) console.error(`FAIL: ${failure}`);
	process.exit(1);
};
