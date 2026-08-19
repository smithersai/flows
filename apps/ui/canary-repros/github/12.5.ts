/*
 * Repro — checklist §12.5: "/repos.app reports the GitHub App's real
 * installation state and links to the fix when it is not installed."
 *
 * Expected: when the App is not installed the message carries a github.com
 * install link (AppStatusSeam only links a trusted https://github.com URL).
 * Actual: the platform answers github_app_configured:false and install_url:"",
 * so the app can only say "…and the platform's install link wasn't usable".
 * The installation state IS reported honestly; the link to the fix is missing.
 *
 * Root cause (verified out of band): the GKE deployment smithers-api in
 * namespace `smithers` on gke_plue-prod-1771780303_us-central1_plue-cluster
 * sets no SMITHERS_GITHUB_APP_ID / SMITHERS_GITHUB_APP_PRIVATE_KEY, even
 * though Secret Manager on plue-prod-1771780303 already holds
 * `plue-github-app-id` and `plue-github-app-private-key`.
 * plue's githubAppInstallURL() returns "" whenever those credentials are
 * absent (internal/services/repo_connection_github_app.go).
 *
 * Exits non-zero while the bug is present.
 *
 *   bun apps/ui/canary-repros/github/12.5.ts
 */
import { BASE, ensureSignedIn, open, report } from "./_lib";

const REPO = process.env.REPO ?? "codeplanesmithers/canary-sandbox";
const { context, page } = await open();
await ensureSignedIn(page);

const status = await page.evaluate(async (repo) => {
	const response = await fetch(`/api/repos/${repo}/github-app-status`);
	return { status: response.status, body: await response.text() };
}, REPO);
console.log(`GET /api/repos/${REPO}/github-app-status -> ${status.status} ${status.body.trim()}`);

const composer = page.locator("textarea").last();
await composer.click();
await composer.fill(`/repos.app ${REPO}`);
await page.waitForTimeout(400);
await page.keyboard.press("Enter");
await page.waitForTimeout(12_000);
/* The transcript virtualizes, so read the whole of it and pull out the one
 * line /repos.app writes rather than diffing a prefix. */
const whole = await page.locator(".smithers-transcript").innerText();
const said =
	whole
		.split("\n")
		.filter((line) => line.includes("Smithers GitHub App"))
		.pop() ?? "";
console.log(`transcript line: ${said}`);

const failures: Array<string> = [];
if (!/not installed/.test(said)) failures.push("the app did not state the installation status at all");
if (!/https:\/\/github\.com\//.test(said)) {
	failures.push(`/repos.app offered no github.com install link — it said: ${said.trim().replace(/\n+/g, " ").slice(0, 200)}`);
}

await page.screenshot({ path: "/tmp/canary-github-12.5.png", fullPage: true });
console.log(`origin: ${BASE}; screenshot: /tmp/canary-github-12.5.png`);
await context.close();
report(failures);
