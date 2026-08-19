/*
 * Repro — checklist row 25.7 ("`/admin.health` reports service health, charges,
 * and queue depth, and the numbers are real") against https://canary.smithers.sh.
 *
 * Service health and queue depth ARE real. The charges figure is not: the card
 * reports `Charges: $0.002675 across 393 turns` while billing's own answer for
 * a SINGLE user (`codeplanesmithers`) is chargeCount 1820 and this month's
 * cost $0.34. A fleet total cannot be smaller than one user's, and the health
 * figure does not move as turns are spent (identical at 08:49 and 09:33 across
 * ~170 turns), so it is stale or scoped to something other than what it claims.
 *
 *   PROF=/tmp/canary-admin-profile bun 25.7.ts
 *   exit 1 while the bug is present, 0 once the health charges track billing.
 *
 * Fixture: the session must be admin (identity worker ADMIN_LOGINS).
 * Route: GET /api/admin/health  vs  GET /api/billing/balance, /api/billing/usage
 */
import { open, session } from "./_lib";

const { context, page } = await open();
const who = await session(page);
if (who.admin !== true) {
	console.error("SETUP: the session is not admin — add the login to the identity worker's ADMIN_LOGINS.");
	await context.close();
	process.exit(2);
}

const health = (await page.evaluate(async () => (await fetch("/api/admin/health")).json())) as {
	charges: { chargeCount: number; lifetimeChargedUsd: string };
	queueDepth: number;
	services: ReadonlyArray<{ name: string; status: string }>;
};
const balance = (await page.evaluate(async () => (await fetch("/api/billing/balance")).json())) as {
	balance: { chargeCount: number };
};
const usage = (await page.evaluate(async () => (await fetch("/api/billing/usage")).json())) as {
	totalCostUsd: string;
};

console.log("admin.health charges :", JSON.stringify(health.charges));
console.log("admin.health queue   :", health.queueDepth);
console.log("admin.health services:", health.services.map((s) => `${s.name}=${s.status}`).join(", "));
console.log("billing chargeCount for codeplanesmithers alone:", balance.balance.chargeCount);
console.log("billing usage totalCostUsd this month           :", usage.totalCostUsd);

// A second read a few seconds later: a live counter moves, a stale one does not.
await page.waitForTimeout(4000);
const again = (await page.evaluate(async () => (await fetch("/api/admin/health")).json())) as {
	charges: { chargeCount: number };
};
console.log("admin.health chargeCount re-read:", again.charges.chargeCount);
await context.close();

const failures: Array<string> = [];
if (health.charges.chargeCount < balance.balance.chargeCount) {
	failures.push(
		`admin.health reports ${health.charges.chargeCount} charges, fewer than the ${balance.balance.chargeCount} billing counts for ONE user — the figure cannot be the fleet total it is presented as.`,
	);
}
if (Number(health.charges.lifetimeChargedUsd) < Number(usage.totalCostUsd)) {
	failures.push(
		`admin.health reports $${health.charges.lifetimeChargedUsd} charged while billing's usage for this month alone is $${usage.totalCostUsd}.`,
	);
}
if (failures.length === 0) {
	console.log("PASS — the health charges track billing.");
	process.exit(0);
}
for (const failure of failures) console.error(`FAIL: ${failure}`);
process.exit(1);
