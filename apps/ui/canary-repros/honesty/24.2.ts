/*
 * Repro — checklist row 24.2 (honesty lane, §24 Errors, limits, and degradation).
 *
 * "Every upstream the UI calls, forced to fail: agent turn, identity, billing,
 *  reco, notifications, github import, workflow rpc. Each produces a named,
 *  actionable message."
 *
 * Four of the seven do not. The worst is billing: with the billing upstream
 * unreachable, /billing.balance renders a Balance card stamped with the CURRENT
 * time, showing a balance it could not read. That is not a missing message, it
 * is a fabricated success.
 *
 * Each upstream is forced to fail with Playwright route interception (abort =
 * the upstream is unreachable), then the flow that calls it is invoked, and the
 * lines the turn added are read back.
 *
 *   bun canary-repros/honesty/24.2.ts
 *
 * Exits 1 while any upstream fails without a named, honest message.
 */
import { chromium } from "playwright";
import type { Page } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.PROF ?? "/tmp/canary-honesty-profile";

interface Case {
	readonly upstream: string;
	readonly glob: string;
	readonly trigger: string;
	/** What an honest answer must contain. */
	readonly honest: RegExp;
}

const CASES: ReadonlyArray<Case> = [
	{ upstream: "agent turn", glob: "**/api/agent/turn**", trigger: "Say hi.", honest: /couldn'?t complete that turn|could not reach/i },
	{ upstream: "billing", glob: "**/api/billing/**", trigger: "/billing.balance", honest: /couldn'?t|could not|unavailable|didn'?t answer/i },
	{ upstream: "reco", glob: "**/api/reco/**", trigger: "/reco.refresh", honest: /couldn'?t|could not|unavailable|didn'?t answer/i },
	{ upstream: "notifications", glob: "**/api/notifications/**", trigger: "/notifications.list", honest: /couldn'?t|could not|didn'?t answer/i },
	{ upstream: "github import", glob: "**/api/github/import**", trigger: "/repos.import codeplanesmithers/canary-sandbox", honest: /couldn'?t|could not|failed|try again/i },
	{ upstream: "workflow rpc", glob: "**/api/workflow/**", trigger: "/flow.list", honest: /couldn'?t|could not|unavailable|didn'?t answer|unreachable/i },
];

const failures: Array<string> = [];

const run = async (test: Case): Promise<void> => {
	const context = await chromium.launchPersistentContext(PROFILE, {
		headless: true,
		viewport: { width: 1400, height: 1100 },
	});
	const page: Page = context.pages()[0] ?? (await context.newPage());
	let hits = 0;
	await page.route(test.glob, (route) => {
		hits += 1;
		return route.abort("failed");
	});
	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(5000);
	const before = await page.locator("body").innerText();
	const composer = page.locator("textarea.sui-chat-composer-input");
	await composer.click();
	await composer.fill(test.trigger);
	await composer.press("Enter");
	await page.waitForTimeout(30_000);
	const after = await page.locator("body").innerText();
	/*
	 * Read only what followed THIS invocation. A line-diff against `before`
	 * is wrong on a transcript that already holds an identical earlier turn:
	 * the new message is filtered out as "seen before" and the case reads as
	 * a silent failure when it was not.
	 */
	const echoedAt = after.lastIndexOf(test.trigger);
	const tail = echoedAt === -1 ? after.slice(before.length) : after.slice(echoedAt + test.trigger.length);
	const added = tail.split("\n").map((line) => line.trim()).filter((line) => line !== "");
	await page.screenshot({ path: `/tmp/honesty-repro-24.2-${test.upstream.replace(/\s+/g, "-")}.png`, fullPage: true });
	await context.close();

	const joined = added.join(" | ");
	console.log(`\n### ${test.upstream}  (route hits: ${hits})`);
	console.log(`    added: ${JSON.stringify(added.slice(0, 8))}`);

	if (hits === 0) {
		console.log("    (upstream never called by this trigger — not graded)");
		return;
	}
	/* A card that reports a value while the upstream was dead is a fabricated success. */
	if (test.upstream === "billing" && /\$[\d,]+ left\./.test(joined)) {
		failures.push(
			`billing: with the upstream unreachable, /billing.balance rendered a fresh Balance card ("${(joined.match(/\$[\d,]+ left\./) ?? [""])[0]}") stamped with the current time — a fabricated success, not a message`,
		);
		return;
	}
	if (!test.honest.test(joined)) {
		failures.push(
			added.length === 0
				? `${test.upstream}: the upstream was called and failed, and the UI said NOTHING (console.error only)`
				: `${test.upstream}: no honest named message — the UI said ${JSON.stringify(added.slice(0, 3))}`,
		);
	}
};

for (const test of CASES) await run(test);

console.log("\n--- screenshots: /tmp/honesty-repro-24.2-<upstream>.png");
if (failures.length === 0) {
	console.log("PASS — every forced upstream failure produced a named message.");
	process.exit(0);
}
for (const failure of failures) console.error(`FAIL: ${failure}`);
process.exit(1);
