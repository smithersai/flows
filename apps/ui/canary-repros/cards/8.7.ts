/*
 * Repro for MANUAL-REVIEW-CHECKLIST row 8.7 (`request-queue` — approve an
 * entry) on https://canary.smithers.sh.
 *
 * The card's Approve button POSTs /api/admin/allowlist (HTTP 200) and then
 * re-reads GET /api/admin/requests — but the identity worker never removes
 * the queue row when a login is allowlisted. Its durable store
 * (~/flows/ui/workers/identity/src/store.ts) has commands `requestAccess`,
 * `listRequests` and `listAudit` and no remove/resolve command at all, and the
 * `req:index` record is only ever appended to. The approved login therefore
 * stays in the queue forever and the card keeps reading "N waiting".
 *
 * Exits non-zero while the entry survives its own approval.
 *
 *   bun apps/ui/canary-repros/cards/8.7.ts
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.CARDS_PROFILE ?? "/tmp/canary-cards-profile";

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1280, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);

const queue = async (): Promise<Array<{ login: string }>> =>
	page.evaluate(async () => {
		const response = await fetch("/api/admin/requests");
		const body = (await response.json()) as { requests?: Array<{ login: string }> };
		return body.requests ?? [];
	});

const before = await queue();
console.log(`queue before: ${JSON.stringify(before.map((row) => row.login))}`);
if (before.length === 0) {
	console.log("SKIP 8.7: the request-access queue is empty, so there is no entry to approve.");
	await context.close();
	process.exit(0);
}

const composer = page.locator("textarea").first();
await composer.click();
await composer.fill("");
await page.keyboard.type("/admin.requests", { delay: 8 });
await page.keyboard.press("Enter");
await page.waitForTimeout(8000);

const card = page.locator('[data-kind="request-queue"]').last();
console.log(`card title: ${await card.locator(".smithers-card-title").innerText()}`);

const approve = card.locator('button:has-text("Approve")').first();
console.log(`approve buttons: ${await approve.count()}`);
let allowlistStatus = 0;
page.on("response", (response) => {
	if (response.url().includes("/api/admin/allowlist")) allowlistStatus = response.status();
});
await approve.click();
await page.waitForTimeout(10000);

const after = await queue();
console.log(`POST /api/admin/allowlist -> HTTP ${allowlistStatus}`);
console.log(`queue after: ${JSON.stringify(after.map((row) => row.login))}`);
console.log(`card title after: ${await card.locator(".smithers-card-title").innerText()}`);

await page.screenshot({ path: "/tmp/canary-cards-8.7-queue.png", fullPage: true });
await context.close();

if (after.length >= before.length) {
	console.error(
		`FAIL 8.7: approving left the queue at ${after.length} entries (was ${before.length}); the identity store has no command that removes a request.`,
	);
	process.exit(1);
}
console.log("PASS 8.7: the approved entry left the queue.");
