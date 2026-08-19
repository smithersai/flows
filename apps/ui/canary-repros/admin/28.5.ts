/*
 * Repro — checklist row 28.5 ("No placeholder, lorem, TODO, or debug string is
 * visible anywhere") against https://canary.smithers.sh.
 *
 * No TODO, lorem, or placeholder text was found in a 193-line sweep of 15
 * surfaces. One debug string IS visible: when `/keys.list` fails, the product
 * renders the upstream's raw body verbatim — the literal string
 * "404 page not found" — in the toast under "/keys.list didn't run".
 *
 *   PROF=/tmp/canary-admin-profile bun 28.5.ts
 *   exit 1 while the bug is present, 0 once the raw body stops reaching the UI.
 */
import { open, run, body } from "./_lib";

const DEBUG_STRINGS = [
	"404 page not found",
	"500 Internal Server Error",
	"[object Object]",
	"undefined",
	"TODO",
	"FIXME",
	"lorem ipsum",
];

const { context, page } = await open();
const seen = new Set<string>();
const snapshot = async (): Promise<void> => {
	for (const line of (await body(page)).split("\n").map((l) => l.trim()).filter((l) => l !== "")) seen.add(line);
};
await snapshot();
for (const flow of ["/keys.list", "/world", "/connectors", "/notifications", "/help", "/repos.list", "/flows"]) {
	await run(page, flow, 6000);
	await snapshot();
}
const lines = [...seen];
console.log(`swept ${lines.length} distinct user-facing lines`);

const hits = lines.filter((line) => DEBUG_STRINGS.some((needle) => line.includes(needle)));
for (const hit of hits) console.log("  visible debug string:", JSON.stringify(hit.slice(0, 140)));
await page.screenshot({ path: "/tmp/canary-28.5.png", fullPage: true });
console.log("screenshot: /tmp/canary-28.5.png");
await context.close();

if (hits.length === 0) {
	console.log("PASS — no placeholder or debug string is visible.");
	process.exit(0);
}
console.error(`FAIL: ${hits.length} raw debug string is rendered to the user.`);
process.exit(1);
