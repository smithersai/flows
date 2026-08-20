/*
 * Repro — checklist row 2.4 ("`/auth.sign-out` clears the session; a reload
 * stays signed out; no stale name, balance, or repo list survives") against
 * https://canary.smithers.sh.
 *
 * The first two clauses hold: the cookie goes and /api/auth/session answers
 * `{"status":"signed-out"}` after a full reload. The third does not. The
 * persisted transcript is never scrubbed on sign-out, so a signed-out reload
 * still renders, from the previous account:
 *
 *   - the balance pill "$500",
 *   - the repo digest ("6 open issues and 1 open pull request across 3 repos"),
 *   - the repository names (codeplanesmithers/canary-sandbox, …),
 *   - the pending recommendation card for that account's pull request.
 *
 * Anyone who signs out on a shared machine leaves all of it on screen.
 *
 *   bun 2.4.ts        exit 1 while the bug is present, 0 once it is fixed.
 */
import { chromium } from "playwright";
import { BASE, ensureSignedIn, PROFILE, report, resetOrigin, session } from "./_lib";

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1280, height: 1000 } });
const page = context.pages()[0] ?? (await context.newPage());
await resetOrigin(context, page, { signOut: true });
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const identity = await ensureSignedIn(page);
console.log("signed in as:", JSON.stringify(identity));
if (!JSON.stringify(identity).includes('"login"')) {
	console.error("precondition failed: could not sign in");
	process.exit(2);
}
const login = (identity as { login: string }).login;
await page.waitForTimeout(6000);

const composer = page.locator("textarea, [contenteditable=true]").first();
await composer.click();
await composer.type("/auth.sign-out");
await page.keyboard.press("Enter");
await page.waitForTimeout(6000);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(7000);

const after = await session(page);
console.log("session after sign-out + reload:", JSON.stringify(after));
const text = await page.locator("body").innerText();
console.log("=== the signed-out reload still renders ===\n" + text.slice(0, 700));
await page.screenshot({ path: "/tmp/canary-access-2.4-reload.png", fullPage: true });

const failures: Array<string> = [];
if (JSON.stringify(after) !== '{"status":"signed-out"}') failures.push("the session survived /auth.sign-out");
/* Each entry: the thing row 2.4 says must not survive, and how it shows up. */
const survivors: Array<{ readonly what: string; readonly needle: RegExp }> = [
	{ what: "the account name", needle: new RegExp(login) },
	{ what: "the balance", needle: /\$\d+/ },
	{ what: "the repo list / digest", needle: /open (issues?|pull requests?)/ },
];
for (const survivor of survivors) {
	if (survivor.needle.test(text)) failures.push(`${survivor.what} survived the sign-out and a full reload (${survivor.needle})`);
}

await context.close();
report(failures);
