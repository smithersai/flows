/*
 * Row 4.2 — a GitHub-flavored markdown table renders as raw pipe text.
 *
 * `Markdown` (`.sui-md`) handles headings (`.sui-md-heading`), lists, links,
 * inline code, fenced code and a long unbroken token. It has no table rule, so
 * `| Col A | Col B |` reaches the bubble as one paragraph with <br> between the
 * rows. The same renderer draws the user bubble and the assistant bubble, so
 * this reproduces without spending a model turn.
 *
 * Exits 1 while the bug is present.
 */
import { launch, resetStore, send, settle } from "./_harness";

const MARKDOWN =
	"Output exactly this markdown and nothing else:\n# H1 Title\n## H2 Title\n\n| Col A | Col B |\n|---|---|\n| 1 | 2 |";

const harness = await launch();
const { ctx, page } = harness;
await resetStore(harness);

await send(page, MARKDOWN);
await settle(page, 45_000);

const rendered = await page.evaluate(() => {
	const blocks = Array.from(document.querySelectorAll(".sui-md")).filter((element) =>
		(element as HTMLElement).innerText.includes("Col A"),
	);
	return {
		bubbles: blocks.length,
		html: (blocks[0] as HTMLElement | undefined)?.innerHTML ?? "",
		tables: document.querySelectorAll("table").length,
		cells: document.querySelectorAll("td,th").length,
		headings: document.querySelectorAll(".sui-md-heading").length,
	};
});

console.log("bubbles containing the table source:", rendered.bubbles);
console.log("their markdown HTML:\n", rendered.html.slice(0, 800));
console.log("\n<table> elements:", rendered.tables);
console.log("<td>/<th> elements:", rendered.cells);
console.log(".sui-md-heading elements:", rendered.headings, "(headings DO render — only tables do not)");

await page.screenshot({ path: "/tmp/canary-chat-4.2.png", fullPage: true });
console.log("screenshot: /tmp/canary-chat-4.2.png");

if (rendered.bubbles === 0) {
	console.error("\nINCONCLUSIVE: no bubble carried the table source — the message never rendered.");
	await ctx.close();
	process.exit(2);
}
const bug = rendered.tables === 0 && /\|\s*Col A\s*\|/.test(rendered.html);
console.log(bug ? "\nFAIL: the table rendered as raw pipe text" : "\nOK: the table rendered as a <table>");
await ctx.close();
process.exit(bug ? 1 : 0);
