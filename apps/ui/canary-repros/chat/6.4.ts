/*
 * Row 6.4 — `/flows` lists 65 of the 88 names on the app shell's `data-flows`.
 *
 * The 23 omissions are exactly the hidden id-scoped actions that row 5.7
 * requires never be listed, so this is a genuine conflict between two rows
 * rather than a plain regression: `/flows` is the user-facing listing, and
 * `data-flows` is the whole registry (visible AND hidden, by its own comment in
 * App.tsx). Recorded so the fix stage decides which of the two rows moves.
 *
 * Exits 1 while the two lists differ.
 */
import { composer, launch, resetStore } from "./_harness";

const harness = await launch();
const { ctx, page } = harness;
await resetStore(harness);

const manifest = (await page.evaluate(
	() => document.querySelector("[data-flows]")!.getAttribute("data-flows")!,
))
	.split(/\s+/)
	.filter(Boolean)
	.sort();

const box = composer(page);
await box.click();
await box.fill("/flows");
await page.keyboard.press("Enter");
await page.waitForTimeout(3000);

const rendered = await page.locator("body").innerText();
const listed = manifest.filter((name) => rendered.includes(`/${name} —`));
const missing = manifest.filter((name) => !rendered.includes(`/${name} —`));

console.log("data-flows manifest:", manifest.length);
console.log("/flows output lists:", listed.length);
console.log("missing from /flows (" + missing.length + "):");
console.log(JSON.stringify(missing, null, 1));
await page.screenshot({ path: "/tmp/canary-chat-6.4.png", fullPage: true });
console.log("screenshot: /tmp/canary-chat-6.4.png");

const bug = missing.length > 0;
console.log(bug ? "\nFAIL: /flows does not match data-flows" : "\nOK");
await ctx.close();
process.exit(bug ? 1 : 0);
