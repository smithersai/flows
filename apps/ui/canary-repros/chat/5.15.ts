/*
 * Row 5.15 — a pointer press outside the surfaces dropdown dismisses it but
 * drops focus to `body` (or to whatever the click landed on) instead of leaving
 * it where it was. Escape does the right thing: it closes the menu AND returns
 * focus to the trigger.
 *
 * Exits 1 while the pointer-dismiss path loses focus.
 */
import { launch } from "./_harness";

const { ctx, page } = await launch();

const focus = () =>
	page.evaluate(() => ({
		tag: document.activeElement?.tagName ?? null,
		cls: String((document.activeElement as HTMLElement | null)?.className ?? "").slice(0, 45),
		label: document.activeElement?.getAttribute("aria-label") ?? null,
	}));

const trigger = page.locator('[data-flow="surfaces"]').first();
const openMenu = async () => {
	await trigger.focus();
	await page.keyboard.press("ArrowDown");
	await page.waitForTimeout(500);
	return page.locator(".composer-menu-list").count();
};

// Control: Escape closes and restores focus to the trigger.
console.log("menu open after ArrowDown:", await openMenu(), "| focus:", JSON.stringify(await focus()));
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
const afterEscape = await focus();
console.log("after Escape: menu", await page.locator(".composer-menu-list").count(), "| focus:", JSON.stringify(afterEscape));
const escapeKeepsFocus = afterEscape.label === "Surfaces";

// The row's clause: a pointer press outside.
const losses: Array<Record<string, unknown>> = [];
for (const [x, y] of [
	[60, 120],
	[1380, 600],
	[700, 60],
] as const) {
	await openMenu();
	const before = await focus();
	const target = await page.evaluate(([px, py]) => {
		const element = document.elementFromPoint(px, py);
		return { tag: element?.tagName ?? null, cls: String((element as HTMLElement | null)?.className ?? "").slice(0, 40) };
	}, [x, y]);
	await page.mouse.click(x, y);
	await page.waitForTimeout(500);
	const after = await focus();
	const dismissed = (await page.locator(".composer-menu-list").count()) === 0;
	const kept = after.tag === before.tag && after.cls === before.cls;
	console.log(`click (${x},${y}) on ${target.tag} -> dismissed ${dismissed}; focus ${before.tag} "${before.cls}" -> ${after.tag} "${after.cls}"`);
	if (!kept) losses.push({ x, y, before, after });
}

await page.screenshot({ path: "/tmp/canary-chat-5.15.png", fullPage: true });
console.log("screenshot: /tmp/canary-chat-5.15.png");
console.log("\nEscape closes and restores focus to the trigger:", escapeKeepsFocus);
console.log("pointer dismissals that moved focus:", losses.length, "of 3");

const bug = losses.length > 0;
console.log(bug ? "\nFAIL: a pointer press outside moves focus" : "\nOK");
await ctx.close();
process.exit(bug ? 1 : 0);
