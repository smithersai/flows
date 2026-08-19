/*
 * Repro — checklist row 2.2 ("The scopes GitHub asks for match what the app
 * claims it needs (`/api/auth/scopes`)") against https://canary.smithers.sh.
 *
 * They do not match.
 *
 * GET /api/auth/scopes claims one scope, `read:user`, described as "See your
 * GitHub profile — your username, name, and avatar" with the why line "This is
 * the identity half of sign-in and nothing more."
 *
 * The sign-in is a GitHub APP, not an OAuth App (client_id `Iv23li…`), so the
 * `scope=read:user` parameter on /login/oauth/authorize is inert — GitHub takes
 * the permissions from the App registration. The real consent screen for
 * `SmithersPreviewRelease` asks for:
 *
 *     Verify your GitHub identity
 *     Know which resources you can access
 *     Act on your behalf                  <- not claimed
 *     Email addresses (read)              <- not claimed
 *
 * Two of the four are outside the declared scope document, and "Act on your
 * behalf" is the opposite of "the identity half of sign-in and nothing more".
 *
 * The consent screen only renders when the account has not already authorized
 * the app, so this repro reads the SAME permission set from the account's
 * authorization page (github.com/settings/connections/applications/<client_id>),
 * which needs no revocation. Set GH_PW when GitHub asks for sudo mode.
 *
 *   GH_PW=… bun 2.2.ts   exit 1 while the bug is present, 0 once it is fixed.
 */
import { chromium } from "playwright";
import { BASE, PROFILE, report } from "./_lib";

const CLIENT_ID = process.env.CANARY_CLIENT_ID ?? "Iv23liwHER62HVHMWcGS";

const scopes = (await (await fetch(`${BASE}/api/auth/scopes`)).json()) as {
	requestedScopes: Array<string>;
	scopes: Array<{ scope: string; plain: string; why: string }>;
};
console.log("the app claims:", JSON.stringify(scopes));
const claimed = `${scopes.scopes.map((entry) => `${entry.plain} ${entry.why}`).join(" ")}`.toLowerCase();

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1280, height: 1200 } });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(`https://github.com/settings/connections/applications/${CLIENT_ID}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
if ((await page.locator("input[type=password]").count()) > 0) {
	if (process.env.GH_PW === undefined) {
		console.error("GitHub asked for sudo mode — rerun with GH_PW set (see the multi-test-github-account skill).");
		process.exit(2);
	}
	await page.locator("input[type=password]").first().fill(process.env.GH_PW);
	await page.locator('button:has-text("Confirm"), input[value="Confirm"]').first().click();
	await page.waitForTimeout(4000);
}
const text = await page.locator("body").innerText();
const start = text.indexOf("can access your account");
console.log("GitHub grants:\n" + text.slice(start, start + 260));
await page.screenshot({ path: "/tmp/canary-access-2.2-granted.png", fullPage: true });
await context.close();

const failures: Array<string> = [];
/* Each entry: what GitHub asks for, and the word the scope document would have to carry to claim it. */
const asked: Array<{ readonly granted: string; readonly claimWord: string }> = [
	{ granted: "Act on your behalf", claimWord: "act on your behalf" },
	{ granted: "View your email addresses", claimWord: "email" },
];
for (const entry of asked) {
	if (!text.includes(entry.granted)) continue;
	if (!claimed.includes(entry.claimWord)) {
		failures.push(`GitHub grants "${entry.granted}" but /api/auth/scopes never claims it`);
	}
}
if (scopes.requestedScopes.length === 1 && scopes.requestedScopes[0] === "read:user" && text.includes("Act on your behalf")) {
	failures.push(
		"the app declares the single scope `read:user` ('the identity half of sign-in and nothing more') while GitHub has granted the app the right to act on the user's behalf",
	);
}
report(failures);
