/*
 * Repro — checklist row 26.6 ("`/debug.grants.reset` revokes the chain's
 * session grants and the next tool call re-asks") against
 * https://canary.smithers.sh.
 *
 * Two problems, one of them terminal for the row:
 *
 * 1. `/debug.grants.reset` renders nothing — no card, no message, no toast —
 *    so an admin has no confirmation the grants were revoked (same defect as
 *    26.2-26.5).
 * 2. The second half of the row is UNREACHABLE on the canary: session grants
 *    belong to the CHAIN backend, and a chain turn cannot run at all because
 *    `POST /api/model/stream` answered 501 (fixed 2026-08-19; `MODEL_RELAY_API_KEY` was unbound on
 *    `smithers-mvp-web`). See 26.1.md. So "the next tool call re-asks" can
 *    never be observed here.
 *
 *   PROF=/tmp/canary-admin-profile bun 26.6.ts
 *   exit 1 while either problem is present, 0 once the flow confirms and a
 *   chain tool call re-asks.
 *
 * Fixture: the session must be admin (identity worker ADMIN_LOGINS).
 */
import { open, session, run, body } from "./_lib";

const { context, page, requests } = await open();
const who = await session(page);
if (who.admin !== true) {
	console.error("SETUP: the session is not admin — add the login to the identity worker's ADMIN_LOGINS.");
	await context.close();
	process.exit(2);
}

const cardsBefore = await page.locator("section.smithers-card").count();
const messagesBefore = await page.locator("[data-role]").count();
await run(page, "/debug.grants.reset", 7000);
const cardsAfter = await page.locator("section.smithers-card").count();
const messagesAfter = await page.locator("[data-role]").count();
console.log(`after /debug.grants.reset — cards ${cardsBefore} -> ${cardsAfter}, messages ${messagesBefore} -> ${messagesAfter}`);

// The next tool-calling turn. There is one backend and it owns the grants.
const before = await body(page);
const mark = requests.length;
const composer = page.locator("textarea.sui-chat-composer-input");
await composer.click();
await composer.fill("List the repositories you are watching.");
await page.keyboard.press("Enter");
await page.waitForTimeout(35_000);
const after = await body(page);
const delta = (after.startsWith(before) ? after.slice(before.length) : after.slice(-800)).replace(/\s+/g, " ");
console.log("next turn:", delta.slice(0, 320));
console.log("http>=400 during the turn:", JSON.stringify(requests.slice(mark)));
await page.screenshot({ path: "/tmp/canary-26.6.png", fullPage: true });
console.log("screenshot: /tmp/canary-26.6.png");
await context.close();

const failures: Array<string> = [];
if (cardsAfter === cardsBefore && messagesAfter === messagesBefore) {
	failures.push("/debug.grants.reset rendered nothing — no confirmation that the grants were revoked.");
}
if (requests.slice(mark).some((entry) => entry.startsWith("501"))) {
	failures.push(
		"the next tool call could not be observed: the chain backend 501s on /api/model/stream, so no grant is ever re-asked. See 26.1.md.",
	);
}
if (failures.length === 0) {
	console.log("PASS — the reset confirms and the next tool call re-asks.");
	process.exit(0);
}
for (const failure of failures) console.error(`FAIL: ${failure}`);
process.exit(1);
