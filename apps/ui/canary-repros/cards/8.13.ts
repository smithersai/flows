/*
 * Repro for MANUAL-REVIEW-CHECKLIST row 8.13 (`browser` card) on
 * https://canary.smithers.sh.
 *
 * The app origin answers with `cross-origin-embedder-policy: require-corp`.
 * Under COEP require-corp Chrome blocks every cross-origin frame whose
 * response carries no `cross-origin-resource-policy` header, so the browser
 * card's <iframe> navigates to chrome-error://chromewebdata/ and the card
 * renders an empty white box. BrowserCardBody's contract ("a next step, never
 * a silent blank") is not met: no message, no "Open in a new tab" link.
 *
 * The script proves the cause as well as the symptom: the same flow is run
 * twice, once against the live headers and once with COEP stripped by a route
 * interceptor. Stripped, the frame loads example.com.
 *
 * Exits non-zero while the bug is present.
 *
 *   bun apps/ui/canary-repros/cards/8.13.ts
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.CARDS_PROFILE ?? "/tmp/canary-cards-profile";

const runBrowserFlow = async (stripCoep: boolean): Promise<{ frames: string[]; frameText: string }> => {
	const context = await chromium.launchPersistentContext(PROFILE, {
		headless: true,
		viewport: { width: 1280, height: 900 },
	});
	const page = context.pages()[0] ?? (await context.newPage());
	if (stripCoep) {
		await page.route(`${BASE}/**`, async (route) => {
			const response = await route.fetch();
			const headers = { ...response.headers() };
			delete headers["cross-origin-embedder-policy"];
			await route.fulfill({ response, headers });
		});
	}
	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(4000);
	const composer = page.locator("textarea").first();
	await composer.click();
	await page.keyboard.type("/browser https://example.com", { delay: 8 });
	await page.keyboard.press("Enter");
	await page.waitForTimeout(9000);
	const frames = page.frames().map((frame) => frame.url());
	let frameText = "";
	for (const frame of page.frames()) {
		if (frame === page.mainFrame()) continue;
		frameText = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
	}
	await context.close();
	return { frames, frameText };
};

const headers = await fetch(BASE).then((response) => response.headers);
const coep = headers.get("cross-origin-embedder-policy");
console.log(`app origin cross-origin-embedder-policy: ${coep ?? "(absent)"}`);

const live = await runBrowserFlow(false);
console.log(`live frames: ${JSON.stringify(live.frames)}`);
console.log(`live frame text: ${JSON.stringify(live.frameText.slice(0, 120))}`);

const stripped = await runBrowserFlow(true);
console.log(`COEP-stripped frames: ${JSON.stringify(stripped.frames)}`);
console.log(`COEP-stripped frame text: ${JSON.stringify(stripped.frameText.slice(0, 120))}`);

const liveBroken = live.frames.some((url) => url.startsWith("chrome-error://"));
const strippedWorks = stripped.frames.some((url) => url.startsWith("https://example.com"));

if (liveBroken && strippedWorks) {
	console.error(
		"FAIL 8.13: the browser card frame is blocked by the app origin's COEP require-corp and renders a silent blank; with COEP stripped the same frame loads.",
	);
	process.exit(1);
}
if (liveBroken) {
	console.error("FAIL 8.13: the browser card frame failed to load (chrome-error) and the card shows no message.");
	process.exit(1);
}
console.log("PASS 8.13: the browser card frame loaded the page.");
