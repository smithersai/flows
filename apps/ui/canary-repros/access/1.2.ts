/*
 * Repro — checklist row 1.2 ("`/` while signed out lists `auth.sign-in` first
 * and nothing that cannot work signed out") against https://canary.smithers.sh.
 *
 * `auth.sign-in` does lead the listing. The rest of the listing is the whole
 * registry: signed out, bare `/` offers `/auth.sign-out`, `/billing.upgrade`,
 * `/billing.portal`, `/keys.list`, `/issues.create`, `/prs.create`,
 * `/notifications.list`, … — 50+ flows that cannot do anything without a
 * session.
 *
 *   bun 1.2.ts        exit 1 while the bug is present, 0 once it is fixed.
 */
import { chromium } from "playwright";
import { BASE, PROFILE, report, resetOrigin, session } from "./_lib";

/* Flows that plainly need a session; any of these in the signed-out listing is the bug. */
const SIGNED_IN_ONLY = [
	"/auth.sign-out",
	"/billing.upgrade",
	"/billing.portal",
	"/billing.balance",
	"/keys.list",
	"/keys.remove",
	"/issues.create",
	"/issues.close",
	"/prs.create",
	"/prs.land",
	"/notifications.list",
	"/env.set",
	"/repos.import",
];

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1280, height: 1000 } });
const page = context.pages()[0] ?? (await context.newPage());
await resetOrigin(context, page, { signOut: true });
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);

const identity = await session(page);
console.log("session:", JSON.stringify(identity));
if (JSON.stringify(identity) !== '{"status":"signed-out"}') {
	console.error("precondition failed: this repro must run signed out");
	process.exit(2);
}

const composer = page.locator("textarea, [contenteditable=true]").first();
await composer.click();
await composer.type("/");
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/canary-access-1.2-menu.png", fullPage: true });

const listing = await page.evaluate(() => {
	const element = document.querySelector('[class*="slash"], [role="listbox"], [class*="command-menu"], [class*="flow-menu"]');
	return element === null ? "" : (element as HTMLElement).innerText;
});
const names = listing.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("/"));
console.log(`listing holds ${names.length} flows; first is ${JSON.stringify(names[0])}`);

const failures: Array<string> = [];
if (names[0] !== "/auth.sign-in") failures.push(`the listing does not lead with /auth.sign-in (leads with ${names[0]})`);
const offered = SIGNED_IN_ONLY.filter((name) => names.includes(name));
if (offered.length > 0) {
	failures.push(`the signed-out listing offers ${offered.length} flows that cannot work signed out: ${offered.join(", ")}`);
}

await context.close();
report(failures);
