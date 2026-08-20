/*
 * Checklist §15.3 — `/files.read` on a binary file and on a missing file.
 *
 * Two of the five readings are not honest:
 *
 *   blob.bin  — a 4 KiB binary blob renders as its raw base64 payload, with
 *               nothing saying the file is binary. It reads as the file's text.
 *   missing   — `/files.read nope-missing.txt` renders NOTHING: no card, no
 *               message, no toast (same silent-refusal class as §15.2/§15.7).
 *
 * The other three (plain text, README markdown, large file with its
 * "Truncated — the full file stays in the repository." footer) are fine.
 *
 * Exits non-zero while either half of the bug is present.
 */
import { open, runFlow, cards, transcript } from "./_lib.ts";

const REPO = "codeplanesmithers/canary-sandbox";
const { context, page } = await open();
const failures: Array<string> = [];

/* ---- binary ---- */
let before = await cards(page);
await runFlow(page, `/files.read blob.bin ${REPO}`);
await page.waitForTimeout(20_000);
const binaryCard = (await cards(page)).filter((card) => !before.includes(card)).join(" ");
await page.screenshot({ path: "/tmp/canary-repro-15.3-binary.png", fullPage: true });
console.log("binary card:", binaryCard.slice(0, 240));
const saysBinary = /binary|not text|can't be shown|cannot be shown|download/i.test(binaryCard);
if (!saysBinary) failures.push("blob.bin renders raw base64 and never says the file is binary");

/* ---- missing ---- */
before = await cards(page);
const beforeText = await transcript(page);
await runFlow(page, `/files.read nope-missing.txt ${REPO}`);
await page.waitForTimeout(20_000);
const newCards = (await cards(page)).filter((card) => !before.includes(card));
const newText = (await transcript(page)).slice(beforeText.length).trim();
await page.screenshot({ path: "/tmp/canary-repro-15.3-missing.png", fullPage: true });
console.log("missing new cards:", JSON.stringify(newCards));
console.log("missing appended text:", JSON.stringify(newText));
if (newCards.length === 0 && newText === "") {
	failures.push("/files.read on a missing file rendered nothing at all");
}

await context.close();
if (failures.length > 0) {
	for (const failure of failures) console.error(`FAIL 15.3: ${failure}`);
	process.exit(1);
}
console.log("PASS 15.3: every reading is honest.");
