/*
 * Repro — checklist row 28.4 ("Every destructive action confirms, and the
 * confirm names the object") against https://canary.smithers.sh.
 *
 * The header's "Reset conversation" button wipes the whole transcript on a
 * single click. No dialog, no confirm, no undo — 16,579 characters of
 * conversation to 129 in one click.
 *
 *   PROF=/tmp/canary-admin-profile bun 28.4.ts
 *   exit 1 while the bug is present, 0 once the action confirms.
 */
import { open, run, body } from "./_lib";

const { context, page } = await open();

// Build a transcript worth losing.
for (const flow of ["/billing.balance", "/repos.list", "/help"]) await run(page, flow, 5000);
const before = await body(page);
const messagesBefore = await page.locator("[data-role]").count();
console.log("transcript before:", before.length, "chars,", messagesBefore, "messages");

const reset = page.locator('button[aria-label="Reset conversation"]').first();
if (!(await reset.isVisible().catch(() => false))) {
	console.error('SETUP: no button[aria-label="Reset conversation"] in the header.');
	await context.close();
	process.exit(2);
}
await reset.click();
await page.waitForTimeout(3000);

const dialogs = await page.locator('[role="dialog"], [role="alertdialog"]').count();
const after = await body(page);
const messagesAfter = await page.locator("[data-role]").count();
console.log("dialogs shown after the click:", dialogs);
console.log("transcript after :", after.length, "chars,", messagesAfter, "messages");
console.log("visible now:", after.replace(/\s+/g, " ").slice(0, 200));
await page.screenshot({ path: "/tmp/canary-28.4.png", fullPage: true });
console.log("screenshot: /tmp/canary-28.4.png");
await context.close();

const destroyed = messagesAfter < messagesBefore;
if (destroyed && dialogs === 0) {
	console.error(
		`FAIL: "Reset conversation" destroyed the transcript (${messagesBefore} -> ${messagesAfter} messages) on one click, with no confirmation dialog.`,
	);
	process.exit(1);
}
if (!destroyed) {
	console.error("FAIL(setup): the reset did not destroy anything, so this row cannot be graded here.");
	process.exit(2);
}
console.log("PASS — the destructive action confirmed first.");
