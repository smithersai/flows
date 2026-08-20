/*
 * Row 6.1 — visible interactive affordances that carry no `data-flow`, on every
 * surface, each of which has a registered flow it should bind to.
 *
 * Exits 1 while any un-bound affordance is on screen.
 */
import { composer, launch, resetStore } from "./_harness";

const harness = await launch();
const { ctx, page } = harness;
await resetStore(harness);

const sweep = async (label: string) => {
	const found = await page.evaluate(() => {
		const visible = (element: Element) => {
			const box = element.getBoundingClientRect();
			return box.width > 0 && box.height > 0 && (element as HTMLElement).offsetParent !== null;
		};
		const affordances = Array.from(
			document.querySelectorAll(
				"button,[role=button],[role=menuitem],[role=option],a[href],input[type=checkbox],summary",
			),
		).filter(visible);
		return {
			total: affordances.length,
			unbound: affordances
				.filter((element) => element.closest("[data-flow]") === null)
				.map((element) => ({
					tag: element.tagName,
					label: element.getAttribute("aria-label") ?? (element as HTMLElement).innerText.slice(0, 30),
				})),
		};
	});
	console.log(`\n[${label}] visible affordances ${found.total}, without data-flow ${found.unbound.length}`);
	for (const item of found.unbound) console.log("   ", item.tag, "—", JSON.stringify(item.label));
	return found.unbound;
};

const run = async (flow: string) => {
	const box = composer(page);
	await box.click();
	await box.fill(flow);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(2200);
};

const unbound = new Map<string, string>();
const record = (items: Array<{ tag: string; label: string }>) => {
	for (const item of items) unbound.set(`${item.tag}:${item.label}`, item.label);
};

record(await sweep("chat surface (idle)"));
await run("/world");
record(await sweep("world surface"));
await run("/connect");
record(await sweep("connectors surface"));

console.log("\ndistinct affordances with no data-flow:", unbound.size);
for (const key of unbound.keys()) console.log("   ", key);
await page.screenshot({ path: "/tmp/canary-chat-6.1.png", fullPage: true });
console.log("screenshot: /tmp/canary-chat-6.1.png");

const bug = unbound.size > 0;
console.log(bug ? "\nFAIL: interactive affordances resolve to no named flow" : "\nOK");
await ctx.close();
process.exit(bug ? 1 : 0);
