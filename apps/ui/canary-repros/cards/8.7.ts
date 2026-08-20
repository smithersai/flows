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
import { withVerifiedRestoration } from "../../scripts/canary-restoration";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.CARDS_PROFILE ?? "/tmp/canary-cards-profile";
const LOGIN = process.env.CANARY_ACCESS_REQUEST_LOGIN ?? "";
const IDENTITY = process.env.IDENTITY_UPSTREAM_URL ?? "https://smithers-cloud-identity.willcory10.workers.dev";
const ADMIN_TOKEN = process.env.IDENTITY_ADMIN_TOKEN ?? "";
if (LOGIN === "" || ADMIN_TOKEN === "") {
	throw new Error("CANARY_ACCESS_REQUEST_LOGIN and IDENTITY_ADMIN_TOKEN are required for a fenced request and independent cleanup");
}

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
if (!before.some((row) => row.login === LOGIN)) {
	console.error(`SETUP 8.7: the exact disposable request ${LOGIN} is not present; refusing to approve an ambient requester.`);
	await context.close();
	process.exit(2);
}

const composer = page.locator("textarea").first();
await composer.click();
await composer.fill("");
await page.keyboard.type("/admin.requests", { delay: 8 });
await page.keyboard.press("Enter");
await page.waitForTimeout(8000);

const card = page.locator('[data-kind="request-queue"]').last();
console.log(`card title: ${await card.locator(".smithers-card-title").innerText()}`);

const row = card.locator(".queue-row").filter({ has: page.locator(".queue-login", { hasText: LOGIN }) });
if ((await row.count()) !== 1 || (await row.locator(".queue-login").innerText()) !== LOGIN) {
	await context.close();
	throw new Error(`fixture fence failed: expected exactly one queue row for ${LOGIN}`);
}
const approve = row.locator('button:has-text("Approve")');
console.log(`approve buttons: ${await approve.count()}`);
let allowlistStatus = 0;
page.on("response", (response) => {
	if (response.url().includes("/api/admin/allowlist")) allowlistStatus = response.status();
});
let after: Array<{ login: string }> = [];
await withVerifiedRestoration(
	async () => {
		await approve.click();
		await page.waitForTimeout(10000);
		after = await queue();
		console.log(`POST /api/admin/allowlist -> HTTP ${allowlistStatus}`);
		console.log(`queue after: ${JSON.stringify(after.map((entry) => entry.login))}`);
		console.log(`card title after: ${await card.locator(".smithers-card-title").innerText()}`);
	},
	async () => {
		const response = await fetch(new URL("/api/identity/admin/allowlist", IDENTITY), {
			method: "POST",
			headers: { "content-type": "application/json", "x-smithers-admin-token": ADMIN_TOKEN },
			body: JSON.stringify({
				login: LOGIN,
				action: "remove",
				requester: "uicanaries-request-queue-cleanup",
				timestamp: new Date().toISOString(),
			}),
		});
		const body = await response.text();
		if (!response.ok) throw new Error(`allowlist cleanup answered HTTP ${response.status}: ${body.slice(0, 200)}`);
	},
	async () => {
		const response = await fetch(new URL(`/api/identity/allowlist/${encodeURIComponent(LOGIN)}`, IDENTITY), {
			headers: { "x-smithers-admin-token": ADMIN_TOKEN },
		});
		const body = (await response.json().catch(() => null)) as { allowlisted?: boolean } | null;
		if (!response.ok || body?.allowlisted !== false) {
			throw new Error(`read-back did not prove ${LOGIN} was removed: HTTP ${response.status} ${JSON.stringify(body)}`);
		}
	},
	`remove ${LOGIN} from the identity allowlist using IDENTITY_ADMIN_TOKEN`,
);

await page.screenshot({ path: "/tmp/canary-cards-8.7-queue.png", fullPage: true });
await context.close();

if (after.some((entry) => entry.login === LOGIN)) {
	console.error(
		`FAIL 8.7: approving left the fenced request ${LOGIN} in the queue.`,
	);
	process.exit(1);
}
console.log("PASS 8.7: the approved entry left the queue.");
