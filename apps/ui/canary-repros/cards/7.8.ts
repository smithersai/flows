/*
 * Repro for MANUAL-REVIEW-CHECKLIST row 7.8 ("Long content inside a card
 * scrolls inside the card") on https://canary.smithers.sh.
 *
 * The `file` card renders its content in a <pre> with `overflow: visible` and
 * the card body carries `overflow-y: visible; max-height: none`. Long lines
 * therefore paint OUTSIDE the card's right border, across the page background,
 * and are clipped at the viewport edge with no scrollbar anywhere: the pixels
 * past the card are unreachable. The page body itself does not scroll
 * horizontally, so the second half of the row's assertion holds — but the
 * first half ("scrolls inside the card") does not.
 *
 * Fixtures used (created by this lane, both on codeplanesmithers/canary-sandbox
 * and imported into Smithers Cloud):
 *   big.txt   — 1200 wrapped-width lines, 162 KB
 *   blob.bin  — 4 KB of random bytes, served back as one base64 line
 *
 * With blob.bin the <pre> measures ~42600px wide inside a 686px box.
 *
 * Exits non-zero while the bug is present.
 *
 *   bun apps/ui/canary-repros/cards/7.8.ts
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

for (const flow of [`/files.read big.txt ${REPO}`, `/files.read blob.bin ${REPO}`]) {
	const composer = page.locator("textarea").first();
	await composer.click();
	await composer.fill("");
	await page.keyboard.type(flow, { delay: 8 });
	await page.keyboard.press("Enter");
	await page.waitForTimeout(9000);
}

const measured = await page.$$eval('[data-kind="file"]', (cards) =>
	cards.map((card) => {
		const body = card.querySelector(".smithers-card-body") as HTMLElement;
		const pre = card.querySelector("pre") as HTMLElement | null;
		const cardBox = card.getBoundingClientRect();
		const preBox = pre?.getBoundingClientRect();
		return {
			title: (card.querySelector(".smithers-card-title") as HTMLElement).innerText,
			cardHeight: Math.round(cardBox.height),
			cardRight: Math.round(cardBox.right),
			bodyOverflowY: getComputedStyle(body).overflowY,
			bodyMaxHeight: getComputedStyle(body).maxHeight,
			bodyScrollsInside: body.scrollHeight > body.clientHeight + 1,
			preOverflow: pre === null ? null : getComputedStyle(pre).overflow,
			preScrollWidth: pre?.scrollWidth ?? 0,
			preClientWidth: pre?.clientWidth ?? 0,
			/* How far the laid-out text runs past the card's own right border. */
			textPastCardRight: preBox === undefined ? 0 : Math.round(preBox.left + (pre?.scrollWidth ?? 0) - cardBox.right),
		};
	}),
);

for (const row of measured) console.log(JSON.stringify(row));

const documentScroll = await page.evaluate(() => ({
	scrollWidth: document.documentElement.scrollWidth,
	clientWidth: document.documentElement.clientWidth,
}));
console.log(`document: ${JSON.stringify(documentScroll)}`);

await page.screenshot({ path: "/tmp/canary-cards-7.8-overflow.png", fullPage: true });
await context.close();

const overflowing = measured.filter((row) => row.preScrollWidth > row.preClientWidth + 1 && row.preOverflow === "visible");
const noInnerScroll = measured.filter((row) => row.bodyMaxHeight === "none" && !row.bodyScrollsInside && row.cardHeight > 1200);

if (overflowing.length > 0 || noInnerScroll.length > 0) {
	console.error(
		`FAIL 7.8: ${overflowing.length} file card(s) overflow their box horizontally with overflow:visible and no scroller` +
			(noInnerScroll.length > 0
				? `; ${noInnerScroll.length} card(s) grow past 1200px instead of scrolling inside the card`
				: ""),
	);
	process.exit(1);
}
console.log("PASS 7.8: long card content scrolls inside the card.");
