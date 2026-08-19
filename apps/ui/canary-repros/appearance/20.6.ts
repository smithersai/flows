/*
 * Canary repro — MANUAL-REVIEW-CHECKLIST §20.6
 * "Contrast: run one accessibility audit per mode and confirm text and
 *  interactive controls meet contrast on the default theme."
 *
 * axe-core 4.13 (wcag2a + wcag2aa + wcag21a + wcag21aa) against the DEFAULT
 * palette (night-owl) in both modes, over the chat, the world editor and the
 * connectors pane. Dark mode fails `color-contrast` on `.smithers-card-meta`
 * (the per-card "<source> · <time>" byline): 3.75:1 where 4.5:1 is required.
 *
 * axe-core is resolved from the repo's own node_modules; set AXE_PATH to point
 * elsewhere.
 *
 * Run:  bun canary-repros/appearance/20.6.ts
 * Exits 1 while a contrast violation is present.
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.APPEARANCE_PROFILE ?? "/tmp/canary-appearance-profile";
const AXE = process.env.AXE_PATH ?? "/tmp/axe.min.js";
if (!existsSync(AXE)) {
	console.error(`axe-core not found at ${AXE}. Install it (bun add -d axe-core) and set AXE_PATH.`);
	process.exit(2);
}

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
	await page.waitForTimeout(1200);
};

// The DEFAULT palette, and a transcript with a card in it.
await run("/theme night-owl");
await run("/theme");
await page.waitForTimeout(800);

type Violation = { id: string; impact: string; help: string; nodes: Array<{ target: Array<string>; failureSummary: string }> };

const audit = async (surface: string): Promise<Array<Violation>> => {
	await page.addScriptTag({ path: AXE });
	const result = (await page.evaluate(
		async () =>
			await (globalThis as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: Array<Violation> }> } }).axe.run(
				document,
				{ resultTypes: ["violations"], runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } },
			),
	)) as { violations: Array<Violation> };
	const mode = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
	const palette = await page.evaluate(() => document.documentElement.getAttribute("data-palette"));
	console.log(`\n=== ${surface} | palette=${palette} mode=${mode} | ${result.violations.length} violation(s)`);
	for (const violation of result.violations) {
		console.log(`  - [${violation.impact}] ${violation.id}: ${violation.help} (${violation.nodes.length} node(s))`);
		for (const node of violation.nodes.slice(0, 6)) {
			console.log(`      ${node.target.join(" ")}`);
			console.log(`      ${(node.failureSummary ?? "").replace(/\n+/g, " | ").slice(0, 300)}`);
		}
	}
	return result.violations;
};

const found: Array<{ surface: string; violations: Array<Violation> }> = [];
for (const mode of ["as-loaded", "toggled"]) {
	found.push({ surface: `chat (${mode})`, violations: await audit(`chat (${mode})`) });
	await run("/world");
	await page.waitForTimeout(1500);
	found.push({ surface: `world (${mode})`, violations: await audit(`world (${mode})`) });
	await run("/connect");
	await page.waitForTimeout(1500);
	found.push({ surface: `connectors (${mode})`, violations: await audit(`connectors (${mode})`) });
	await run("/chat");
	await page.waitForTimeout(600);
	if (mode === "as-loaded") {
		await run("/dark-mode");
		await page.waitForTimeout(1000);
	}
}

const contrast = found.flatMap((entry) =>
	entry.violations.filter((violation) => violation.id === "color-contrast").map((violation) => ({ surface: entry.surface, violation })),
);
await page.screenshot({ path: "/tmp/appearance-shots/20.6-final.png" });
await context.close();

console.log("\n--- §20.6 ---");
console.log("expected: zero color-contrast violations on the default palette in both modes");
if (contrast.length === 0) {
	console.log("actual:   none found");
	console.log("pass §20.6");
} else {
	for (const entry of contrast) {
		console.log(`actual:   ${entry.surface} -> ${entry.violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
	}
	console.error("FAIL §20.6 — the default palette misses AA contrast");
	process.exit(1);
}
