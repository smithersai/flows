/*
 * Repro — checklist row 24.3 (honesty lane, §24).
 *
 * "A 429 from the model provider surfaces as a rate-limit message, not a
 *  generic failure."
 *
 * The UI does not classify HTTP status at all on the turn seam. It writes
 * "I couldn't complete that turn. Smithers web agent failed (HTTP 429): " and
 * then concatenates the upstream's raw body. When the 429 comes from our own
 * turn limiter (`apps/server/src/turnLimit.ts`) the body carries a prose
 * `message` and the result reads fine. When it comes from the model provider,
 * the user is shown a raw JSON blob. There is no `429` branch anywhere in
 * apps/ui/src/mainview — grep it.
 *
 *   bun canary-repros/honesty/24.3.ts
 *
 * Exits 1 while a provider 429 is not rendered as a rate-limit message.
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.PROF ?? "/tmp/canary-honesty-profile";

/* What an Anthropic/OpenAI-shaped 429 actually looks like on the wire. */
const PROVIDER_429 = JSON.stringify({
	type: "error",
	error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" },
});

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1400, height: 1100 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.route("**/api/agent/turn**", (route) =>
	route.fulfill({ status: 429, contentType: "application/json", body: PROVIDER_429 }),
);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const before = await page.locator("body").innerText();
const composer = page.locator("textarea.sui-chat-composer-input");
await composer.click();
await composer.fill("Say hi.");
await composer.press("Enter");
await page.waitForTimeout(25_000);
const after = await page.locator("body").innerText();
const added = after
	.split("\n")
	.filter((line) => line.trim() !== "" && !before.includes(line.trim()));
await page.screenshot({ path: "/tmp/honesty-repro-24.3.png", fullPage: true });
await context.close();

const shown = added.join(" ");
console.log("--- what the user was shown ---");
console.log(added.join("\n"));
console.log("--- screenshot: /tmp/honesty-repro-24.3.png");

/* The bug: the provider's raw JSON is pasted into the chat. */
const rawJson = /\{"type":"error"|"rate_limit_error"|\{"error":/.test(shown);
const ratePhrase = /rate limit|rate-limit|too many|slow down|try again in/i.test(
	shown.replace(/\{[\s\S]*\}/g, ""),
);

if (rawJson) {
	console.error(
		"FAIL: the provider's raw 429 JSON body was pasted into the transcript verbatim instead of a rate-limit message.",
	);
	process.exit(1);
}
if (!ratePhrase) {
	console.error("FAIL: the 429 did not surface as a rate-limit message.");
	process.exit(1);
}
console.log("PASS — the 429 reads as a rate limit.");
process.exit(0);
