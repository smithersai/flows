/*
 * Repro — checklist row 11.6 ("Zero connectors renders an empty state that
 * names the next step") against https://canary.smithers.sh.
 *
 * With no repositories connected the Connectors pane renders a single line,
 * "No repositories connected". It states the condition and names no next step:
 * no sentence, no action, no pointer to Import or to the native app, which is
 * the only way to add one (apps/ui/src/mainview/ConnectorsSurface.tsx, the
 * `.connector-empty` block).
 *
 *   bun 11.6.ts       exit 1 while the bug is present, 0 once it is fixed.
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.PROF ?? "/tmp/canary-surfaces-profile";

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 1000 } });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);

/** `/connect` toggles the pane, so open it only when it is absent. */
const openConnectors = async (): Promise<boolean> => {
	for (let attempt = 0; attempt < 3; attempt++) {
		if ((await page.locator("section.connectors-surface").count()) > 0) return true;
		const composer = page.locator("textarea.sui-chat-composer-input");
		await composer.click();
		await composer.fill("/connect");
		await page.keyboard.press("Enter");
		await page.waitForTimeout(2000);
	}
	return (await page.locator("section.connectors-surface").count()) > 0;
};
if (!(await openConnectors())) {
	console.error("FAIL(setup): the Connectors pane never opened.");
	await context.close();
	process.exit(2);
}

const connected = await page.locator(".connected-repository-card").count();
console.log("connected repositories:", connected);
if (connected > 0) {
	console.error("SETUP: this account has connectors — the zero state cannot be graded here.");
	await context.close();
	process.exit(2);
}

const empty = page.locator(".connector-empty");
const emptyText = (await empty.innerText()).trim();
const actions = await empty.locator("button, a, [data-flow]").count();
console.log("empty-state text:", JSON.stringify(emptyText));
console.log("actionable elements inside the empty state:", actions);
await page.screenshot({ path: "/tmp/canary-11.6.png", fullPage: true });
console.log("screenshot: /tmp/canary-11.6.png");
await context.close();

/*
 * A named next step is a verb the reader can act on, or an affordance inside
 * the empty state. "No repositories connected" is neither.
 */
const namesNextStep =
	actions > 0 || /\b(import|connect|add|choose|open|install|get started|create)\b/i.test(emptyText.replace(/^No repositories connected$/i, ""));
if (!namesNextStep) {
	console.error(`FAIL: the zero-connector empty state reads ${JSON.stringify(emptyText)} and names no next step.`);
	process.exit(1);
}
console.log("PASS: the empty state names the next step.");
