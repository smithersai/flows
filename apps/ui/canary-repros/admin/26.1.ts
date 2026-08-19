/*
 * Row 26.1, re-cut for the single-backend contract, against
 * https://canary.smithers.sh.
 *
 * The row used to read "`/debug.backend proxy` and `/debug.backend chain` both
 * switch the agent backend and a turn works on each", and it failed: the chain
 * drove the browser model relay at POST /api/model/stream, which was pointed at
 * Anthropic behind a MODEL_RELAY_API_KEY the deployed Worker never had, so
 * every chain turn ended "Turn failed".
 *
 * Fixed 2026-08-19 by removing the second backend rather than by binding a
 * second key. The relay forwards to the SAME managed-inference upstream
 * /api/agent/turn used, and the browser chain is the only backend. So this
 * script now checks the contract that replaced the row:
 *
 *   1. /debug.backend reports the one backend and refuses to switch.
 *   2. A real turn completes.
 *   3. It spent its model on /api/model/stream and never on /api/agent/turn.
 *
 *   PROF=/tmp/canary-admin-profile bun 26.1.ts
 *   exit 0 when the contract holds.
 *
 * Fixture: the session must be admin (identity worker ADMIN_LOGINS) — the
 * debug.* flows only register for admin:true.
 */
import { open, session, run, body, report } from "./_lib";

const { context, page, requests } = await open();
const who = await session(page);
if (who.admin !== true) {
	console.error("SETUP: the session is not admin — add the login to the identity worker's ADMIN_LOGINS.");
	await context.close();
	process.exit(2);
}

/* Every model-spending request the page makes, by route. */
const modelCalls: Array<string> = [];
page.on("request", (request) => {
	const path = new URL(request.url()).pathname;
	if (path === "/api/model/stream" || path.startsWith("/api/agent/turn")) {
		modelCalls.push(`${request.method()} ${path}`);
	}
});

const reportedBefore = await body(page);
await run(page, "/debug.backend", 4000);
const reported = (await body(page)).slice(reportedBefore.length);
console.log("=== /debug.backend ===");
console.log(reported.replace(/\s+/g, " ").slice(0, 300));

const refusedBefore = await body(page);
await run(page, "/debug.backend proxy", 4000);
const refused = (await body(page)).slice(refusedBefore.length);
console.log("=== /debug.backend proxy ===");
console.log(refused.replace(/\s+/g, " ").slice(0, 300));

const turnBefore = await body(page);
const composer = page.locator("textarea.sui-chat-composer-input");
await composer.click();
await composer.fill("Reply with exactly: PONG-chain");
await page.keyboard.press("Enter");
await page.waitForTimeout(60_000);
const turn = (await body(page)).slice(turnBefore.length);

console.log("=== turn ===");
console.log(turn.replace(/\s+/g, " ").slice(0, 600));
console.log("model calls:", JSON.stringify(modelCalls));
console.log("http>=400:", JSON.stringify(requests));

await page.screenshot({ path: "/tmp/canary-26.1.png", fullPage: true });
console.log("screenshot: /tmp/canary-26.1.png");
await context.close();

const failures: Array<string> = [];
if (!reported.includes("chain")) {
	failures.push(`/debug.backend did not report the backend: ${reported.replace(/\s+/g, " ").slice(0, 200)}`);
}
if (!refused.includes("cannot be switched")) {
	failures.push(`/debug.backend proxy did not refuse honestly: ${refused.replace(/\s+/g, " ").slice(0, 200)}`);
}
if (!turn.includes("PONG-chain")) {
	failures.push(`the chain turn did not complete: ${turn.replace(/\s+/g, " ").slice(0, 200)}`);
}
if (!modelCalls.includes("POST /api/model/stream")) {
	failures.push("the turn never spent a model on /api/model/stream.");
}
const toTurnSeam = modelCalls.filter((call) => call.includes("/api/agent/turn"));
if (toTurnSeam.length > 0) {
	failures.push(`the turn reached the retired proxy seam: ${JSON.stringify(toTurnSeam)}`);
}
report(failures);
