/*
 * Repro — checklist row 24.2 (honesty lane, §24 Errors, limits, and degradation).
 *
 * "Every upstream the UI calls, forced to fail: agent turn, identity, billing,
 *  reco, notifications, github import, workflow rpc. Each produces a named,
 *  actionable message."
 *
 * Each upstream is made unreachable with Playwright route interception
 * (route.abort — the honest simulation of "the upstream is down"), then the
 * flow that calls it is invoked.
 *
 * Four of the seven are fine and are asserted here so a regression is caught:
 *   agent turn   → "I couldn't complete that turn. Could not reach the Smithers
 *                   web agent: Failed to fetch" + a Turn failed badge
 *   notifications→ "/notifications.list didn't run — Your notifications couldn't
 *                   be loaded — the platform didn't answer."
 *   github import→ "The import couldn't start — Failed to fetch" + Try again
 *   workflow rpc → "/flow.list didn't run — The workspace couldn't be prepared —
 *                   the workflow service didn't answer."
 *
 * Reco is fine too ("I couldn't reach the recommendations service just now — ask
 * me anything and we'll start from here.") and is asserted below.
 *
 * Two are not:
 *   A. BILLING fabricates a success. With billing unreachable, /billing.balance
 *      renders a NEW Balance card, stamped with the current time, stating a
 *      balance the app could not read.
 *   B. IDENTITY names the wrong cause. Its failure prints "This build isn't
 *      connected to Smithers' identity service … Use the deployed app for the
 *      signed-in experience" — on the deployed app.
 *
 *   bun canary-repros/honesty/24.2.ts
 *
 * Exits 1 while any of A/B/C holds.
 */
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.PROF ?? "/tmp/canary-honesty-profile";
const failures: Array<string> = [];

const open = async (glob: string): Promise<{ context: BrowserContext; page: Page; hits: () => number }> => {
	const context = await chromium.launchPersistentContext(PROFILE, {
		headless: true,
		viewport: { width: 1400, height: 1100 },
	});
	const page = context.pages()[0] ?? (await context.newPage());
	let count = 0;
	await page.route(glob, (route) => {
		count += 1;
		return route.abort("failed");
	});
	return { context, page, hits: () => count };
};

const submit = async (page: Page, text: string, settleMs = 30_000): Promise<void> => {
	const composer = page.locator("textarea.sui-chat-composer-input");
	await composer.click();
	await composer.fill(text);
	await composer.press("Enter");
	await page.waitForTimeout(settleMs);
};

const BALANCE_LINE = /\$[\d,]+ left\./g;

/* ---- A. billing: a fabricated success ---------------------------------- */
const STAMP = /balance · [0-9:]+ ?[AP]M/g;
const AMOUNT = /\$[\d,]+ left\./g;
{
	const context = await chromium.launchPersistentContext(PROFILE, {
		headless: true,
		viewport: { width: 1400, height: 1100 },
	});
	const page = context.pages()[0] ?? (await context.newPage());
	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(6000);
	/* A real read first, so the card and its timestamp exist. */
	const before = await page.locator("body").innerText();
	const stampBefore = (before.match(STAMP) ?? []).at(-1);
	const amountBefore = (before.match(AMOUNT) ?? []).at(-1);

	/* Now the upstream goes away, and the user asks again. */
	let hits = 0;
	await page.route("**/api/billing/**", (route) => {
		hits += 1;
		return route.abort("failed");
	});
	await submit(page, "/billing.balance", 25_000);
	const after = await page.locator("body").innerText();
	const stampAfter = (after.match(STAMP) ?? []).at(-1);
	const amountAfter = (after.match(AMOUNT) ?? []).at(-1);
	const honest = /billing|balance/i.test(
		(after.match(/.{0,60}(couldn'?t|could not|unavailable|didn'?t answer).{0,60}/gi) ?? []).join(" "),
	);
	await page.screenshot({ path: "/tmp/honesty-repro-24.2-billing.png", fullPage: true });
	await context.close();
	console.log(
		`A. billing  hits=${hits}  card "${stampBefore}" ${amountBefore} → "${stampAfter}" ${amountAfter}  honest-message=${honest}`,
	);
	if (hits > 0 && stampAfter !== stampBefore) {
		failures.push(
			`billing: with the upstream unreachable (${hits} aborted fetch(es)) the Balance card re-stamped itself ${stampBefore} → ${stampAfter} and kept asserting "${amountAfter}" — it presents a value it could not read as a fresh read. Fabricated success, not a message.`,
		);
	} else if (!honest) {
		failures.push("billing: the upstream failed and the UI never named it");
	}
}

/* ---- the four that are fine, asserted so a regression is caught --------- */
const FINE: ReadonlyArray<{ readonly upstream: string; readonly glob: string; readonly trigger: string; readonly honest: RegExp }> = [
	{ upstream: "agent turn", glob: "**/api/agent/turn**", trigger: "Say hi.", honest: /couldn'?t complete that turn|could not reach the smithers web agent/i },
	{ upstream: "notifications", glob: "**/api/notifications/**", trigger: "/notifications.list", honest: /notifications couldn'?t be loaded/i },
	{ upstream: "github import", glob: "**/api/github/import**", trigger: "/repos.import codeplanesmithers/canary-sandbox", honest: /import couldn'?t start/i },
	{ upstream: "workflow rpc", glob: "**/api/workflow/**", trigger: "/flow.list", honest: /workspace couldn'?t be prepared|workflow service didn'?t answer/i },
];
for (const test of FINE) {
	const { context, page, hits } = await open(test.glob);
	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(5000);
	const before = await page.locator("body").innerText();
	await submit(page, test.trigger);
	const after = await page.locator("body").innerText();
	await context.close();
	/* The message may already be in the transcript from an earlier run; look at the whole body. */
	const named = test.honest.test(after) && after.length >= before.length - 400;
	console.log(`   ${test.upstream}  hits=${hits()}  named=${named}`);
	if (hits() > 0 && !named) {
		failures.push(`${test.upstream}: the upstream failed without a named message`);
	}
}

/* ---- reco: honest, asserted -------------------------------------------- */
{
	const { context, page, hits } = await open("**/api/reco/**");
	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(16_000);
	const text = await page.locator("body").innerText();
	await context.close();
	const named = /couldn'?t reach the recommendations service/i.test(text);
	console.log(`   reco  hits=${hits()}  named=${named}`);
	if (hits() > 0 && !named) failures.push("reco: the upstream failed without a named message");
}

/* ---- B. identity: the wrong cause -------------------------------------- */
{
	const { context, page, hits } = await open("**/api/auth/session**");
	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(16_000);
	const text = await page.locator("body").innerText();
	await page.screenshot({ path: "/tmp/honesty-repro-24.2-identity.png", fullPage: true });
	await context.close();
	const head = text.slice(0, 600);
	console.log(`B. identity  hits=${hits()}\n    ${head.split("\n").filter((l) => l.trim()).slice(0, 3).join(" | ")}`);
	if (/isn'?t connected to Smithers'? identity service/i.test(head) || /use the deployed app/i.test(head)) {
		failures.push(
			"identity: a failing identity upstream is reported as a build misconfiguration — \"This build isn't connected to Smithers' identity service … Use the deployed app for the signed-in experience\" — while the user IS on the deployed app; the named next step is impossible to act on",
		);
	}
}

console.log("\n--- screenshots: /tmp/honesty-repro-24.2-{billing,reco,identity}.png");
if (failures.length === 0) {
	console.log("PASS — every forced upstream failure produced a named, honest message.");
	process.exit(0);
}
for (const failure of failures) console.error(`FAIL: ${failure}`);
process.exit(1);
