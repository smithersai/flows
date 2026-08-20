/*
 * Repro — checklist rows 28.11 ("No console errors or warnings during a normal
 * session") and 28.12 ("No network request 4xx/5xx during a normal session")
 * against https://canary.smithers.sh.
 *
 * A normal signed-in session that runs the everyday read flows produces one
 * console error and one 4xx: `/keys.list` calls
 * `GET /api/user/byok-keys`, which the product Worker does not serve. The
 * upstream's raw body — the literal string "404 page not found" — is then shown
 * to the user in the toast.
 *
 * "Normal session" here means the DEFAULT agent backend (proxy). The chain
 * backend produces six more errors (501 on /api/model/stream); that is 26.1,
 * not this row.
 *
 *   PROF=/tmp/canary-admin-profile bun 28.11.ts
 *   exit 1 while the bug is present, 0 once the session is clean.
 */
import { open, run, body } from "./_lib";

const { context, page } = await open();

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);

// Everything below is the measured window.
const consoleMessages: Array<string> = [];
const failedRequests: Array<string> = [];
page.on("console", (message) => {
	if (message.type() === "error" || message.type() === "warning") consoleMessages.push(`${message.type()}: ${message.text()}`);
});
page.on("pageerror", (error) => consoleMessages.push(`pageerror: ${String(error)}`));
page.on("response", (response) => {
	if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
});

for (const flow of ["/billing.balance", "/repos.list", "/notifications", "/help", "/connectors", "/world", "/keys.list"]) {
	await run(page, flow, 6000);
}
const composer = page.locator("textarea.sui-chat-composer-input");
await composer.click();
await composer.fill("Say PONG.");
await page.keyboard.press("Enter");
await page.waitForTimeout(30_000);

const text = await body(page);
console.log("28.11 console errors/warnings:", JSON.stringify([...new Set(consoleMessages)], null, 1));
console.log("28.12 responses >= 400      :", JSON.stringify([...new Set(failedRequests)], null, 1));
console.log('raw upstream body shown to the user:', text.includes("404 page not found"));
await page.screenshot({ path: "/tmp/canary-28.11.png", fullPage: true });
console.log("screenshot: /tmp/canary-28.11.png");
await context.close();

const failures: Array<string> = [];
if (consoleMessages.length > 0) failures.push(`${consoleMessages.length} console error/warning in a normal session: ${[...new Set(consoleMessages)].join(" | ")}`);
if (failedRequests.length > 0) failures.push(`${failedRequests.length} response >= 400 in a normal session: ${[...new Set(failedRequests)].join(" | ")}`);
if (failures.length === 0) {
	console.log("PASS — the session is clean.");
	process.exit(0);
}
for (const failure of failures) console.error(`FAIL: ${failure}`);
process.exit(1);
