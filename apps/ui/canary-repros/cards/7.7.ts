/*
 * Repro for MANUAL-REVIEW-CHECKLIST row 7.7 ("A card whose upstream call
 * failed says what failed and offers the next step") on
 * https://canary.smithers.sh.
 *
 * Two flows whose upstream read answers HTTP 404 produce NOTHING: no card, no
 * transcript line, no toast. The seams return an error string
 * (LandingsSeam.surfaceLanding's readErrorMessage, FilesSeam's equivalent) but
 * nothing renders it, so the app silently swallows the failure and the human
 * is left staring at an unchanged transcript.
 *
 *   /prs.view 99 codeplanesmithers/canary-sandbox
 *       -> GET /api/repos/codeplanesmithers/canary-sandbox/landings/99 -> 404
 *   /files.read does-not-exist.txt codeplanesmithers/canary-sandbox
 *       -> GET .../contents/does-not-exist.txt -> 404
 *
 * By contrast /repos.import codeplanesmithers/no-such-repo-canary-xyz does the
 * right thing (a FAILED card naming "github repository not found" plus a "Try
 * again" act), which is what the other two should do.
 *
 * Exits non-zero while the silent failures are present.
 *
 *   bun apps/ui/canary-repros/cards/7.7.ts
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.CARDS_PROFILE ?? "/tmp/canary-cards-profile";
const REPO = "codeplanesmithers/canary-sandbox";

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1280, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);

const run = async (flow: string): Promise<{ textDelta: string; cardDelta: number }> => {
	const beforeText = await page.locator("body").innerText();
	const beforeCards = await page.locator("[data-kind]").count();
	const composer = page.locator("textarea").first();
	await composer.click();
	await composer.fill("");
	await page.keyboard.type(flow, { delay: 8 });
	await page.keyboard.press("Enter");
	await page.waitForTimeout(9000);
	const afterText = await page.locator("body").innerText();
	const afterCards = await page.locator("[data-kind]").count();
	return { textDelta: afterText.replace(beforeText, "").trim(), cardDelta: afterCards - beforeCards };
};

const cases = [
	{ flow: `/prs.view 99 ${REPO}`, route: `GET /api/repos/${REPO}/landings/99` },
	{ flow: `/files.read does-not-exist.txt ${REPO}`, route: `GET /api/repos/${REPO}/contents/does-not-exist.txt` },
];

const silent: string[] = [];
for (const testCase of cases) {
	const upstream = await page.evaluate(async (path) => {
		const response = await fetch(path);
		return response.status;
	}, testCase.route.replace("GET ", ""));
	const result = await run(testCase.flow);
	console.log(
		`${testCase.flow}\n  upstream ${testCase.route} -> HTTP ${upstream}\n  new cards: ${result.cardDelta}, new transcript text: ${JSON.stringify(result.textDelta.slice(0, 160))}`,
	);
	if (result.cardDelta === 0 && result.textDelta === "") silent.push(testCase.flow);
}

await page.screenshot({ path: "/tmp/canary-cards-7.7-silent.png", fullPage: true });
await context.close();

if (silent.length > 0) {
	console.error(
		`FAIL 7.7: ${silent.length} flow(s) whose upstream answered 404 rendered no card and no message — ${silent.join(", ")}`,
	);
	process.exit(1);
}
console.log("PASS 7.7: every failed upstream call surfaced what failed.");
