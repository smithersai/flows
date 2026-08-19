/*
 * Repro — checklist row 28.2 ("Every empty state names the next step") against
 * https://canary.smithers.sh.
 *
 * The chat empty state gets this right: "Nothing here yet / Ask Smithers
 * anything to get started." The notifications empty state does not: it says
 * "Nothing new." and stops, naming no next step.
 *
 *   PROF=/tmp/canary-admin-profile bun 28.2.ts
 *   exit 1 while the bug is present, 0 once the empty state names a next step.
 */
import { open, run } from "./_lib";

const { context, page } = await open();
await run(page, "/notifications", 8000);

const card = await page.evaluate(() => {
	const element = Array.from(document.querySelectorAll("section.smithers-card")).find((c) =>
		(c.getAttribute("aria-label") ?? "").startsWith("Notifications"),
	) as HTMLElement | undefined;
	return element === undefined ? null : { label: element.getAttribute("aria-label"), text: element.innerText.trim() };
});
if (card === null) {
	console.error("SETUP: no Notifications card rendered.");
	await context.close();
	process.exit(2);
}
console.log("notifications card text:", JSON.stringify(card.text));

// For contrast, the chat empty state, which does name a next step.
const reset = page.locator('button[aria-label="Reset conversation"]').first();
if (await reset.isVisible().catch(() => false)) {
	await reset.click();
	await page.waitForTimeout(3000);
	const empty = await page.locator("body").innerText();
	console.log("chat empty state:", JSON.stringify(empty.replace(/\s+/g, " ").slice(0, 160)));
}
await page.screenshot({ path: "/tmp/canary-28.2.png", fullPage: true });
console.log("screenshot: /tmp/canary-28.2.png");
await context.close();

// A next step names an action the user can take: a flow, a verb, an imperative.
const body = card.text.replace(card.label ?? "", "");
const namesNextStep = /\/[a-z]+[.a-z-]*|Ask |Try |Choose |Connect |Add |Run |Open |Sign in|to get started/.test(body);
if (namesNextStep) {
	console.log("PASS — the empty state names a next step.");
	process.exit(0);
}
console.error(`FAIL: the notifications empty state is ${JSON.stringify(card.text)} — it names no next step.`);
process.exit(1);
