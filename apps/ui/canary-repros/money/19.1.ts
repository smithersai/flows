/*
 * Checklist 19.1 — "`/notifications.list` renders the list, with an empty
 * state."
 *
 * The bug: the empty state renders, the LIST does not. `NotificationsSeam`
 * parses a GitHub-notifications wire shape (`subject.title`,
 * `repository.full_name`, `unread`) but the jjhub platform answers a flat
 * shape (`subject` is a plain string, `status: "unread" | "read"`). Every row
 * fails `title === null` in `parseNotification` and is dropped silently, so a
 * populated list always renders as "Nothing new."
 *
 * Fixture: the run seeds one notification for `codeplanesmithers` when the
 * platform list is empty, so the row can be graded. Seeding needs the prod DB
 * (see 19.1.md); without it this script reports that it could not test.
 *
 *   bun canary-repros/money/19.1.ts
 */
import { chromium } from "playwright";
import { BASE, PROFILE, ensureSignedIn, report, seam, sendPrompt } from "./_lib";

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 950 } });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
await ensureSignedIn(page);
await page.waitForTimeout(2500);

const failures: Array<string> = [];

const wire = await seam(page, "/api/notifications/list?limit=20&all=true");
const rows = Array.isArray(wire.body) ? (wire.body as ReadonlyArray<unknown>) : [];
if (rows.length === 0) {
	console.error("SKIP: the platform has no notifications for this account — seed one first (see 19.1.md).");
	await context.close();
	process.exit(2);
}

await sendPrompt(page, "/notifications.list");
await page.waitForTimeout(8000);
const card = await page.evaluate(() => {
	const element = document.querySelector('[data-kind="notifications"]');
	return element === null
		? null
		: { text: (element as HTMLElement).innerText, rows: element.querySelectorAll(".world-card-row").length };
});
if (card === null) failures.push("/notifications.list rendered no notifications card");
else if (card.rows !== rows.length) {
	failures.push(
		`the platform answered ${rows.length} notification(s) but the card rendered ${card.rows} row(s): ${JSON.stringify(card.text)}`,
	);
}

await page.screenshot({ path: "/tmp/money-19.1.png", fullPage: true });
await context.close();
report(failures);
