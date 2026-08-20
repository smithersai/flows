/*
 * Repro — checklist row 9.4 ("`reco.accept` runs the proposed work and the card
 * moves to 'acted'") against https://canary.smithers.sh.
 *
 * The card DOES move to "acted". The proposed work does NOT run: the
 * recommendation proposes reviewing GitHub pull request #2 of
 * codeplanesmithers/canary-sandbox (open, confirmed through api.github.com),
 * and the turn accept launches answers "No pull requests in
 * codeplanesmithers/canary-sandbox" because the pull-request flows read the
 * Smithers Cloud landing index (GET /api/repos/:owner/:repo/landings), never
 * GitHub.
 *
 * This script asserts only the failing half, so it needs no recommendation
 * supply and consumes none: it asks the product for the pull requests of the
 * repository the live recommendation is about, and compares that with GitHub.
 *
 *   bun 9.4.ts        exit 1 while the bug is present, 0 once it is fixed.
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.PROF ?? "/tmp/canary-surfaces-profile";
const REPO = "codeplanesmithers/canary-sandbox";

const github = (await (await fetch(`https://api.github.com/repos/${REPO}/pulls?state=open`)).json()) as Array<{
	number: number;
	title: string;
}>;
console.log(`github: ${github.length} open pull request(s) in ${REPO}:`, github.map((pull) => `#${pull.number}`).join(", "));

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 1000 } });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);

const session = await page.evaluate(async () => (await fetch("/api/auth/session")).text());
console.log("session:", session);
if (!session.includes("login")) {
	console.error("FAIL(setup): the profile is signed out — run the OAuth flow first.");
	await context.close();
	process.exit(2);
}

/*
 * Start from an empty transcript. The recommendation card names the pull
 * request's title, so a whole-body match would agree with GitHub for the wrong
 * reason; the assertion below reads the pr-list card alone.
 */
await page.goto("about:blank", { waitUntil: "domcontentloaded" });
const cdp = await context.newCDPSession(page);
await cdp.send("Storage.clearDataForOrigin", {
	origin: new URL(BASE).origin,
	storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers",
});
await cdp.detach().catch(() => {});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(7000);

const composer = page.locator("textarea.sui-chat-composer-input");
await composer.click();
await composer.fill(`/prs.list ${REPO}`);
await page.keyboard.press("Enter");
await page.waitForTimeout(10000);

const body = await page.locator("body").innerText();
await page.screenshot({ path: "/tmp/canary-9.4.png", fullPage: true });

/*
 * The product Worker caps a session at 120 turns an hour and renders the cap
 * with the closed-alpha copy. A gated turn produces no pull-request card at
 * all, which must read as a setup failure, never as either verdict.
 */
if (body.includes("open to design partners only") || body.includes("something is looping")) {
	console.error("SETUP: the session is turn-rate-limited (120/hour) — rerun after the window resets.");
	await context.close();
	process.exit(2);
}

const card = page.locator('[data-kind="pr-list"]').last();
if ((await card.count()) === 0) {
	console.error("SETUP: /prs.list rendered no pr-list card — nothing to compare.");
	await context.close();
	process.exit(2);
}
const cardText = await card.innerText();
console.log("pr-list card:\n" + cardText);
console.log("screenshot: /tmp/canary-9.4.png");
await context.close();

/* Assert POSITIVELY, and against the card alone. */
const missing = github.filter((pull) => !cardText.includes(`#${pull.number}`) || !cardText.includes(pull.title));
if (missing.length > 0) {
	console.error(
		`FAIL: GitHub has ${github.length} open pull request(s) in ${REPO} and the product's pull-request card omits ${
			missing.length
		} of them (${missing.map((pull) => `#${pull.number} "${pull.title}"`).join(", ")}), so accepting the recommendation that proposes reviewing one cannot run the proposed work.`,
	);
	process.exit(1);
}
console.log("PASS: the product's pull-request card names every open GitHub pull request.");
