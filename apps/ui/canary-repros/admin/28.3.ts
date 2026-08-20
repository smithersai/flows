/*
 * Repro — checklist row 28.3 ("Every loading state is distinguishable from a
 * dead frame") against https://canary.smithers.sh.
 *
 * The admin read cards finish their read and then stay badged PENDING forever,
 * with `data-status="active"`. A user cannot tell a finished read from one that
 * is still loading, or from a frame that died mid-read.
 *
 *   PROF=/tmp/canary-admin-profile bun 28.3.ts
 *   exit 1 while the bug is present, 0 once finished reads settle.
 *
 * Fixture: the session must be admin (identity worker ADMIN_LOGINS).
 */
import { open, session, run } from "./_lib";

const { context, page } = await open();
const who = await session(page);
if (who.admin !== true) {
	console.error("SETUP: the session is not admin — add the login to the identity worker's ADMIN_LOGINS.");
	await context.close();
	process.exit(2);
}

for (const flow of ["/admin.requests", "/admin.feedback", "/admin.health"]) await run(page, flow, 9000);
// A finished read has had every chance to settle.
await page.waitForTimeout(15_000);

const cards = await page.evaluate(() =>
	Array.from(document.querySelectorAll("section.smithers-card")).map((card) => {
		const element = card as HTMLElement;
		return {
			label: element.getAttribute("aria-label") ?? "",
			status: element.getAttribute("data-status"),
			badge: (element.innerText.match(/PENDING|DONE|FAILED|RUNNING|WAITING FOR APPROVAL/) ?? [""])[0],
			hasContent: element.innerText.length > 120,
		};
	}),
);
const expectedKinds = ["request-queue", "reco-log", "admin-health"];
const renderedKinds = await page.locator("section.smithers-card").evaluateAll((nodes) =>
	nodes.map((node) => node.getAttribute("data-kind")),
);
for (const card of cards) console.log(JSON.stringify(card));
await page.screenshot({ path: "/tmp/canary-28.3.png", fullPage: true });
console.log("screenshot: /tmp/canary-28.3.png");
await context.close();

const stuck = cards.filter((card) => card.badge === "PENDING" && card.hasContent);
const missing = expectedKinds.filter((kind) => !renderedKinds.includes(kind));
if (missing.length > 0) {
	console.error(`SETUP: expected completed admin cards did not render: ${missing.join(", ")}`);
	process.exit(2);
}
if (stuck.length === 0) {
	console.log("PASS — no finished read is still badged PENDING.");
	process.exit(0);
}
console.error(
	`FAIL: ${stuck.length} card${stuck.length === 1 ? "" : "s"} finished the read but stayed badged PENDING with data-status="active": ${stuck.map((c) => c.label).join(" | ")}`,
);
process.exit(1);
