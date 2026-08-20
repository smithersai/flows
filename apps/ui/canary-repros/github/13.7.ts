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
import { withVerifiedRestoration } from "../../scripts/canary-restoration";

const REPO = process.env.READONLY_REPO ?? "octocat/Hello-World";
const title = `canary repro 13.7 ${Date.now()}`;

const { context, page } = await open();
await ensureSignedIn(page);

const composer = page.locator("textarea").last();
const failures: Array<string> = [];
let mirrorIssue = 0;
const findMirrorIssue = async (): Promise<number> =>
	await page.evaluate(async ([repo, expectedTitle]: [string, string]) => {
		const response = await fetch(`/api/repos/${repo}/issues?state=all&limit=100`);
		const body = await response.json().catch(() => []);
		if (!response.ok || !Array.isArray(body)) throw new Error(`pre-provisioned mirror is unreadable: HTTP ${response.status}`);
		return (body.find((entry: { title?: string }) => entry.title === expectedTitle) as { number?: number } | undefined)?.number ?? 0;
	}, [REPO, title] as [string, string]);

await withVerifiedRestoration(
	async () => {
		await composer.click();
		await composer.fill(`/issues.create ${title} ${REPO}`);
		await page.keyboard.press("Enter");
		await page.waitForTimeout(16_000);
		mirrorIssue = await findMirrorIssue();
		const cards = page.locator('[data-kind="issue"]');
		const claimed = (await cards.count()) > 0 ? await cards.last().innerText() : "";
		const claimsSuccess = claimed.includes(REPO) && /\bOPEN\b/.test(claimed) && claimed.includes(title);
		const search = await fetch(
			`https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${REPO} "${title}" in:title`)}`,
			{ headers: process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {} },
		);
		if (!search.ok) throw new Error(`GitHub confirmation was unreadable: HTTP ${search.status}`);
		const onGithub = ((await search.json()) as { total_count?: number }).total_count ?? 0;
		if (claimsSuccess && onGithub === 0) {
			failures.push(`/issues.create on read-only ${REPO} reported success but created nothing on GitHub`);
		} else if (!claimsSuccess) {
			const toasts = (await page.locator("[class*=toast]").allTextContents()).filter((text) => text.trim() !== "");
			if (!toasts.some((text) => /can't|cannot|read-only|permission|denied|didn't run/i.test(text))) {
				failures.push(`/issues.create on ${REPO} neither succeeded nor stated a refusal`);
			}
		}
		await page.screenshot({ path: "/tmp/canary-github-13.7.png", fullPage: true });
	},
	async () => {
		if (mirrorIssue <= 0) mirrorIssue = await findMirrorIssue();
		if (mirrorIssue <= 0) return;
		const status = await page.evaluate(async ([repo, n]: [string, number]) => {
			const response = await fetch(`/api/repos/${repo}/issues/${n}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ state: "closed" }),
			});
			return response.status;
		}, [REPO, mirrorIssue] as [string, number]);
		if (status < 200 || status >= 300) throw new Error(`mirror issue close answered HTTP ${status}`);
	},
	async () => {
		if (mirrorIssue <= 0) return;
		const state = await page.evaluate(async ([repo, n]: [string, number]) => {
			const response = await fetch(`/api/repos/${repo}/issues/${n}`);
			return response.ok ? ((await response.json()) as { state?: string }).state : `HTTP ${response.status}`;
		}, [REPO, mirrorIssue] as [string, number]);
		if (state !== "closed") throw new Error(`mirror issue state is ${String(state)}, not closed`);
	},
	`close the uniquely titled mirror issue "${title}" in ${REPO}`,
);
console.log(`origin: ${BASE}; screenshot: /tmp/canary-github-13.7.png`);
await context.close();
report(failures);
