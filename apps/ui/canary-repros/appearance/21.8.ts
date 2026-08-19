/*
 * Canary evidence — MANUAL-REVIEW-CHECKLIST §21.8
 * "Narrow the window to a phone width. Decide and record whether mobile is in
 *  scope for the alpha."
 *
 * This script does the measuring half. The scope decision is the product
 * owner's and is not recorded anywhere in the repo (searched
 * MANUAL-REVIEW-CHECKLIST.md, README.md, the ui styles), so this exits 1 to
 * flag that phone width is NOT clean today — whoever owns the decision needs
 * these numbers in front of them.
 *
 * Run:  bun canary-repros/appearance/21.8.ts
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.APPEARANCE_PROFILE ?? "/tmp/canary-appearance-profile";
/** iPhone 14/15 CSS viewport. */
const WIDTH = 390;
const HEIGHT = 844;

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: WIDTH, height: HEIGHT },
	isMobile: false,
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);

const report = await page.evaluate(() => {
	const root = document.documentElement;
	const controls = ([...document.querySelectorAll('button:not([disabled]),a[href],textarea,input,[tabindex]:not([tabindex="-1"])')] as Array<HTMLElement>).filter((element) => {
		const rect = element.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	});
	const wider = controls
		.filter((element) => element.getBoundingClientRect().width > root.clientWidth)
		.map((element) => ({ name: (element.getAttribute("aria-label") ?? element.innerText ?? "").trim().slice(0, 40), width: Math.round(element.getBoundingClientRect().width) }));
	const clipped = [...document.querySelectorAll("*")]
		.filter((element) => getComputedStyle(element).overflow === "hidden" && element.scrollWidth > element.clientWidth + 2)
		.slice(0, 10)
		.map((element) => ({ tag: element.tagName, cls: String((element as HTMLElement).className).slice(0, 34), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, text: ((element as HTMLElement).innerText ?? "").slice(0, 30).replace(/\n/g, " ") }));
	const small = controls
		.filter((element) => {
			const rect = element.getBoundingClientRect();
			return rect.width < 44 || rect.height < 44;
		})
		.map((element) => {
			const rect = element.getBoundingClientRect();
			return { name: (element.getAttribute("aria-label") ?? element.innerText ?? "").trim().slice(0, 30), size: `${Math.round(rect.width)}x${Math.round(rect.height)}` };
		});
	return {
		viewport: `${root.clientWidth}x${root.clientHeight}`,
		horizontalScroll: root.scrollWidth > root.clientWidth + 1,
		controls: controls.length,
		widerThanViewport: wider,
		clipped,
		belowTouchTarget: small,
		hasViewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null,
	};
});
console.log(JSON.stringify(report, null, 1));
await page.screenshot({ path: "/tmp/appearance-shots/21.8-phone-390x844.png", fullPage: false });
await context.close();

console.log("\n--- §21.8 ---");
console.log("measured at 390x844 (iPhone 14/15 CSS viewport)");
console.log(`  controls wider than the viewport: ${report.widerThanViewport.length}`);
console.log(`  boxes clipping their content:     ${report.clipped.length}`);
console.log(`  controls under a 44x44 target:    ${report.belowTouchTarget.length}`);
console.log("scope decision: NOT recorded anywhere in the repo — the product owner must state it.");
if (report.widerThanViewport.length > 0 || report.clipped.length > 0) {
	console.error("phone width is not clean today");
	process.exit(1);
}
console.log("phone width is clean");
