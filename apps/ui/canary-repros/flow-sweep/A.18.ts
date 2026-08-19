/*
 * Canary repro A.18 — /flow.create never reaches a terminal state. The
 * transcript shows "Preparing your <owner/repo> workspace…" and then stops:
 * no workflow card, no failure, no toast, and no further /api/ traffic (the
 * workspace is never provisioned — `POST /api/workflow/provision` is never
 * called, though /flow.list on the same repo does call it).
 *
 * Expected: a created workflow that is real on the workspace, or an honest
 *           failure naming what stopped it.
 * Actual:   stuck on "Preparing your … workspace…" for 90s.
 *
 *   bun apps/ui/canary-repros/flow-sweep/A.18.ts
 */
import { openApp, report } from "./_lib";

const app = await openApp();
const failures: string[] = [];
try {
	await app.invoke("/chat", 3000);
	const outcome = await app.invoke(
		"/flow.create nightly open issue digest codeplanesmithers/canary-sandbox",
		90000,
	);
	console.log("added:", JSON.stringify(outcome.added));
	console.log("net:", outcome.net.join(" | ") || "(no /api/ traffic)");
	const text = (await app.page.locator("body").innerText());
	const stuck = text.includes("Preparing your codeplanesmithers/canary-sandbox workspace…");
	const provisioned = outcome.net.some((entry) => entry.includes("/api/workflow/provision"));
	if (stuck) failures.push('/flow.create still says "Preparing your … workspace…" after 90s');
	if (!provisioned) failures.push("/flow.create never called POST /api/workflow/provision");
} finally {
	await app.close();
}
report(failures);
