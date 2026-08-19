/*
 * Canary repro — MANUAL-REVIEW-CHECKLIST §21.7
 * "Zoom to 200% and confirm nothing is clipped or unreachable."
 *
 * At 200% zoom (a 1280x900 window gives 640x450 CSS px) the layout itself holds
 * up: no horizontal scrollbar, no control off-screen, no overflowing box, every
 * control still tab-reachable. What breaks is the corner chrome: `.corner-chrome`
 * is `position: absolute; z-index: 50` pinned to the top-right of the chat
 * COLUMN, and below ~900px the chat column is the full width, so transcript text
 * runs underneath the balance chip / reset / dark-mode buttons and is covered.
 *
 * Run:  bun canary-repros/appearance/21.7.ts
 * Exits 1 while transcript text is occluded at 200%.
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.APPEARANCE_PROFILE ?? "/tmp/canary-appearance-profile";

type Report = {
	viewport: string;
	docWidth: number;
	horizontalScroll: boolean;
	controls: number;
	offscreen: Array<{ name: string; x: number; width: number }>;
	overflowing: Array<{ tag: string; cls: string; scrollWidth: number; clientWidth: number; text: string }>;
	chrome: Array<number> | null;
	occluded: Array<{ tag: string; text: string; rect: Array<number> }>;
};

const measure = async (width: number, height: number, label: string): Promise<Report> => {
	const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width, height } });
	const page = context.pages()[0] ?? (await context.newPage());
	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(6000);
	const composer = page.locator("textarea").first();
	await composer.click();
	await composer.fill("/chat");
	await composer.press("Enter");
	await page.waitForTimeout(1500);
	const report = (await page.evaluate((viewport: string) => {
		const root = document.documentElement;
		const controls = [...document.querySelectorAll('button:not([disabled]),a[href],textarea,input,[tabindex]:not([tabindex="-1"])')] as Array<HTMLElement>;
		const visible = controls.filter((element) => {
			const rect = element.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		});
		const offscreen = visible
			.filter((element) => {
				const rect = element.getBoundingClientRect();
				return rect.right > root.clientWidth + 2 || rect.left < -2;
			})
			.map((element) => {
				const rect = element.getBoundingClientRect();
				return { name: (element.getAttribute("aria-label") ?? element.innerText ?? "").trim().slice(0, 34), x: Math.round(rect.x), width: Math.round(rect.width) };
			});
		const overflowing = [...document.querySelectorAll("*")]
			.filter((element) => getComputedStyle(element).overflow === "hidden" && element.scrollWidth > element.clientWidth + 2)
			.slice(0, 8)
			.map((element) => ({
				tag: element.tagName,
				cls: String((element as HTMLElement).className).slice(0, 34),
				scrollWidth: element.scrollWidth,
				clientWidth: element.clientWidth,
				text: ((element as HTMLElement).innerText ?? "").slice(0, 30).replace(/\n/g, " "),
			}));
		const chromeElement = document.querySelector(".corner-chrome") as HTMLElement | null;
		const occluded: Array<{ tag: string; text: string; rect: Array<number> }> = [];
		let chromeRect: Array<number> | null = null;
		if (chromeElement !== null) {
			const box = chromeElement.getBoundingClientRect();
			chromeRect = [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)];
			const walk = (node: Element): void => {
				for (const child of node.children) {
					if (chromeElement.contains(child)) continue;
					const element = child as HTMLElement;
					const rect = element.getBoundingClientRect();
					const ownText = [...element.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 2);
					if (ownText && rect.width > 0 && rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom) {
						occluded.push({ tag: element.tagName, text: element.innerText.slice(0, 54).replace(/\n/g, " "), rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] });
					}
					walk(child);
				}
			};
			walk(document.body);
		}
		return { viewport, docWidth: root.clientWidth, horizontalScroll: root.scrollWidth > root.clientWidth + 1, controls: visible.length, offscreen, overflowing, chrome: chromeRect, occluded: occluded.slice(0, 6) };
	}, label)) as Report;
	await page.screenshot({ path: `/tmp/appearance-shots/21.7-${label}.png` });
	await context.close();
	return report;
};

const baseline = await measure(1280, 900, "100pct-1280x900");
const zoomed = await measure(640, 450, "200pct-640x450");
for (const report of [baseline, zoomed]) {
	console.log(`\n=== ${report.viewport}`);
	console.log(`  horizontal scroll: ${report.horizontalScroll}`);
	console.log(`  visible controls:  ${report.controls}`);
	console.log(`  off-screen:        ${JSON.stringify(report.offscreen)}`);
	console.log(`  overflowing boxes: ${JSON.stringify(report.overflowing)}`);
	console.log(`  .corner-chrome:    ${JSON.stringify(report.chrome)}`);
	console.log(`  text under it:     ${JSON.stringify(report.occluded)}`);
}

console.log("\n--- §21.7 ---");
console.log("expected: at 200% zoom nothing is clipped and nothing is covered");
console.log(`actual:   layout holds (no h-scroll, ${zoomed.offscreen.length} off-screen control(s), ${zoomed.overflowing.length} overflowing box(es))`);
console.log(`          but ${zoomed.occluded.length} transcript element(s) sit under the absolutely positioned .corner-chrome`);
if (zoomed.occluded.length > 0 || zoomed.horizontalScroll || zoomed.offscreen.length > 0) {
	console.error("FAIL §21.7 — content is covered at 200% zoom");
	process.exit(1);
}
console.log("pass §21.7");
