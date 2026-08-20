/*
 * Checklist §15.2 — `/files.list` on a path that does not exist.
 *
 * The platform answers honestly (404 `{"message":"content not found"}`), and
 * the app renders NOTHING: no card, no message, no toast. The turn is a silent
 * no-op, so the user cannot tell a missing path from a broken app.
 *
 * Exits non-zero while the bug is present.
 *
 *   cp -R ~/.multi-e2e-profile /tmp/canary-repo-data-profile
 *   bun apps/ui/canary-repros/repo-data/15.2.ts
 */
import { open, runFlow, cards, transcript } from "./_lib.ts";

const MISSING = "/files.list does/not/exist codeplanesmithers/canary-sandbox";

const { context, page } = await open();
const seen: Array<string> = [];
page.on("response", (response) => {
	const url = response.url();
	if (url.includes("/contents/")) seen.push(`${response.status()} ${url}`);
});

const beforeCards = await cards(page);
const beforeText = await transcript(page);
await runFlow(page, MISSING);
await page.waitForTimeout(20_000);
const afterCards = await cards(page);
const afterText = await transcript(page);
await page.screenshot({ path: "/tmp/canary-repro-15.2.png", fullPage: true });

const newCards = afterCards.filter((card) => !beforeCards.includes(card));
const newText = afterText.slice(beforeText.length).trim();
await context.close();

console.log("contents requests:", JSON.stringify(seen));
console.log("new cards:", JSON.stringify(newCards));
console.log("appended text:", JSON.stringify(newText));

if (newCards.length === 0 && newText === "") {
	console.error("FAIL 15.2: /files.list on a missing path rendered nothing at all.");
	process.exit(1);
}
console.log("PASS 15.2: the missing path was reported.");
