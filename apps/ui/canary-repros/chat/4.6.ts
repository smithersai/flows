/*
 * Row 4.6 — `/retry` re-posts the user message instead of re-running the turn
 * in place.
 *
 * After one `/retry` the transcript holds TWO identical `[data-role="user"]`
 * bubbles for a prompt the user typed once; each further `/retry` adds another.
 *
 * Exits 1 while the duplicate is present.
 */
import { launch, resetStore, send, settle } from "./_harness";

const PROMPT = "Reply with one random uncommon English noun, nothing else.";

const harness = await launch();
const { ctx, page } = harness;
await resetStore(harness);

const userBubbles = () =>
	page.evaluate(
		(prompt) =>
			Array.from(document.querySelectorAll('[data-role="user"]')).filter((element) =>
				(element as HTMLElement).innerText.includes(prompt),
			).length,
		PROMPT,
	);

await send(page, PROMPT);
await settle(page, 45_000);
const before = await userBubbles();
console.log("user bubbles carrying the prompt, before /retry:", before);

await send(page, "/retry");
await settle(page, 45_000);
const after = await userBubbles();
console.log("user bubbles carrying the prompt, after  /retry:", after);

const transcript = await page.evaluate(() =>
	Array.from(document.querySelectorAll("[data-role]"))
		.slice(-6)
		.map((element) => `${element.getAttribute("data-role")}: ${(element as HTMLElement).innerText.slice(0, 60).replace(/\n/g, " ")}`),
);
console.log("\ntranscript tail:");
for (const line of transcript) console.log("   ", line);

await page.screenshot({ path: "/tmp/canary-chat-4.6.png", fullPage: true });
console.log("screenshot: /tmp/canary-chat-4.6.png");

if (before === 0) {
	console.error("\nINCONCLUSIVE: the first turn never posted a user bubble.");
	await ctx.close();
	process.exit(2);
}
const bug = after > before;
console.log(bug ? `\nFAIL: /retry duplicated the user message (${before} -> ${after})` : "\nOK: the user message was not duplicated");
await ctx.close();
process.exit(bug ? 1 : 0);
