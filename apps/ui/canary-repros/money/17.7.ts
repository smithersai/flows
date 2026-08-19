/*
 * 17.7 — the admin grant surface: no token → 401, untimestamped → 400, a valid
 * grant credits exactly once with an audit record.
 *
 * Two of the three clauses need billing's deployed ADMIN_SERVICE_TOKEN, which
 * the operator holds (workers/billing/DEPLOY.md names will as the holder) and
 * which Cloudflare will not read back. This script grades what is reachable
 * without it and states the rest as unreachable rather than guessing:
 *
 *   clause 1  reachable  — an unauthenticated grant must be refused with 401
 *   clause 2  unreachable without CHECKLIST_BILLING_ADMIN_TOKEN
 *   clause 3  unreachable without CHECKLIST_BILLING_ADMIN_TOKEN
 *
 * Set CHECKLIST_BILLING_ADMIN_TOKEN in the environment to grade all three. The
 * token is never printed.
 *
 *   bun canary-repros/money/17.7.ts
 */
import { chromium } from "playwright";
import { BASE, PROFILE, ensureSignedIn, report, seam } from "./_lib";

const BILLING = process.env.BILLING_UPSTREAM ?? "https://billing.smithers.sh";
const GRANTS = `${BILLING}/api/billing/admin/grants`;
const TOKEN = process.env.CHECKLIST_BILLING_ADMIN_TOKEN ?? "";

const failures: string[] = [];

/* Clause 1 — the row's own words: no token → 401. */
const anonymous = await fetch(GRANTS, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ login: "codeplanesmithers", amountUsd: 1, requester: "canary-money-lane" }),
});
const anonymousText = (await anonymous.text()).slice(0, 200);
if (anonymous.status !== 401) {
	failures.push(`an unauthenticated grant answered HTTP ${anonymous.status} ${anonymousText}, not the 401 the row requires`);
}

/* Clauses 2 and 3 — only with the deployed admin token. */
if (TOKEN === "") {
	failures.push(
		"clauses 2 and 3 are unreachable: CHECKLIST_BILLING_ADMIN_TOKEN is unset, so the untimestamped-400 and " +
			"credits-exactly-once halves of the row were never exercised (the deployed billing ADMIN_SERVICE_TOKEN is held by the operator)",
	);
} else {
	const headers = { "content-type": "application/json", "x-smithers-admin-token": TOKEN };
	const untimestamped = await fetch(GRANTS, {
		method: "POST",
		headers,
		body: JSON.stringify({
			login: "codeplanesmithers",
			grantId: "admin:canary-money-17-7-untimestamped",
			amountUsd: 1,
			requester: "canary-money-lane",
		}),
	});
	const untimestampedText = await untimestamped.text();
	if (untimestamped.status !== 400 || !untimestampedText.includes("timestamp_required")) {
		failures.push(`an untimestamped grant answered HTTP ${untimestamped.status} ${untimestampedText.slice(0, 200)}, not 400 timestamp_required`);
	}
	const timestamp = new Date().toISOString();
	const grantId = `admin:canary-money-17-7-${timestamp}`;
	const body = JSON.stringify({
		login: "codeplanesmithers",
		grantId,
		amountUsd: 1,
		requester: "canary-money-lane",
		timestamp,
		reason: "canary-money-lane-row-17.7",
	});
	const first = await fetch(GRANTS, { method: "POST", headers, body });
	const firstBody = (await first.json().catch(() => null)) as Record<string, unknown> | null;
	const replay = await fetch(GRANTS, { method: "POST", headers, body });
	const replayBody = (await replay.json().catch(() => null)) as Record<string, unknown> | null;
	if (first.status !== 201 || firstBody?.granted !== true) {
		failures.push(`the first grant answered HTTP ${first.status} ${JSON.stringify(firstBody)}, not 201 {granted:true}`);
	}
	if (replay.status === 201 || replayBody?.duplicate !== true) {
		failures.push(`replaying the same grantId credited again: HTTP ${replay.status} ${JSON.stringify(replayBody)}`);
	}
	/* The audit record: requester and requestedAt must be on the stored credit. */
	if (typeof firstBody?.requester !== "string" || typeof firstBody?.requestedAt !== "string") {
		failures.push(`the grant answer carries no audit attribution: ${JSON.stringify(firstBody)}`);
	}
}

/*
 * The product half, on the canary itself: /api/admin/grant must be
 * non-enumerable to a non-admin session (the canonical 404, never 403).
 */
const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 1000 } });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const account = await ensureSignedIn(page);
const grantAsUser = await seam(page, "/api/admin/grant", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ login: "codeplanesmithers", amountUsd: 1 }),
} as RequestInit);
if (grantAsUser.status !== 404) {
	failures.push(`POST /api/admin/grant as a non-admin session answered HTTP ${grantAsUser.status} ${grantAsUser.text.slice(0, 160)}, not the canonical 404`);
}
console.log(`account: ${JSON.stringify(account)}`);
console.log(`billing ${GRANTS} without a token: HTTP ${anonymous.status} ${anonymousText}`);
console.log(`canary POST /api/admin/grant as a non-admin: HTTP ${grantAsUser.status} ${grantAsUser.text.slice(0, 160)}`);
await context.close();
report(failures);
