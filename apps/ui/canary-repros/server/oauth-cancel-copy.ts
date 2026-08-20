/*
 * Repro — cancelling GitHub's consent screen is reported as a failure of the
 * sign-in service.
 *
 * GitHub sends a refused authorization back as `?error=access_denied` with no
 * `code`. The product Worker forwarded that to the identity worker, which read
 * it as a malformed callback and answered HTTP 400, so the page told the user
 * "the sign-in service answered HTTP 400" — blaming a service for a button the
 * user pressed. The residual copy defect recorded in ../access/2.3.md.
 *
 * The callback is driven directly, so no consent screen has to be revoked and
 * no authorization is touched.
 *
 *   bun oauth-cancel-copy.ts    exit 1 while the bug is present, 0 once it is fixed.
 */
import { chromium } from "playwright";
import { BASE, PROFILE, report } from "./_lib";

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1280, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
const failures: Array<string> = [];

const denied = `${BASE}/api/auth/github/callback?error=access_denied&error_description=The+user+has+denied+your+application+access.&state=repro-server-lane`;
const response = await page.goto(denied, { waitUntil: "domcontentloaded" });
const status = response?.status() ?? 0;
const text = await page.locator("body").innerText();
console.log(`GET /api/auth/github/callback?error=access_denied -> ${status}`);
console.log(`the page says: ${JSON.stringify(text)}`);

if (new URL(page.url()).origin !== new URL(BASE).origin) {
	failures.push(`the cancelled callback left the product origin: ${page.url()}`);
}
if (/sign-in service answered/i.test(text)) {
	failures.push(`the page blames the sign-in service for a cancellation: ${JSON.stringify(text)}`);
}
if (/HTTP \d\d\d/.test(text)) {
	failures.push(`the page shows the reader an HTTP status for their own decision: ${JSON.stringify(text)}`);
}
if (!/cancel/i.test(text)) {
	failures.push(`the page never says the sign-in was cancelled: ${JSON.stringify(text)}`);
}
if (!/Nothing was signed in/i.test(text)) {
	failures.push("the page does not state that nothing was signed in");
}
if ((await page.locator('a[href="/"]').count()) === 0) {
	failures.push("the cancelled sign-in offers no way back into the app");
}
if (status !== 200) {
	failures.push(`a user's own cancellation answered HTTP ${status}; nothing failed, so it is a 200`);
}

await context.close();
report(failures);
