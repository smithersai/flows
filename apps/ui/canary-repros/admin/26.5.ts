/*
 * Repro — checklist row 26.5 ("`/debug.net` reads the network tap") against
 * https://canary.smithers.sh.
 *
 * The flow RUNS — a `command.ran` transition is journalled — and its handler
 * returns the data (the agent can read it: asking the model to run
 * `debug.net` prints the payload). But a USER who types `/debug.net`
 * sees nothing at all: no card, no transcript line, no toast. The flow's
 * return value is dropped at the flow boundary.
 *
 * This is the systemic "renders nothing" defect already traced in
 * ../ROOT-CAUSES.md §1: a flow that succeeds with a value reaches
 * `AppController.surfaceCommandFailure` with `status: "executed"`, which
 * returns early, so the value is discarded.
 *
 *   PROF=/tmp/canary-admin-profile bun 26.5.ts
 *   exit 1 while the bug is present, 0 once the read is rendered.
 *
 * Fixture: the session must be admin (identity worker ADMIN_LOGINS).
 */
import { open, session, run, body } from "./_lib";

const { context, page } = await open();
const who = await session(page);
if (who.admin !== true) {
	console.error("SETUP: the session is not admin — add the login to the identity worker's ADMIN_LOGINS.");
	await context.close();
	process.exit(2);
}

// Give the read something real to report.
await run(page, "/billing.balance", 5000);

const cardsBefore = await page.locator("section.smithers-card").count();
const messagesBefore = await page.locator("[data-role]").count();
const before = await body(page);

await run(page, "/debug.net", 7000);

const cardsAfter = await page.locator("section.smithers-card").count();
const messagesAfter = await page.locator("[data-role]").count();
const after = await body(page);

console.log(`cards    ${cardsBefore} -> ${cardsAfter}`);
console.log(`messages ${messagesBefore} -> ${messagesAfter}`);
console.log("new rendered text:", JSON.stringify((after.startsWith(before) ? after.slice(before.length) : "").trim().slice(0, 300)));

// Proof the flow really ran: the dev-tools transition journal records it.
await run(page, "/admin.devtools", 4000);
const panel = await body(page);
const journal = panel.slice(panel.indexOf("Transitions"), panel.indexOf("Transitions") + 200);
console.log("transition journal head:", journal.replace(/\s+/g, " "));
await page.screenshot({ path: "/tmp/canary-26.5.png", fullPage: true });
console.log("screenshot: /tmp/canary-26.5.png");
await context.close();

const rendered = cardsAfter > cardsBefore || messagesAfter > messagesBefore;
if (rendered) {
	console.log("PASS — /debug.net rendered its read.");
	process.exit(0);
}
console.error("FAIL: /debug.net added no card and no message — the read is invisible to the user.");
process.exit(1);
