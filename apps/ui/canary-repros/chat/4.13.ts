/*
 * Row 4.13 — a transcript of a few long turns wedges the turn seam at HTTP 413,
 * and `/clear` cannot recover it because `/clear` needs a turn of its own.
 *
 * The count of messages is not the problem: 61 short messages scroll smoothly
 * and the composer stays responsive (23ms to fill, 6ms for ten scroll jumps).
 * The PAYLOAD is. The client re-sends the whole transcript on every turn, so a
 * handful of long answers pushes the request past the upstream's body limit and
 * every later turn — including the one `/clear` runs to decide what to keep —
 * comes back 413. The only escape is clearing browser storage, which a user
 * cannot do from inside the app.
 *
 * Runs ~6 long turns, so give it a few minutes. Exits 1 once the seam wedges.
 */
import { composer, launch, resetStore, send, settle } from "./_harness";

const harness = await launch();
const { ctx, page } = harness;
await resetStore(harness);

const text = () => page.locator("body").innerText();
const wedged = async () => /HTTP 413|Request body is too large/i.test((await text()).slice(-900));

const TOPICS = ["the printing press", "cartography", "lighthouses", "glassmaking", "paper", "tea", "coffee", "bridges"];
let wedgedAt = -1;
for (const [index, topic] of TOPICS.entries()) {
	await send(page, `Write a 1500 word essay about the history of ${topic}.`);
	await settle(page, 90_000);
	const messages = await page.locator("[data-role]").count();
	const bytes = (await text()).length;
	console.log(`turn ${index + 1} (${topic}): ${messages} messages, ${bytes} rendered chars`);
	if (await wedged()) {
		wedgedAt = index + 1;
		console.log(`\nWEDGED after ${wedgedAt} long turns:\n  ${(await text()).slice(-320).replace(/\n+/g, " | ")}`);
		break;
	}
}

if (wedgedAt === -1) {
	console.log("\nnot wedged within 8 long turns — the seam accepted the whole transcript");
	await ctx.close();
	process.exit(0);
}

// A trivial prompt is now impossible.
await send(page, "say ok");
await settle(page, 40_000);
console.log(`\ntrivial prompt after the wedge:\n  ${(await text()).slice(-300).replace(/\n+/g, " | ")}`);
const trivialWedged = await wedged();

// And so is the documented escape hatch.
await send(page, "/clear");
await settle(page, 40_000);
const afterClear = (await text()).slice(-400).replace(/\n+/g, " | ");
console.log(`\n/clear after the wedge:\n  ${afterClear}`);
const messagesLeft = await page.locator("[data-role]").count();
const clearFailed = /couldn.t finish reviewing|didn.t run|couldn.t complete/i.test(afterClear) || messagesLeft > 4;

// The scroll/composer half of row 4.13, measured on the same transcript.
const box = composer(page);
const filledAt = Date.now();
await box.click();
await box.fill("responsiveness probe");
const fillMs = Date.now() - filledAt;
const scrolledAt = Date.now();
for (let i = 0; i < 10; i += 1) {
	await page.evaluate(() => {
		const viewport = document.querySelector(".sui-msg-scroller-viewport") as HTMLElement;
		viewport.scrollTop = viewport.scrollHeight * 0.37;
	});
}
console.log(`\ncomposer fill ${fillMs}ms, ten scroll jumps ${Date.now() - scrolledAt}ms, ${messagesLeft} messages left`);

await page.screenshot({ path: "/tmp/canary-chat-4.13.png", fullPage: true });
console.log("screenshot: /tmp/canary-chat-4.13.png");

console.log(`\nwedged after ${wedgedAt} long turns: true`);
console.log(`a trivial prompt still fails: ${trivialWedged}`);
console.log(`/clear cannot recover it: ${clearFailed}`);
const bug = trivialWedged || clearFailed;
console.log(bug ? "\nFAIL: the conversation is unusable and has no in-app escape" : "\nOK");
await ctx.close();
process.exit(bug ? 1 : 0);
