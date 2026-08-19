/*
 * Repro — checklist row 22.6 (honesty lane, §22).
 *
 * "Each refusal names the next step, and the next step actually works."
 *
 * The five impossible asks all refuse honestly and all name a next step, but
 * two of the named next steps do not work on the canary:
 *
 *   A. §F-4 push / §F-5 PR both offer "I can start a workflow that proposes
 *      the change". /flow.create renders the repository chooser, the chooser
 *      accepts a repository, and then the run never appears: the toast
 *      "Preparing your <repo> workspace…" stands forever because
 *      POST /api/workflow/provision never answers (>120s, no timeout, no
 *      error, no card).
 *
 *   B. The branches card the §F-5 turn renders prints the next step
 *      "Open a pull request with /prs.create <title> from:<branch>". Typing
 *      exactly that clears the composer and does NOTHING — no transcript line,
 *      no card, no toast, no console error. With an explicit owner/repo it
 *      fires GET /api/repos/{o}/{r}/bookmarks and /changes and still says
 *      nothing.
 *
 *   bun canary-repros/honesty/22.6.ts
 *
 * Exits 1 while either next step is broken.
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.PROF ?? "/tmp/canary-honesty-profile";
const failures: Array<string> = [];

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1400, height: 1100 },
});
const page = context.pages()[0] ?? (await context.newPage());
const consoleErrors: Array<string> = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const composer = page.locator("textarea.sui-chat-composer-input");

/* ---- B: the next step the branches card itself prints ------------------- */
const beforePr = await page.locator("body").innerText();
const PR = "/prs.create honesty 22.6 next-step check from:codeplanesmithers-patch-1 codeplanesmithers/canary-sandbox";
await composer.click();
await composer.fill(PR);
await composer.press("Enter");
await page.waitForTimeout(25_000);
const afterPr = await page.locator("body").innerText();
const prAdded = afterPr
	.split("\n")
	.filter((line) => line.trim() !== "" && !beforePr.includes(line.trim()));
console.log("B. /prs.create added lines:", JSON.stringify(prAdded));
if (prAdded.length === 0) {
	failures.push(
		"the branches card's own next step (/prs.create <title> from:<branch>) is a silent no-op — no message, no card, no error",
	);
}

/* ---- A: the next step the push/PR refusals offer ------------------------ */
const beforeFlow = await page.locator("body").innerText();
await composer.click();
await composer.fill("/flow.create Propose the change for review");
await composer.press("Enter");
await page.waitForTimeout(9000);
const chooser = page.locator('[data-flow="flow.repo.choose"]');
const options = await chooser.count();
console.log("A. repository chooser options:", options);
if (options === 0) {
	failures.push("/flow.create never rendered the repository chooser");
} else {
	await chooser.last().click();
	await page.waitForTimeout(75_000);
	const afterFlow = await page.locator("body").innerText();
	const flowAdded = afterFlow
		.split("\n")
		.filter((line) => line.trim() !== "" && !beforeFlow.includes(line.trim()));
	console.log("A. after choosing a repository (75s):", JSON.stringify(flowAdded.slice(-6)));
	const stillPreparing = afterFlow.includes("Preparing your") && !/\brun\b/i.test(flowAdded.join(" "));
	if (stillPreparing) {
		failures.push(
			"the workflow next step never lands: 'Preparing your <repo> workspace…' stands 75s+ with no run card, no timeout and no error (POST /api/workflow/provision does not answer)",
		);
	}
}

await page.screenshot({ path: "/tmp/honesty-repro-22.6.png", fullPage: true });
console.log("--- screenshot: /tmp/honesty-repro-22.6.png");
console.log("console errors:", JSON.stringify(consoleErrors.slice(0, 6)));
await context.close();

if (failures.length === 0) {
	console.log("PASS — every named next step works.");
	process.exit(0);
}
for (const failure of failures) console.error(`FAIL: ${failure}`);
process.exit(1);
