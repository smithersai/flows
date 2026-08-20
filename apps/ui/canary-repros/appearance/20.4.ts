/*
 * Canary repro — MANUAL-REVIEW-CHECKLIST §20.4
 * "The theme choice survives a reload and applies before first paint (no flash
 *  of the wrong theme)."
 *
 * The choice DOES survive. It does NOT apply before first paint: the served
 * index.html carries no inline theme bootstrap, and the persisted choice lives
 * in OPFS/wa-sqlite (async), so the document paints the built-in light default
 * (#fbfbfb) first and only stamps data-theme/data-palette ~150-250ms later.
 * With a dark theme persisted, that is a full-viewport white flash on every
 * load.
 *
 * Run:  bun canary-repros/appearance/20.4.ts
 * Exits 1 while the flash is present.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.APPEARANCE_PROFILE ?? "/tmp/canary-appearance-profile";
const SHOTS = "/tmp/appearance-shots";
mkdirSync(SHOTS, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1280, height: 900 },
	colorScheme: "light", // the OS says light; the persisted choice says dark
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);

/** Drive a slash command through the real composer. */
const run = async (command: string): Promise<void> => {
	const composer = page.locator("textarea").first();
	await composer.click();
	await composer.fill(command);
	await composer.press("Enter");
	await page.waitForTimeout(1200);
};

await run("/theme night-owl");
if ((await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) !== "dark") {
	await run("/dark-mode");
}
const persisted = await page.evaluate(() => ({
	palette: document.documentElement.getAttribute("data-palette"),
	theme: document.documentElement.getAttribute("data-theme"),
	bg: getComputedStyle(document.body).backgroundColor,
}));
console.log(`persisted choice: ${JSON.stringify(persisted)}`);
if (persisted.theme !== "dark") {
	console.error("setup failed: could not persist a dark theme");
	await context.close();
	process.exit(2);
}

// Record the document's theme attributes at every frame of the NEXT load.
await context.addInitScript(() => {
	(globalThis as unknown as { __frames: Array<unknown> }).__frames = [];
	const record = (tag: string): void => {
		try {
			(globalThis as unknown as { __frames: Array<unknown> }).__frames.push({
				t: Math.round(performance.now() * 10) / 10,
				tag,
				palette: document.documentElement.getAttribute("data-palette"),
				theme: document.documentElement.getAttribute("data-theme"),
				bg: document.body === null ? null : getComputedStyle(document.body).backgroundColor,
			});
		} catch {
			// the document is mid-teardown; the next frame records instead
		}
	};
	record("init");
	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) record(`paint:${entry.name}`);
		}).observe({ type: "paint", buffered: true });
	} catch {
		// no paint timing here; the rAF samples still bracket first paint
	}
	const loop = (): void => {
		record("raf");
		if ((globalThis as unknown as { __frames: Array<unknown> }).__frames.length < 200) requestAnimationFrame(loop);
	};
	requestAnimationFrame(loop);
});

// A real screencast, so the flash is a picture and not only an attribute read.
const cdp = await context.newCDPSession(page);
const shots: Array<{ ms: number; data: string }> = [];
const started = Date.now();
cdp.on("Page.screencastFrame", async (frame: { data: string; sessionId: number }) => {
	shots.push({ ms: Date.now() - started, data: frame.data });
	await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
// Do NOT await the reload: waiting for domcontentloaded already outlasts the
// flash, and the frames that matter are the ones painted before it.
const reloading = page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
await cdp.send("Page.stopScreencast").catch(() => {});
await reloading;

type Frame = { t: number; tag: string; palette: string | null; theme: string | null; bg: string | null };
const frames = (await page.evaluate(() => (globalThis as unknown as { __frames: Array<Frame> }).__frames ?? [])) as Array<Frame>;
const firstPaint = frames.find((frame) => frame.tag === "paint:first-paint");
const firstThemed = frames.find((frame) => frame.theme !== null);

console.log("\nframes around first paint:");
let previous = "";
for (const frame of frames) {
	const key = `${frame.palette}|${frame.theme}|${frame.bg}`;
	if (key !== previous || frame.tag.startsWith("paint")) {
		console.log(`  ${JSON.stringify(frame)}`);
		previous = key;
	}
}

// Keep a strip of the frames the browser actually painted over the flash
// window, so the claim is a picture and not only an attribute read.
const strip = shots.filter((shot) => shot.ms <= 900).slice(0, 12);
strip.forEach((shot, index) => {
	writeFileSync(`${SHOTS}/20.4-frame-${String(index).padStart(2, "0")}-${shot.ms}ms.png`, Buffer.from(shot.data, "base64"));
});
console.log(`\n${strip.length} screencast frames over the first 900ms -> ${SHOTS}/20.4-frame-*.png`);
await page.screenshot({ path: `${SHOTS}/20.4-settled.png` });

const flashed =
	firstPaint !== undefined &&
	(firstPaint.theme === null || firstPaint.theme !== persisted.theme || firstPaint.bg !== persisted.bg);
const delay = firstThemed !== undefined && firstPaint !== undefined ? firstThemed.t - firstPaint.t : Number.NaN;

console.log("\n--- §20.4 ---");
console.log(`expected: at first-paint the document already carries data-theme=${persisted.theme} and body ${persisted.bg}`);
console.log(`actual:   at first-paint data-theme=${String(firstPaint?.theme)} and body ${String(firstPaint?.bg)}`);
console.log(`the persisted theme lands ${Math.round(delay)}ms after first paint`);

await context.close();
if (flashed) {
	console.error("FAIL §20.4 — the wrong theme is painted first");
	process.exit(1);
}
console.log("pass §20.4");
