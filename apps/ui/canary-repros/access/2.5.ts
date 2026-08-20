/*
 * Repro — checklist row 2.5 ("Sign in again in a second tab. Both tabs agree
 * on identity without a manual reload") against https://canary.smithers.sh.
 *
 * They do not agree. With two tabs open on the app and both signed out,
 * signing in from tab 2 leaves tab 1 sitting on the signed-out card
 * ("Smithers is a design-partner preview — sign in with GitHub to continue")
 * indefinitely: the app reads /api/auth/session once per load and nothing
 * re-reads it, so identity only converges when the stale tab is reloaded by
 * hand. The cookie is shared, so tab 1 is signed in and does not know.
 *
 *   bun 2.5.ts        exit 1 while the bug is present, 0 once it is fixed.
 */
import { chromium } from "playwright";
import { BASE, ensureSignedIn, PROFILE, report, resetOrigin, session } from "./_lib";

const SIGNED_OUT_COPY = "sign in with GitHub to continue";

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1280, height: 900 } });
const tab1 = context.pages()[0] ?? (await context.newPage());
await resetOrigin(context, tab1, { signOut: true });
await tab1.goto(BASE, { waitUntil: "domcontentloaded" });
await tab1.waitForTimeout(6000);
console.log("tab1 session:", JSON.stringify(await session(tab1)));
const tab1Before = await tab1.locator("body").innerText();
if (!tab1Before.includes(SIGNED_OUT_COPY)) {
	console.error("precondition failed: tab 1 is not showing the signed-out state");
	process.exit(2);
}

const tab2 = await context.newPage();
await tab2.goto(BASE, { waitUntil: "domcontentloaded" });
await tab2.waitForTimeout(5000);
console.log("tab2 signs in:", JSON.stringify(await ensureSignedIn(tab2)));

/* Give tab 1 a generous window to notice, WITHOUT reloading it. */
await tab1.waitForTimeout(20_000);
const tab1Session = await session(tab1);
const tab1After = await tab1.locator("body").innerText();
console.log("tab1 session (cookie is shared):", JSON.stringify(tab1Session));
console.log("tab1 still renders:\n" + tab1After.slice(0, 300));
await tab1.screenshot({ path: "/tmp/canary-access-2.5-tab1.png", fullPage: true });

const failures: Array<string> = [];
if (JSON.stringify(tab1Session).includes('"login"') && tab1After.includes(SIGNED_OUT_COPY)) {
	failures.push(
		"tab 1 is signed in at the seam but still renders the signed-out card 20s after tab 2 signed in — the tabs only agree after a manual reload",
	);
}

await context.close();
report(failures);
