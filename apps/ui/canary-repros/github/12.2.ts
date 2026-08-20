/*
 * Repro — checklist §12.2: "Import a large repo: progress is legible and the
 * card ends in a terminal state."
 *
 * Expected: the repo-import card reaches DONE or FAILED.
 * Actual: importing facebook/react leaves the card in RUNNING with the note
 * "lost the import stream — run /repos.import again to re-check", and it never
 * leaves RUNNING. Re-running /repos.import re-attaches to the SAME job id and
 * repeats the stall; GET /api/github/import/<jobId> shows the backend job
 * parked at status "cloning" / stage "resolving", updated one second after it
 * was created.
 *
 * Exits non-zero while the bug is present.
 *
 *   cp -R ~/.multi-e2e-profile /tmp/canary-github-profile
 *   bun apps/ui/canary-repros/github/12.2.ts
 */
import { BASE, ensureSignedIn, open, report } from "./_lib";

const LARGE = process.env.LARGE_REPO ?? "facebook/react";
/* The import worker is the slow part; give it four minutes before calling it. */
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 240_000);

const { context, page } = await open();
await ensureSignedIn(page);

const composer = page.locator("textarea").last();
await composer.click();
await composer.fill(`/repos.import ${LARGE}`);
await page.waitForTimeout(400);
await page.keyboard.press("Enter");

const card = page.locator('[data-kind="repo-import"]').last();
let text = "";
const started = Date.now();
while (Date.now() - started < BUDGET_MS) {
	await page.waitForTimeout(10_000);
	text = await card.innerText().catch(() => "");
	console.log(`t+${Math.round((Date.now() - started) / 1000)}s: ${text.replace(/\n+/g, " | ").slice(0, 160)}`);
	if (/\bDONE\b|\bFAILED\b/.test(text)) break;
}

await page.screenshot({ path: "/tmp/canary-github-12.2.png", fullPage: true });
console.log(`origin: ${BASE}; screenshot: /tmp/canary-github-12.2.png`);
await context.close();

report(
	/\bDONE\b|\bFAILED\b/.test(text)
		? []
		: [
				`the ${LARGE} import card never reached a terminal state within ${BUDGET_MS / 1000}s — last card text: ${text.replace(/\n+/g, " | ").slice(0, 200)}`,
			],
);
