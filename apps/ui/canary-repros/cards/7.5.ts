/*
 * Repro for MANUAL-REVIEW-CHECKLIST row 7.5 ("Cards interleave with messages
 * in the right order (ordinal and createdAt both)") on
 * https://canary.smithers.sh.
 *
 * A card created BEFORE a later chat message renders AFTER it, and stays wrong
 * across a reload.
 *
 * Root cause: the two transcript entry kinds number themselves on different
 * counters. A card takes `nextTranscriptOrdinal()`, the max over messages AND
 * cards (apps/ui/src/mainview/state/AppController.ts:864). A message takes
 * `nextOrdinal(collections.messages)`, the max over MESSAGES ONLY
 * (apps/ui/src/mainview/state/AppStore.ts:460 and the sibling dispatches). The
 * merged transcript then sorts on `ordinal` alone (AppStore.ts:405), so every
 * message posted after a card is numbered as if the card did not exist and
 * jumps above it.
 *
 * Observed sequence with an opening digest message (ordinal 0) already present:
 *   /billing.balance   -> balance card, ordinal 2   [digest, reco, balance]
 *   a chat message     -> user message, ordinal 1   [digest, reco, MESSAGE, balance, reply]
 *
 * Exits non-zero while the reordering happens.
 *
 *   bun apps/ui/canary-repros/cards/7.5.ts
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.CARDS_PROFILE ?? "/tmp/canary-cards-profile";

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1280, height: 950 },
});
const page = context.pages()[0] ?? (await context.newPage());

/*
 * An earlier run's transcript is persisted in OPFS and would make the indices
 * below meaningless, so the slate is cleared at the browser level first (the
 * page holds sync access handles on the sqlite file, so an in-page delete
 * silently fails — see apps/ui/scripts/live-store-reset.ts). Cookies stay, so
 * the session survives.
 */
await page.goto("about:blank", { waitUntil: "domcontentloaded" });
const cdp = await context.newCDPSession(page);
await cdp.send("Storage.clearDataForOrigin", {
	origin: new URL(BASE).origin,
	storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers",
});
await cdp.detach().catch(() => {});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);

const send = async (text: string, settleMs: number): Promise<void> => {
	const composer = page.locator("textarea").first();
	await composer.click();
	await composer.fill("");
	await page.keyboard.type(text, { delay: 8 });
	await page.keyboard.press("Enter");
	await page.waitForTimeout(settleMs);
};

const order = async (): Promise<string[]> =>
	page.evaluate(() => {
		const root = document.querySelector(".sui-chat-messages") ?? document.body;
		return Array.from(root.children).map((entry) => {
			const card = entry.matches("[data-kind]") ? entry : entry.querySelector("[data-kind]");
			if (card !== null) return `card:${card.getAttribute("data-kind")}`;
			return `msg:${(entry as HTMLElement).innerText.trim().slice(0, 32).replace(/\s+/g, " ")}`;
		});
	});

await send("/billing.balance", 7000);
const beforeMessage = await order();
console.log(`after /billing.balance: ${JSON.stringify(beforeMessage)}`);

await send("reply with the word ping", 40000);
const afterMessage = await order();
console.log(`after the chat turn:    ${JSON.stringify(afterMessage)}`);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
const afterReload = await order();
console.log(`after reload:           ${JSON.stringify(afterReload)}`);

await page.screenshot({ path: "/tmp/canary-cards-7.5-order.png", fullPage: true });
await context.close();

const balanceIndex = afterMessage.indexOf("card:balance");
const userMessageIndex = afterMessage.map((entry, index) => ({ entry, index }))
	.filter(({ entry }) => entry.startsWith("msg:reply with the word ping"))
	.map(({ index }) => index)
	.at(-1) ?? -1;

if (balanceIndex === -1 || userMessageIndex === -1) {
	console.error("FAIL 7.5: could not find both the balance card and the user message in the transcript.");
	process.exit(1);
}
if (userMessageIndex < balanceIndex) {
	console.error(
		`FAIL 7.5: the balance card was created first but renders at index ${balanceIndex}, below the later user message at index ${userMessageIndex}; messages number themselves over messages only.`,
	);
	process.exit(1);
}
console.log("PASS 7.5: cards and messages keep their creation order.");
