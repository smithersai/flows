/*
 * Repro for MANUAL-REVIEW-CHECKLIST row 8.27 (`file` — a text file, a large
 * file, a binary file, a missing file) on https://canary.smithers.sh.
 *
 * Two of the four sub-cases fail:
 *
 *  - BINARY. `/files.read blob.bin <repo>` renders the raw base64 payload as
 *    if it were source text: one ~42600px-wide line of A-Za-z0-9+/ inside a
 *    686px box. Nothing says the file is binary and nothing offers a download.
 *  - MISSING. `/files.read does-not-exist.txt <repo>` produces no card and no
 *    transcript line at all. The contents route answers 404 and the app
 *    swallows it (the same silent path as row 7.7).
 *
 * The text and large-file sub-cases pass: README.md renders, and big.txt is
 * cut at 122 lines with "Truncated — the full file stays in the repository."
 *
 * Fixtures created by this lane on codeplanesmithers/canary-sandbox and
 * imported into Smithers Cloud: big.txt (162 KB) and blob.bin (4 KB random).
 *
 * Exits non-zero while either sub-case fails.
 *
 *   bun apps/ui/canary-repros/cards/8.27.ts
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

/*
 * A file card's id is derived from repo+path, so a re-run upserts the same
 * card instead of adding one. Presence is therefore checked by title, not by
 * a count delta.
 */
const run = async (flow: string, path: string): Promise<{ card: boolean; textDelta: string }> => {
	const beforeText = await page.locator("body").innerText();
	const composer = page.locator("textarea").first();
	await composer.click();
	await composer.fill("");
	await page.keyboard.type(flow, { delay: 8 });
	await page.keyboard.press("Enter");
	await page.waitForTimeout(9000);
	const titles = await page.$$eval('[data-kind="file"] .smithers-card-title', (nodes) =>
		nodes.map((node) => (node as HTMLElement).innerText),
	);
	return {
		card: titles.some((title) => title.endsWith(`· ${path}`)),
		textDelta: (await page.locator("body").innerText()).replace(beforeText, "").trim(),
	};
};

const failures: string[] = [];

const text = await run(`/files.read README.md ${REPO}`, "README.md");
console.log(`README.md: card present: ${text.card}`);
if (!text.card) failures.push("text file rendered no card");

const large = await run(`/files.read big.txt ${REPO}`, "big.txt");
const largeCard = await page.locator('[data-kind="file"]').last().innerText();
console.log(`big.txt: card present: ${large.card}, truncation notice: ${largeCard.includes("Truncated")}`);
if (!large.card) failures.push("large file rendered no card");

const binary = await run(`/files.read blob.bin ${REPO}`, "blob.bin");
const binaryCard = page.locator('[data-kind="file"]').last();
const binaryText = await binaryCard.innerText();
const binaryWidth = await binaryCard.evaluate((card) => {
	const pre = card.querySelector("pre") as HTMLElement | null;
	return { scrollWidth: pre?.scrollWidth ?? 0, clientWidth: pre?.clientWidth ?? 0 };
});
const saysBinary = /binary|can't be shown|cannot be shown|download/i.test(binaryText);
console.log(
	`blob.bin: card present: ${binary.card}, names it binary: ${saysBinary}, pre ${binaryWidth.scrollWidth}px inside ${binaryWidth.clientWidth}px`,
);
if (!saysBinary) failures.push("binary file rendered as raw base64 text with no binary notice");

const missing = await run(`/files.read does-not-exist.txt ${REPO}`, "does-not-exist.txt");
console.log(`missing file: card present: ${missing.card}, transcript said ${JSON.stringify(missing.textDelta.slice(0, 120))}`);
if (!missing.card && missing.textDelta === "") failures.push("missing file produced no card and no message");

await page.screenshot({ path: "/tmp/canary-cards-8.27-file.png", fullPage: true });
await context.close();

if (failures.length > 0) {
	console.error(`FAIL 8.27: ${failures.join("; ")}`);
	process.exit(1);
}
console.log("PASS 8.27: every file sub-case is handled.");
