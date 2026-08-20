/*
 * Canary repro A.59 — /keys.list cannot succeed on canary. The product
 * Worker proxies GET /api/user/byok-keys to the Smithers Cloud platform
 * (api.jjhub.tech), which answers 404 with the Go router's plain
 * "404 page not found". The UI is honest about it — the toast reads
 * "/keys.list didn't run" over "404 page not found" — but the flow has no
 * working success path, and the toast's detail is a raw upstream body rather
 * than a next step.
 *
 * Expected: the `keys` card, listing provider keys masked (§18.1).
 * Actual:   404 from the platform on every attempt.
 *
 *   bun apps/ui/canary-repros/flow-sweep/A.59.ts
 */
import { openApp, report } from "./_lib";

const app = await openApp();
const failures: string[] = [];
try {
	const outcome = await app.invoke("/keys.list", 9000);
	console.log("added:", JSON.stringify(outcome.added));
	console.log("net:", outcome.net.join(" | "));
	if (outcome.net.some((entry) => entry.startsWith("404") && entry.includes("/api/user/byok-keys"))) {
		failures.push("GET /api/user/byok-keys answers 404 — /keys.list has no success path on canary");
	}
	if (outcome.added.some((line) => line.includes("404 page not found"))) {
		failures.push('the refusal shows the upstream body "404 page not found" instead of a next step');
	}
} finally {
	await app.close();
}
report(failures);
