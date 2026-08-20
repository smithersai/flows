/*
 * Canary repro A.26 — /copy-message fails with an UNHANDLED PROMISE
 * REJECTION and says nothing. The clipboard write throws
 * `NotAllowedError: Failed to execute 'writeText' on 'Clipboard'` and the
 * only trace is a POST to /api/client-errors; the human sees no toast, no
 * message, and no indication the copy did not happen.
 *
 * Expected: either the copy succeeds visibly, or it fails with an honest
 *           line naming the next step.
 * Actual:   silence plus an unhandledrejection shipped to the client-error
 *           sink.
 *
 *   bun apps/ui/canary-repros/flow-sweep/A.26.ts
 */
import { openApp, report } from "./_lib";

const app = await openApp();
const failures: string[] = [];
const clientErrors: string[] = [];
app.page.on("request", (request) => {
	if (request.url().includes("/api/client-errors")) clientErrors.push((request.postData() ?? "").slice(0, 300));
});
try {
	const outcome = await app.invoke("/copy-message flow-sweep A26 clipboard probe", 6000);
	console.log("added:", JSON.stringify(outcome.added));
	console.log("client errors:", clientErrors);
	if (clientErrors.some((body) => body.includes("unhandledrejection") && body.includes("Clipboard"))) {
		failures.push("/copy-message raised an unhandled clipboard rejection");
	}
	if (outcome.added.length === 0) failures.push("/copy-message rendered nothing — success and failure look identical");
} finally {
	await app.close();
}
report(failures);
