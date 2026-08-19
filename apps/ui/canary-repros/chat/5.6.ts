/*
 * Row 5.6 — SLASH_MENU_CAP is not applied to a bare `/` (nor to prefix-heavy
 * queries), so the menu is the 65-item wall the cap exists to prevent.
 *
 * `slashItems` keeps every item whose `nameRank <= 1` on top of the
 * recommendations. `nameRank` returns 0 for an EMPTY query, so with a bare `/`
 * every flow is "named outright", `survivors` is all 65, `room` is 0, and the
 * cap never cuts anything. The same rule leaks on `/a` (13), `/re` (10) and
 * `/i` (9).
 *
 * The recency half of the row is verified here too, and it works.
 *
 * Exits 1 while the cap is not applied.
 */
import { composer, launch, openSlashMenu } from "./_harness";

const CAP = 8;
const { ctx, page } = await launch();

const names = () =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll(".slash-menu [role=option]")).map(
			(option) => (option.querySelector(".slash-menu-name") as HTMLElement).innerText,
		),
	);

const over: Array<{ query: string; count: number }> = [];
for (const query of ["/", "/a", "/re", "/i", "/s", "/list", "/th"]) {
	await openSlashMenu(page, query);
	const listed = await names();
	console.log(`"${query}" -> ${listed.length} items${listed.length > CAP ? "  <-- over the cap" : ""}`);
	if (listed.length > CAP) over.push({ query, count: listed.length });
}

// The recency half of the row: run two flows and watch them enter a capped listing.
await openSlashMenu(page, "/s");
const before = await names();
for (const flow of ["/debug.snapshot", "/debug.events"]) {
	const box = composer(page);
	await box.click();
	await box.fill(flow);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(1800);
}
await openSlashMenu(page, "/s");
const after = await names();
console.log("\nrecency check — /s before:", JSON.stringify(before));
console.log("recency check — /s after :", JSON.stringify(after));
console.log("recency reorders the remainder:", JSON.stringify(before) !== JSON.stringify(after));

console.log(`\nqueries over the ${CAP}-item cap:`, JSON.stringify(over));
const bug = over.length > 0;
console.log(bug ? "FAIL: the listing is not capped" : "OK: every listing is capped");
await ctx.close();
process.exit(bug ? 1 : 0);
