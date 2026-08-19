/*
 * Repro — checklist row 28.6 ("Spacing and alignment are consistent across
 * cards, panes, and the composer") against https://canary.smithers.sh.
 *
 * The request-access queue card runs the login straight into the date with no
 * gap: `<span class="queue-login">codeplanesmithers</span><span
 * class="queue-at">2026-08-19</span>` renders as
 * "codeplanesmithers2026-08-19Approve".
 *
 *   PROF=/tmp/canary-admin-profile bun 28.6.ts
 *   exit 1 while the bug is present, 0 once the row is spaced.
 *
 * Fixture: the session must be admin (identity worker ADMIN_LOGINS), and the
 * request-access queue must hold at least one entry.
 */
import { open, session, run } from "./_lib";

const { context, page } = await open();
const who = await session(page);
if (who.admin !== true) {
	console.error("SETUP: the session is not admin — add the login to the identity worker's ADMIN_LOGINS.");
	await context.close();
	process.exit(2);
}
await run(page, "/admin.requests", 8000);

const row = await page.evaluate(() => {
	const element = document.querySelector("li.queue-row");
	if (element === null) return null;
	const login = element.querySelector(".queue-login") as HTMLElement | null;
	const at = element.querySelector(".queue-at") as HTMLElement | null;
	const gap = login !== null && at !== null ? at.getBoundingClientRect().left - login.getBoundingClientRect().right : null;
	return { text: (element as HTMLElement).innerText, html: element.innerHTML, gapPx: gap };
});
if (row === null) {
	console.error("SETUP: the queue is empty — no li.queue-row to measure.");
	await context.close();
	process.exit(2);
}
console.log("rendered text:", JSON.stringify(row.text));
console.log("gap between .queue-login and .queue-at:", row.gapPx, "px");
console.log("html:", row.html.slice(0, 300));
await page.screenshot({ path: "/tmp/canary-28.6.png", fullPage: true });
console.log("screenshot: /tmp/canary-28.6.png");
await context.close();

const runTogether = /[a-z]\d{4}-\d{2}-\d{2}/.test(row.text) || (row.gapPx !== null && row.gapPx < 4);
if (runTogether) {
	console.error(
		`FAIL: the queue row runs the login into the date — ${JSON.stringify(row.text)} (gap ${row.gapPx}px between .queue-login and .queue-at).`,
	);
	process.exit(1);
}
console.log("PASS — the queue row is spaced.");
