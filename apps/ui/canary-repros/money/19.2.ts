/*
 * Checklist 19.2 — "`/notifications.read` marks every notification read, and
 * the unread indicator clears."
 *
 * The bug: PUT /api/notifications/mark-read really does mark the rows read
 * (204, and the platform row flips to `status: "read"`), but the UI never
 * showed an unread indicator to clear. The card's unread Badge, the BellDot
 * icon, and the "Mark all read" button all hang off rows the seam dropped
 * (see 19.1), so `unread` is always 0 and the affordance never renders.
 *
 * Fixture: needs at least one UNREAD notification for `codeplanesmithers`
 * (see 19.1.md for the seeding step).
 *
 *   bun canary-repros/money/19.2.ts
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
const rows = Array.isArray(wire.body) ? (wire.body as ReadonlyArray<Record<string, unknown>>) : [];
if (rows.length === 0) {
	console.error("SKIP: the platform has no notifications for this account — seed one first (see 19.1.md).");
	await context.close();
	process.exit(2);
}

await sendPrompt(page, "/notifications.list");
await page.waitForTimeout(8000);

const unreadMarks = await page.evaluate(() => ({
	unreadRows: document.querySelectorAll('[data-kind="notifications"] [data-read="false"]').length,
	markAllRead: document.querySelectorAll('[data-flow="notifications.read"]').length,
	cardText: document.querySelector('[data-kind="notifications"]')?.textContent ?? null,
}));
const unreadOnWire = rows.filter((row) => row.status === "unread").length;
if (unreadOnWire > 0 && unreadMarks.unreadRows === 0) {
	failures.push(
		`${unreadOnWire} unread notification(s) on the wire but the card shows no unread indicator: ${JSON.stringify(unreadMarks.cardText)}`,
	);
}
if (unreadOnWire > 0 && unreadMarks.markAllRead === 0) {
	failures.push('no [data-flow="notifications.read"] affordance rendered, so there is nothing to clear the indicator with');
}

await page.screenshot({ path: "/tmp/money-19.2.png", fullPage: true });
await context.close();
report(failures);
