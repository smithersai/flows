/*
 * Canary repro A.86 — /admin.queue.approve <login> says nothing and leaves
 * the queue entry in place. Invoking it posts to /api/admin/allowlist (200)
 * and re-reads /api/admin/requests, but the transcript gains no line and the
 * request-queue card still reads "Request-access queue — 1 waiting" with the
 * same login on it.
 *
 * Expected: §25.2 — the entry is approved, leaves the queue, and the card
 *           says so; a login that is not queued is refused by name.
 * Actual:   silence, and the entry stays "waiting".
 *
 * Requires an admin session (the flow only registers when /api/auth/session
 * answers admin:true).
 *
 *   bun apps/ui/canary-repros/flow-sweep/A.86.ts
 */
import { openApp, report } from "./_lib";

const app = await openApp();
const failures: string[] = [];
try {
	const session = await app.page.evaluate(async () => (await fetch("/api/auth/session")).text());
	if (!session.includes('"admin":true')) {
		throw new Error(`this repro needs an admin session; /api/auth/session says ${session}`);
	}
	const queue = await app.page.evaluate(async () => (await fetch("/api/admin/requests")).json());
	const waiting = (queue as { requests: Array<{ login: string }> }).requests;
	console.log("queue:", waiting.map((entry) => entry.login).join(",") || "(empty)");
	const login = waiting[0]?.login;
	if (login === undefined) throw new Error("the request-access queue is empty — seed an entry first");

	const outcome = await app.invoke(`/admin.queue.approve ${login}`, 8000);
	console.log("added:", JSON.stringify(outcome.added), "net:", outcome.net.join(" | "));
	if (outcome.added.length === 0) failures.push(`/admin.queue.approve ${login} rendered nothing`);

	const after = await app.page.evaluate(async () => (await fetch("/api/admin/requests")).json());
	const stillWaiting = (after as { requests: Array<{ login: string }> }).requests.some((entry) => entry.login === login);
	if (stillWaiting) failures.push(`${login} is still in the request-access queue after being approved`);

	const bogus = await app.invoke("/admin.queue.approve nosuchlogin-zzz", 8000);
	if (bogus.added.length === 0) failures.push("/admin.queue.approve with an unqueued login rendered nothing");
} finally {
	await app.close();
}
report(failures);
