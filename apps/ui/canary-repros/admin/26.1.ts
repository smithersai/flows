/*
 * Repro — checklist row 26.1 ("`/debug.backend proxy` and `/debug.backend
 * chain` both switch the agent backend and a turn works on each") against
 * https://canary.smithers.sh.
 *
 * The proxy backend runs a turn. The chain backend cannot: it drives the
 * browser model relay at POST /api/model/stream, and the deployed product
 * Worker `smithers-mvp-web` has NO `MODEL_RELAY_API_KEY` binding, so the relay
 * answers 501 by design (apps/server/src/index.ts: "an unconfigured relay
 * answers 501 instead of forwarding a request that can only come back 401").
 * Every chain turn ends "Turn failed".
 *
 * Neither `/debug.backend proxy` nor `/debug.backend chain` renders anything,
 * so the switch itself is also invisible — see 26.2 for that defect.
 *
 *   PROF=/tmp/canary-admin-profile bun 26.1.ts
 *   exit 1 while the bug is present, 0 once a chain turn completes.
 *
 * Fixture: the session must be admin (identity worker ADMIN_LOGINS) — the
 * debug.* flows only register for admin:true.
 */
import { open, session, run, body } from "./_lib";

const { context, page, requests } = await open();
const who = await session(page);
if (who.admin !== true) {
	console.error("SETUP: the session is not admin — add the login to the identity worker's ADMIN_LOGINS.");
	await context.close();
	process.exit(2);
}

const turn = async (backend: string): Promise<{ text: string; http: Array<string> }> => {
	await run(page, `/debug.backend ${backend}`, 4000);
	const before = await body(page);
	const mark = requests.length;
	const composer = page.locator("textarea.sui-chat-composer-input");
	await composer.click();
	await composer.fill(`Reply with exactly: PONG-${backend}`);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(35_000);
	const after = await body(page);
	return { text: after.startsWith(before) ? after.slice(before.length) : after.slice(-800), http: requests.slice(mark) };
};

const chain = await turn("chain");
console.log("=== chain ===");
console.log(chain.text.replace(/\s+/g, " ").slice(0, 400));
console.log("http>=400:", JSON.stringify(chain.http));

const proxy = await turn("proxy");
console.log("\n=== proxy ===");
console.log(proxy.text.replace(/\s+/g, " ").slice(0, 400));
console.log("http>=400:", JSON.stringify(proxy.http));

await page.screenshot({ path: "/tmp/canary-26.1.png", fullPage: true });
console.log("screenshot: /tmp/canary-26.1.png");
await context.close();

const failures: Array<string> = [];
if (!chain.text.includes("PONG-chain")) {
	failures.push(`a turn on the chain backend did not complete: ${chain.text.replace(/\s+/g, " ").slice(0, 200)}`);
}
if (!proxy.text.includes("PONG-proxy")) {
	failures.push("a turn on the proxy backend did not complete either.");
}
if (failures.length === 0) {
	console.log("PASS — both backends run a turn.");
	process.exit(0);
}
for (const failure of failures) console.error(`FAIL: ${failure}`);
process.exit(1);
