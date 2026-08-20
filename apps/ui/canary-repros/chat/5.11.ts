/*
 * Row 5.11 — a MALFORMED argument is refused silently.
 *
 * A MISSING argument produces the honest refusal the row asks for
 * ("/issues.view didn't run — issues.view needs an issue number"). The same
 * parser rejects `/issues.view abc` with the same string, but nothing is ever
 * shown: the draft clears and no toast, card or message appears.
 *
 * Exits 1 while the malformed case is silent.
 */
import { composer, launch, resetStore } from "./_harness";

const harness = await launch();
const { ctx, page } = harness;

/** Run one invocation on a clean transcript and collect any refusal text. */
const probe = async (invocation: string): Promise<Array<string>> => {
	await resetStore(harness);
	const box = composer(page);
	await box.click();
	await box.fill(invocation);
	await page.waitForTimeout(250);
	await page.keyboard.press("Enter");
	const seen = new Set<string>();
	for (let tick = 0; tick < 14; tick += 1) {
		await page.waitForTimeout(250);
		const texts = await page.evaluate(() =>
			Array.from(document.querySelectorAll("body *"))
				.filter(
					(element) =>
						element.children.length === 0 &&
						element.tagName !== "STYLE" &&
						element.tagName !== "SCRIPT" &&
						/didn.t run|needs a|needs an|expected|invalid|not a /i.test((element as HTMLElement).innerText ?? ""),
				)
				.map((element) => (element as HTMLElement).innerText),
		);
		for (const text of texts) seen.add(text);
	}
	return [...seen];
};

const rows: Array<{ invocation: string; kind: string; messages: Array<string> }> = [];
for (const [invocation, kind] of [
	["/issues.view", "missing (control)"],
	["/issues.view abc", "malformed"],
	["/issues.close abc", "malformed"],
	["/prs.view abc", "malformed"],
	["/admin.grant xyz will", "malformed"],
	["/env.set NOEQUALS", "malformed"],
] as const) {
	const messages = await probe(invocation);
	rows.push({ invocation, kind, messages });
	console.log(`${invocation.padEnd(24)} [${kind}] -> ${JSON.stringify(messages)}`);
}

await page.screenshot({ path: "/tmp/canary-chat-5.11.png", fullPage: true });
console.log("screenshot: /tmp/canary-chat-5.11.png");

const control = rows[0];
if (control.messages.length === 0) {
	console.error("\nINCONCLUSIVE: the missing-argument control produced no refusal either.");
	await ctx.close();
	process.exit(2);
}
const silent = rows.filter((row) => row.kind === "malformed" && row.messages.length === 0);
console.log(`\nmalformed invocations refused silently: ${silent.length}/${rows.length - 1}`);
console.log(silent.length > 0 ? "FAIL: malformed arguments say nothing" : "OK");
await ctx.close();
process.exit(silent.length > 0 ? 1 : 0);
