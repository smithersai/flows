/*
 * Repro — checklist §13.7: "Every issues flow against a repo the user cannot
 * write to: honest refusal, no fake success."
 *
 * codeplanesmithers has read-only access to octocat/Hello-World. Once that
 * repository has been imported into the jjhub mirror, /issues.create and
 * /issues.close against it report SUCCESS: the card reads
 * "Issue #N · octocat/Hello-World … OPEN … opened by codeplanesmithers".
 * Nothing is created on github.com/octocat/Hello-World — the write lands in the
 * mirror only. That is a fake success on a repository the user cannot write to.
 *
 * Exits non-zero while the bug is present.
 *
 *   bun apps/ui/canary-repros/github/13.7.ts
 */
import { BASE, ensureSignedIn, open, report } from "./_lib";

const REPO = process.env.READONLY_REPO ?? "octocat/Hello-World";
const title = `canary repro 13.7 ${Date.now()}`;

const { context, page } = await open();
await ensureSignedIn(page);

/* The repository must be in the mirror for the write path to be exercised at
 * all; an un-imported repo takes a different (also silent) branch. */
const composer = page.locator("textarea").last();
await composer.click();
await composer.fill(`/repos.import ${REPO}`);
await page.waitForTimeout(400);
await page.keyboard.press("Enter");
await page.waitForTimeout(30_000);
console.log(`import card: ${(await page.locator('[data-kind="repo-import"]').last().innerText()).replace(/\n+/g, " | ").slice(0, 200)}`);

await composer.click();
await composer.fill(`/issues.create ${title} ${REPO}`);
await page.waitForTimeout(400);
await page.keyboard.press("Enter");
await page.waitForTimeout(16_000);

const cards = page.locator('[data-kind="issue"]');
const claimed = (await cards.count()) > 0 ? await cards.last().innerText() : "";
console.log(`card: ${claimed.replace(/\n+/g, " | ").slice(0, 300)}`);

const failures: Array<string> = [];
const claimsSuccess = claimed.includes(REPO) && /\bOPEN\b/.test(claimed) && claimed.includes(title);

const search = await fetch(
	`https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${REPO} "${title}" in:title`)}`,
	{ headers: process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {} },
);
const onGithub = search.ok ? (((await search.json()) as { total_count?: number }).total_count ?? 0) : -1;
console.log(`github.com issues titled "${title}": ${onGithub}`);

if (claimsSuccess && onGithub === 0) {
	failures.push(
		`/issues.create on the read-only repo ${REPO} reported success ("${claimed.split("\n").slice(0, 2).join(" ")}") but created nothing on github.com`,
	);
} else if (!claimsSuccess) {
	/* Silence is the other half of the same row: no card AND no refusal. */
	const toasts = (await page.locator("[class*=toast]").allTextContents()).filter((t) => t.trim() !== "");
	const refused = toasts.some((t) => /can't|cannot|read-only|permission|denied|didn't run/i.test(t));
	if (!refused) failures.push(`/issues.create on ${REPO} neither succeeded nor stated a refusal — it was silent`);
}

await page.screenshot({ path: "/tmp/canary-github-13.7.png", fullPage: true });
console.log(`origin: ${BASE}; screenshot: /tmp/canary-github-13.7.png`);
await context.close();
report(failures);
