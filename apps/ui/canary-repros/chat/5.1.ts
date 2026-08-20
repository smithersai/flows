/*
 * Row 5.1 — bare `/` opens a 65-item menu that overflows the viewport, so the
 * recommended flow it leads with is drawn ABOVE the top of the window, and the
 * pointer that is still resting in the composer highlights a near-last item.
 * Enter then runs `/admin.feedback` instead of the recommendation.
 *
 * Two observations, one cause (the listing is not capped for a bare `/`):
 *   A. `.slash-menu` is ~2073px tall in a 1000px viewport, top ≈ -1109. Item 0
 *      (`/reco.accept`, data-gold) is off-screen and cannot be scrolled to —
 *      the element's own overflow-y is `visible` with no max-height.
 *   B. The menu's bottom edge (≈959) covers the composer (≈919), so the mouse
 *      that focused the composer fires `onMouseEnter` on item 63 and Enter runs
 *      that flow.
 *
 * Exits 1 while either is present.
 */
import { composer, launch } from "./_harness";

const { ctx, page } = await launch();

const box = (await composer(page).boundingBox())!;
// Focus the composer the ordinary way: a pointer press, pointer left in place.
await page.mouse.click(box.x + 200, box.y + box.height / 2);
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.press("Backspace");
await page.waitForTimeout(300);
await page.keyboard.type("/", { delay: 40 });
await page.waitForTimeout(900);

const menu = await page.evaluate(() => {
	const options = Array.from(document.querySelectorAll(".slash-menu [role=option]"));
	const list = document.querySelector(".slash-menu") as HTMLElement | null;
	const rect = list?.getBoundingClientRect();
	const firstRect = options[0]?.getBoundingClientRect();
	const selected = options.findIndex((option) => option.getAttribute("aria-selected") === "true");
	const nameOf = (index: number) =>
		index >= 0 ? (options[index]?.querySelector(".slash-menu-name") as HTMLElement)?.innerText : null;
	return {
		total: options.length,
		inViewport: options.filter((option) => {
			const r = option.getBoundingClientRect();
			return r.top >= 0 && r.bottom <= window.innerHeight;
		}).length,
		menuTop: Math.round(rect?.top ?? 0),
		menuBottom: Math.round(rect?.bottom ?? 0),
		menuHeight: Math.round(rect?.height ?? 0),
		overflowY: list === null ? null : getComputedStyle(list).overflowY,
		maxHeight: list === null ? null : getComputedStyle(list).maxHeight,
		firstName: nameOf(0),
		firstTop: Math.round(firstRect?.top ?? 0),
		selectedIndex: selected,
		selectedName: nameOf(selected),
		viewportHeight: window.innerHeight,
		composerTop: Math.round((document.querySelector("textarea") as HTMLElement).getBoundingClientRect().top),
	};
});

console.log(JSON.stringify(menu, null, 1));
await page.screenshot({ path: "/tmp/canary-chat-5.1.png" });
console.log("screenshot: /tmp/canary-chat-5.1.png");

const firstOffScreen = menu.firstTop < 0;
const wrongHighlight = menu.selectedIndex !== 0;
console.log(`\nA. leading recommendation "${menu.firstName}" drawn off-screen: ${firstOffScreen} (top ${menu.firstTop})`);
console.log(`B. highlight stolen by the resting pointer: ${wrongHighlight} (index ${menu.selectedIndex} = ${menu.selectedName})`);

const bug = firstOffScreen || wrongHighlight;
console.log(bug ? "\nFAIL: bare / + Enter does not run the recommended flow" : "\nOK");
await ctx.close();
process.exit(bug ? 1 : 0);
