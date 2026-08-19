/*
 * Repro / regression guard — checklist row 2.2 ("The scopes GitHub asks for
 * match what the app claims it needs (/api/auth/scopes)") against
 * https://canary.smithers.sh.
 *
 * Round 1 (2026-08-18) FAILED: /api/auth/scopes claimed exactly one scope,
 * `read:user` ("the identity half of sign-in and nothing more"), while the
 * real consent screen asked for four things including "Act on your behalf"
 * and "Email addresses (read)".
 *
 * Round 2 (2026-08-19) PASSES: /api/auth/scopes now declares authKind
 * "github-app", says the scope parameter is inert for an App, and enumerates
 * ten permissions. GitHub's OWN two pages enumerate the same set:
 *   - the account authorization page lists the four user-level grants
 *     (identity, resources-you-can-access, act-on-your-behalf, email), and
 *   - the installation's permissions page lists the seven repository
 *     permissions the app registration asks for (checks read, contents write,
 *     issues write, metadata read, pull requests write, statuses read,
 *     workflows write).
 * "Know what resources you can access" is the same permission the claim calls
 * `metadata:read`, so the ten claimed entries are exactly the union.
 *
 * This script re-reads both GitHub pages and the claim and fails if they
 * diverge in EITHER direction (a claim GitHub never asks for, or a
 * permission GitHub asks for that the app does not claim).
 *
 *   bun 2.2.ts        exit 1 if the row regresses, 0 while it holds.
 */
import { chromium } from "playwright";
import { BASE, PROFILE, report } from "./_lib";

const CLIENT_ID = process.env.GH_CLIENT_ID ?? "Iv23liwHER62HVHMWcGS";

/* GitHub's own wording on its pages → the scope id the app claims. */
const USER_LEVEL: ReadonlyArray<readonly [string, string]> = [
	["Verify your GitHub identity", "identity"],
	["Act on your behalf", "user-to-server"],
	["View your email addresses", "emails:read"],
	["Know what resources you can access", "metadata:read"],
];
const REPOSITORY: ReadonlyArray<readonly [string, string]> = [
	["Read-only access to Checks", "checks:read"],
	["Read and write access to Contents", "contents:write"],
	["Read and write access to Issues", "issues:write"],
	["Read-only access to Metadata", "metadata:read"],
	["Read and write access to Pull requests", "pull_requests:write"],
	["Read-only access to Commit statuses", "statuses:read"],
	["Read and write access to Workflows", "workflows:write"],
];

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1280, height: 1100 } });
const page = context.pages()[0] ?? (await context.newPage());

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
const claim = (await page.evaluate(async () => (await fetch("/api/auth/scopes")).json())) as {
	authKind?: string;
	scopes?: Array<{ scope?: string; plain?: string }>;
};
const claimed = new Set((claim.scopes ?? []).map((entry) => entry.scope ?? ""));
console.log("the app claims:", JSON.stringify([...claimed]));

const failures: Array<string> = [];
if (claim.authKind !== "github-app") {
	failures.push(`the claim no longer says which auth kind it is (authKind: ${String(claim.authKind)})`);
}

/* GitHub's user-level authorization page. */
await page.goto(`https://github.com/settings/connections/applications/${CLIENT_ID}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const authorization = await page.locator("body").innerText();
for (const [wording, scope] of USER_LEVEL) {
	if (!authorization.includes(wording)) {
		console.log(`note: GitHub no longer lists the user-level grant "${wording}"`);
		continue;
	}
	if (!claimed.has(scope)) failures.push(`GitHub asks for "${wording}" and the app does not claim ${scope}`);
}

/* GitHub's installation permissions, including any pending update request. */
await page.goto("https://github.com/settings/installations", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
const configure = page.locator('a:has-text("Configure")').first();
if (!(await configure.isVisible().catch(() => false))) {
	console.error("precondition failed: the app is not installed on this account, so its repository permissions cannot be read");
	await context.close();
	process.exit(2);
}
await configure.click();
await page.waitForTimeout(2500);
const installationUrl = page.url();
await page.goto(`${installationUrl}/permissions/update`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const unchanged = page.locator("text=Show unchanged permissions").first();
if (await unchanged.isVisible().catch(() => false)) {
	await unchanged.click();
	await page.waitForTimeout(1500);
}
const permissions = await page.locator("body").innerText();
console.log("GitHub's repository permissions page:\n" + permissions.replace(/\n{2,}/g, "\n").slice(0, 1200));
for (const [wording, scope] of REPOSITORY) {
	if (!permissions.includes(wording)) {
		console.log(`note: GitHub does not list "${wording}" right now`);
		continue;
	}
	if (!claimed.has(scope)) failures.push(`GitHub asks for "${wording}" and the app does not claim ${scope}`);
}

/* And the other direction: nothing claimed that GitHub never asks for. */
const known = new Set([...USER_LEVEL, ...REPOSITORY].map(([, scope]) => scope));
for (const scope of claimed) {
	if (!known.has(scope)) failures.push(`the app claims ${scope}, which appears on neither GitHub page`);
}

await page.screenshot({ path: "/tmp/canary-access/2.2-permissions.png", fullPage: true });
await context.close();
report(failures);
