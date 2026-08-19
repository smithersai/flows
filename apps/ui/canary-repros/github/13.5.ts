/*
 * Repro — checklist §13.5: "/issues.create <title> — the created issue exists
 * on GitHub and the card links to it."
 *
 * Expected: after /issues.create the issue is on github.com/<repo>/issues and
 * the "issue" card carries a link to it.
 * Actual: the issue is created only in the jjhub (api.jjhub.tech) mirror of
 * the repository. Nothing appears on GitHub, and the card carries no anchor at
 * all. Worse, the two number spaces collide: the card shows "Issue #N ·
 * owner/repo" while GitHub's issue #N in the same repository is an unrelated
 * issue, so the card reads as a GitHub issue it is not.
 *
 * Exits non-zero while the bug is present. Set GH_TOKEN (or run with `gh`
 * logged in) so the GitHub half can be checked; without it the script reports
 * the card-link half only and still fails.
 *
 *   bun apps/ui/canary-repros/github/13.5.ts
 */
import { BASE, ensureSignedIn, open, report } from "./_lib";

const REPO = process.env.REPO ?? "codeplanesmithers/canary-sandbox";
const title = `canary repro 13.5 ${Date.now()}`;

const { context, page } = await open();
await ensureSignedIn(page);

const composer = page.locator("textarea").last();
await composer.click();
await composer.fill(`/issues.create ${title} ${REPO}`);
await page.waitForTimeout(400);
await page.keyboard.press("Enter");
await page.waitForTimeout(15_000);

const card = page.locator('[data-kind="issue"]').last();
const cardText = await card.innerText();
const links = await card.locator("a").evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).href));
console.log(`card: ${cardText.replace(/\n+/g, " | ").slice(0, 300)}`);
console.log(`card links: ${JSON.stringify(links)}`);

const failures: Array<string> = [];
if (!links.some((href) => href.includes("github.com"))) {
	failures.push(`the created-issue card carries no github.com link (anchors: ${JSON.stringify(links)})`);
}

/* The GitHub half, read from GitHub's own public API. */
const search = await fetch(
	`https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${REPO} "${title}" in:title`)}`,
	{ headers: process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {} },
);
if (search.ok) {
	const found = ((await search.json()) as { total_count?: number }).total_count ?? 0;
	console.log(`github.com issues titled "${title}": ${found}`);
	if (found === 0) failures.push(`the issue the card reported as created does not exist on github.com/${REPO}`);
} else {
	console.log(`github search unavailable (${search.status}) — checking the card link only`);
}

await page.screenshot({ path: "/tmp/canary-github-13.5.png", fullPage: true });
console.log(`origin: ${BASE}; screenshot: /tmp/canary-github-13.5.png`);
await context.close();
report(failures);
