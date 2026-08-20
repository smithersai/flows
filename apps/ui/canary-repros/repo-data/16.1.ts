/*
 * Checklist §16.1 — `/flow.create <description>` must produce a workflow, and
 * "the created workflow is real on the workspace".
 *
 * On the canary the launch half works: a real `create-workflow` run starts on
 * the gateway and the card follows it. The result half does not. The run ends
 * in ~1.3 s with two steps (`clarify`, `output`), the card says "Finished."
 * with no result body and no next step, and `/flow.list` afterwards shows the
 * SAME set of workflows as before — nothing was created.
 *
 * This script records the workflow list before and after a `/flow.create`, and
 * exits non-zero when the list did not gain an entry.
 *
 *   cp -R ~/.multi-e2e-profile /tmp/canary-repo-data-profile
 *   bun apps/ui/canary-repros/repo-data/16.1.ts
 */
import { open, runFlow } from "./_lib.ts";

const REPO = "codeplanesmithers/demo-calendar";
const DESCRIPTION = "write a HELLO-CANARY.md file greeting the repo owner";

const listKeys = async (page: import("playwright").Page): Promise<Array<string>> => {
	await runFlow(page, "/flow.list");
	for (let attempt = 0; attempt < 24; attempt += 1) {
		await page.waitForTimeout(10_000);
		const text = await page.evaluate(
			() =>
				document.querySelector('[data-kind="workflow-list"]')?.textContent?.replace(/\s+/g, " ") ?? "",
		);
		if (text.includes("Run")) {
			return [...text.matchAll(/([a-z][a-z0-9-]+)Run/g)].map((match) => match[1] ?? "");
		}
	}
	return [];
};

const { context, page } = await open();
await runFlow(page, "/clear");
await page.waitForTimeout(6000);

const before = await listKeys(page);
console.log("workflows before:", JSON.stringify(before));

await runFlow(page, `/flow.create ${DESCRIPTION} ${REPO}`);
let card = "";
for (let attempt = 0; attempt < 40; attempt += 1) {
	await page.waitForTimeout(10_000);
	card = await page.evaluate(
		() => document.querySelector('[data-kind="flow-run"]')?.textContent?.replace(/\s+/g, " ") ?? "",
	);
	if (/finished|failed|Done/i.test(card)) break;
}
console.log("run card:", card.slice(0, 600));

const after = await listKeys(page);
console.log("workflows after:", JSON.stringify(after));
await page.screenshot({ path: "/tmp/canary-repro-16.1.png", fullPage: true });
await context.close();

const gained = after.filter((key) => !before.includes(key));
console.log("gained:", JSON.stringify(gained));
if (gained.length === 0) {
	console.error("FAIL 16.1: /flow.create reported a finished run but the workspace gained no workflow.");
	process.exit(1);
}
console.log("PASS 16.1: the workspace gained", gained.join(", "));
