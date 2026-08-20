/*
 * Repro — checklist row 2.3 ("Cancel the OAuth consent screen halfway. The app
 * returns to a clean signed-out state with an honest message, not a stuck
 * spinner.") against https://canary.smithers.sh.
 *
 * Cancelling does not return to the app at all. GitHub sends the denial to the
 * GitHub App's REGISTERED callback URL rather than to the `redirect_uri` the
 * start route passed, and that registered URL is the Go backend:
 *
 *   https://api.jjhub.tech/api/auth/github/callback?error=access_denied&…
 *
 * which answers a raw JSON body, `{"message":"code and state are required"}`.
 * The user ends up on a different origin, looking at a JSON blob, with no way
 * back to Smithers. (canary's own /api/auth/github/callback DOES render an
 * honest "GitHub sign-in didn't finish" page — it is simply never reached.)
 *
 * Observing a real Cancel needs a consent screen, and GitHub only renders one
 * when the account has not yet authorized the app. This repro therefore
 * revokes the authorization, cancels, asserts, and RE-AUTHORIZES in a finally
 * block, leaving the account as it found it. Set GH_PW for GitHub sudo mode.
 *
 *   GH_PW=… bun 2.3.ts   exit 1 while the bug is present, 0 once it is fixed.
 */
import { chromium } from "playwright";
import { withVerifiedRestoration } from "../../scripts/canary-restoration";
import { BASE, ensureSignedIn, PROFILE, report, resetOrigin, session } from "./_lib";

const CLIENT_ID = process.env.CANARY_CLIENT_ID ?? "Iv23liwHER62HVHMWcGS";
if (process.env.GH_PW === undefined) {
	console.error("GH_PW is required — GitHub asks for sudo mode before it will revoke (see multi-test-github-account).");
	process.exit(2);
}

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1280, height: 1100 } });
const page = context.pages()[0] ?? (await context.newPage());
const sudo = async (): Promise<void> => {
	if ((await page.locator("input[type=password]").count()) === 0) return;
	await page.locator("input[type=password]").first().fill(process.env.GH_PW!);
	await page.locator('button:has-text("Confirm"), input[value="Confirm"]').first().click();
	await page.waitForTimeout(4000);
};

const failures: Array<string> = [];
await withVerifiedRestoration(
	async () => {
	await page.goto(`https://github.com/settings/connections/applications/${CLIENT_ID}`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(2500);
	await sudo();
	await page.locator('summary:has-text("Revoke access"), button:has-text("Revoke access")').first().click();
	await page.waitForTimeout(1500);
	await page.locator('button:has-text("I understand, revoke access"), button:has-text("Revoke access")').last().click();
	await page.waitForTimeout(4000);
	console.log("revoked; now driving sign-in to the real consent screen");

	await resetOrigin(context, page, { signOut: true });
	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(5000);
	await page.locator('[data-flow="auth.sign-in"]').last().click();
	await page.waitForTimeout(7000);
	console.log("consent url:", page.url());
	if (!page.url().startsWith("https://github.com/login/oauth/authorize")) {
		throw new Error("precondition failed: no consent screen — the revoke did not take");
	}

	await page.locator('button:has-text("Cancel"), a:has-text("Cancel")').first().click();
	await page.waitForTimeout(8000);
	const landed = page.url();
	const body = (await page.locator("body").innerText()).slice(0, 400);
	console.log("after Cancel, landed at:", landed);
	console.log("after Cancel, the page says:", JSON.stringify(body));
	await page.screenshot({ path: "/tmp/canary-access-2.3-cancel.png", fullPage: true });

	if (!landed.startsWith(BASE)) {
		failures.push(`Cancel left the product origin: it landed on ${new URL(landed).origin}`);
	}
	if (body.trim().startsWith("{")) {
		failures.push(`Cancel rendered a raw JSON body to the user: ${body.trim().slice(0, 120)}`);
	}
	const backToApp = await page.locator('a:has-text("Back to Smithers"), [data-flow="auth.sign-in"]').count();
	if (backToApp === 0) failures.push("the cancelled sign-in offers no way back into the app");
	},
	async () => {
		await page.goto(BASE, { waitUntil: "domcontentloaded" });
		await page.waitForTimeout(5000);
		console.log("restoring the authorization…");
		await ensureSignedIn(page);
	},
	async () => {
		const restoredSession = await session(page);
		console.log("final session:", JSON.stringify(restoredSession));
		if (restoredSession === null || JSON.stringify(restoredSession).includes('"signedIn":false')) {
			throw new Error(`the product session was not restored: ${JSON.stringify(restoredSession)}`);
		}
		await page.goto(`https://github.com/settings/connections/applications/${CLIENT_ID}`, { waitUntil: "domcontentloaded" });
		await page.waitForTimeout(2500);
		await sudo();
		if (!(await page.locator('summary:has-text("Revoke access"), button:has-text("Revoke access")').first().isVisible().catch(() => false))) {
			throw new Error("GitHub does not show Revoke access, so the App authorization was not restored");
		}
	},
	"reauthorize the Smithers GitHub App for codeplanesmithers and sign the product session back in",
);

await context.close();
report(failures);
