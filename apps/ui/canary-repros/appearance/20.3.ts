/*
 * Canary repro — MANUAL-REVIEW-CHECKLIST §20.3
 * "/dark-mode toggles, and every theme is legible in both modes. Look
 *  specifically at code blocks, diffs, status pills, and disabled controls."
 *
 * The toggle itself works and the four named categories are legible in all
 * 9 palettes x 2 modes. What is NOT legible is the connectors pane's row
 * subtitle: `.connect-store-text > span` is painted rgb(107, 100, 87) in EVERY
 * palette and in BOTH modes — a hardcoded colour that never repaints — so on
 * every dark background it lands near 2.7:1 where 4.5:1 is required.
 *
 * The measurement is taken from the real painted pixels as well as from
 * getComputedStyle, because a first read of a screenshot crop suggested the
 * text was light and it is not.
 *
 * Run:  bun canary-repros/appearance/20.3.ts
 * Exits 1 while the dark-mode subtitle is below 3:1.
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.APPEARANCE_PROFILE ?? "/tmp/canary-appearance-profile";
const PALETTES = ["night-owl", "paper", "fucory", "one", "github", "catppuccin", "solarized", "gruvbox", "rose-pine"] as const;
/** WCAG AA for normal-size text. Below 3:1 is not a judgement call. */
const HARD_FLOOR = 3;

const CONTRAST = `(() => {
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const effBg = (el) => { let n = el, acc = null;
    while (n) { const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { acc = acc ? over(acc, c) : c; if (acc.a >= 0.999) return acc; } n = n.parentElement; }
    return acc ?? { r: 255, g: 255, b: 255, a: 1 }; };
  window.__contrast = (el) => { const cs = getComputedStyle(el); const raw = parse(cs.color); if (!raw) return null;
    const bg = effBg(el); const fg = raw.a < 1 ? over(raw, bg) : raw; const l1 = lum(fg), l2 = lum(bg);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return { ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100, fg: cs.color,
      bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')', size: parseFloat(cs.fontSize) }; };
  return true; })()`;

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1280, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);

const run = async (command: string): Promise<void> => {
	const composer = page.locator("textarea").first();
	await composer.click();
	await composer.fill(command);
	await composer.press("Enter");
	await page.waitForTimeout(1100);
};
const mode = (): Promise<string | null> => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
const setMode = async (want: "dark" | "light"): Promise<void> => {
	if ((await mode()) !== want) {
		await run("/dark-mode");
		await page.waitForTimeout(900);
	}
};

/** Show the connectors pane, retrying: a slash dispatch occasionally lands while the surface is mid-swap. */
const openConnectors = async (): Promise<void> => {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		await run("/connect");
		await page.waitForTimeout(1500);
		if ((await page.locator(".connect-store-text").count()) > 0) return;
		await run("/chat");
		await page.waitForTimeout(800);
	}
	throw new Error("the connectors pane never rendered .connect-store-text");
};

// The toggle itself.
const before = await mode();
await run("/dark-mode");
await page.waitForTimeout(900);
const after = await mode();
console.log(`/dark-mode toggled ${String(before)} -> ${String(after)}`);
if (before === after) {
	console.error("FAIL §20.3 — /dark-mode did not toggle");
	await context.close();
	process.exit(1);
}

await openConnectors();

const rows: Array<{ palette: string; mode: string; ratio: number; fg: string; bg: string; text: string }> = [];
for (const palette of PALETTES) {
	await run(`/theme ${palette}`);
	await page.waitForTimeout(500);
	for (const want of ["dark", "light"] as const) {
		await setMode(want);
		if ((await page.locator(".connect-store-text").count()) === 0) await openConnectors();
		await page.waitForTimeout(400);
		await page.evaluate(CONTRAST);
		const measured = await page.evaluate(() => {
			const contrast = (globalThis as unknown as { __contrast: (el: Element) => { ratio: number; fg: string; bg: string } }).__contrast;
			const span = document.querySelector(".connect-store-text > span");
			if (span === null) return null;
			return { ...contrast(span), text: (span as HTMLElement).innerText.slice(0, 40) };
		});
		if (measured === null) continue;
		const themeNow = (await mode()) ?? "?";
		rows.push({ palette, mode: themeNow, ...measured });
		console.log(`  ${palette.padEnd(11)} ${themeNow.padEnd(5)} ratio=${String(measured.ratio).padEnd(6)} fg=${measured.fg} bg=${measured.bg}`);
	}
}

// The real painted pixels, so the claim does not rest on computed style alone.
await run("/theme night-owl");
await setMode("dark");
if ((await page.locator(".connect-store-text").count()) === 0) await openConnectors();
await page.waitForTimeout(600);
const box = await page.locator(".connect-store-text > span").first().boundingBox();
let painted = "(no box)";
if (box !== null) {
	const shot = await page.screenshot({ clip: { x: box.x, y: box.y, width: Math.min(box.width, 340), height: box.height } });
	painted = await page.evaluate(async (data: string) => {
		const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
		const canvas = document.createElement("canvas");
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const context2d = canvas.getContext("2d");
		if (context2d === null) return "(no 2d context)";
		context2d.drawImage(bitmap, 0, 0);
		const pixels = context2d.getImageData(0, 0, canvas.width, canvas.height).data;
		const counts = new Map<string, number>();
		for (let index = 0; index < pixels.length; index += 4) {
			const key = `${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([key, value]) => `rgb(${key}) x${value}`).join(" | ");
	}, shot.toString("base64"));
}
await page.screenshot({ path: "/tmp/appearance-shots/20.3-connectors-dark.png" });
await context.close();

const bad = rows.filter((row) => row.mode === "dark" && row.ratio < HARD_FLOOR);
console.log("\n--- §20.3 ---");
console.log(`painted pixels under the subtitle (night-owl dark): ${painted}`);
console.log("expected: the connectors row subtitle is legible in both modes of every palette");
console.log(`actual:   it is a fixed ${rows[0]?.fg ?? "?"} in all ${rows.length} palette/mode combinations; ${bad.length} dark combinations fall below ${HARD_FLOOR}:1`);
if (bad.length > 0) {
	console.error(`FAIL §20.3 — ${bad.map((row) => `${row.palette}:${row.ratio}`).join(", ")}`);
	process.exit(1);
}
console.log("pass §20.3");
