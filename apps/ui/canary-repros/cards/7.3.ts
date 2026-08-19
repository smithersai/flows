/*
 * Repro for MANUAL-REVIEW-CHECKLIST row 7.3 (card status pills) on
 * https://canary.smithers.sh.
 *
 * The shared card header lays out title, status pill, meta and the
 * maximize button in one non-wrapping row. The title never shrinks, so at a
 * phone width the status pill — the most glanceable claim on the card — is
 * the element that loses its space. On a 390x844 viewport a `DONE` pill that
 * needs 64px is given 20px, which renders as a single clipped glyph.
 *
 * The script drives the real app at 390px, reads every rendered card, and
 * fails when any card's status badge is narrower than its own content.
 *
 *   bun apps/ui/canary-repros/cards/7.3.ts
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.CARDS_PROFILE ?? "/tmp/canary-cards-profile";

/* Cards with a repo-qualified title are the ones that lose the pill first. */
const FLOWS = [
	"/billing.balance",
	"/issues.list codeplanesmithers/canary-sandbox",
	"/branches.list codeplanesmithers/canary-sandbox",
	"/env.view codeplanesmithers/canary-sandbox",
];

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 390, height: 844 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);

for (const flow of FLOWS) {
	const composer = page.locator("textarea").first();
	await composer.click();
	await composer.fill("");
	await page.keyboard.type(flow, { delay: 8 });
	await page.keyboard.press("Enter");
	await page.waitForTimeout(6500);
}

const badges = await page.$$eval("[data-kind]", (cards) =>
	cards.map((card) => {
		const badge = card.querySelector(".sui-badge") as HTMLElement | null;
		if (badge === null) return null;
		return {
			kind: card.getAttribute("data-kind"),
			text: badge.innerText,
			needs: badge.scrollWidth,
			gets: badge.clientWidth,
		};
	}),
);

const rows = badges.filter((row): row is NonNullable<typeof row> => row !== null);
for (const row of rows) {
	console.log(`${row.kind}: pill "${row.text}" needs ${row.needs}px, gets ${row.gets}px`);
}
const truncated = rows.filter((row) => row.needs > row.gets + 1);

await page.screenshot({ path: "/tmp/canary-cards-7.3-narrow.png", fullPage: true });
await context.close();

if (truncated.length > 0) {
	console.error(
		`FAIL 7.3: ${truncated.length} card status pill(s) are clipped at 390px — ${truncated
			.map((row) => `${row.kind} "${row.text}" ${row.gets}/${row.needs}px`)
			.join(", ")}`,
	);
	process.exit(1);
}
console.log("PASS 7.3: every card status pill renders in full at 390px.");
