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
import { withVerifiedRestoration } from "../../scripts/canary-restoration";

const REPO = process.env.REPO ?? "codeplanesmithers/canary-sandbox";
const title = `canary repro 13.5 ${Date.now()}`;

const { context, page } = await open();
await ensureSignedIn(page);

const failures: Array<string> = [];
let number = 0;
const findFixture = async (): Promise<number> =>
	await page.evaluate(async ([repo, expectedTitle]: [string, string]) => {
		const response = await fetch(`/api/repos/${repo}/issues?state=all&limit=100`);
		const body = await response.json().catch(() => []);
		if (!response.ok || !Array.isArray(body)) throw new Error(`issue list answered HTTP ${response.status}`);
		return (body.find((entry: { title?: string }) => entry.title === expectedTitle) as { number?: number } | undefined)?.number ?? 0;
	}, [REPO, title] as [string, string]);

await withVerifiedRestoration(
	async () => {
		const composer = page.locator("textarea").last();
		await composer.click();
		await composer.fill(`/issues.create ${title} ${REPO}`);
		await page.keyboard.press("Enter");
		await page.waitForTimeout(15_000);
		number = await findFixture();
		if (number <= 0) throw new Error("the uniquely titled fixture issue could not be found after creation");
		const card = page.locator('[data-kind="issue"]').last();
		const links = await card.locator("a").evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).href));
		if (!links.some((href) => href.includes("github.com"))) {
			failures.push(`the created-issue card carries no github.com link (anchors: ${JSON.stringify(links)})`);
		}
		const search = await fetch(
			`https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${REPO} "${title}" in:title`)}`,
			{ headers: process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {} },
		);
		if (!search.ok) throw new Error(`GitHub search was unreadable: HTTP ${search.status}`);
		if ((((await search.json()) as { total_count?: number }).total_count ?? 0) === 0) {
			failures.push(`the issue the card reported as created does not exist on github.com/${REPO}`);
		}
		await page.screenshot({ path: "/tmp/canary-github-13.5.png", fullPage: true });
	},
	async () => {
		if (number <= 0) number = await findFixture();
		if (number <= 0) throw new Error("could not identify the uniquely titled fixture for cleanup");
		const response = await page.evaluate(async ([repo, n]: [string, number]) => {
			const result = await fetch(`/api/repos/${repo}/issues/${n}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ state: "closed" }),
			});
			return result.status;
		}, [REPO, number] as [string, number]);
		if (response < 200 || response >= 300) throw new Error(`issue close answered HTTP ${response}`);
	},
	async () => {
		const state = await page.evaluate(async ([repo, n]: [string, number]) => {
			const response = await fetch(`/api/repos/${repo}/issues/${n}`);
			return response.ok ? ((await response.json()) as { state?: string }).state : `HTTP ${response.status}`;
		}, [REPO, number] as [string, number]);
		if (state !== "closed") throw new Error(`issue state is ${String(state)}, not closed`);
	},
	`close the uniquely titled issue "${title}" in ${REPO}`,
);
console.log(`origin: ${BASE}; screenshot: /tmp/canary-github-13.5.png`);
await context.close();
report(failures);
