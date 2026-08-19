/*
 * Repro — checklist §14.5: "/prs.land <n> queues the merge and the card
 * reflects the queue state, not a claimed merge. Confirm the claim matches
 * GitHub."
 *
 * The queue-state half is correct: the card flips to QUEUED and never claims a
 * merge (it stays QUEUED even after the platform has already recorded the
 * landing as `merged`).
 *
 * The GitHub half is not. The "pull request" /prs.land acts on is a jjhub
 * landing on api.jjhub.tech, not a github.com pull request. Landing it merges
 * inside the mirror; github.com/<repo> keeps the same default-branch head and
 * the same open pull requests. The card is titled "Pull requests · <owner/repo>"
 * and numbers its rows #1, #2 …, which collide with GitHub's own pull-request
 * numbers for that repository, so the card reads as GitHub state it is not.
 *
 * Exits non-zero while the claim cannot be confirmed against GitHub.
 *
 *   bun apps/ui/canary-repros/github/14.5.ts
 */
import { BASE, ensureSignedIn, open, report } from "./_lib";

const REPO = process.env.REPO ?? "codeplanesmithers/canary-sandbox";
const { context, page } = await open();
await ensureSignedIn(page);

const ghHeaders = process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {};
const ghHeadBefore = await fetch(`https://api.github.com/repos/${REPO}/commits/HEAD`, { headers: ghHeaders })
	.then(async (r) => (r.ok ? ((await r.json()) as { sha: string }).sha : "unreadable"))
	.catch(() => "unreadable");
const ghPullsBefore = await fetch(`https://api.github.com/repos/${REPO}/pulls?state=open`, { headers: ghHeaders })
	.then(async (r) => (r.ok ? ((await r.json()) as unknown[]).length : -1))
	.catch(() => -1);
console.log(`github before: head=${ghHeadBefore.slice(0, 8)} openPulls=${ghPullsBefore}`);

const api = (path: string, method = "GET", body?: unknown): Promise<{ status: number; body: string }> =>
	page.evaluate(
		async ([p, m, b]: [string, string, unknown]) => {
			const response = await fetch(
				p,
				b === null
					? { method: m }
					: { method: m, headers: { "content-type": "application/json" }, body: JSON.stringify(b) },
			);
			return { status: response.status, body: await response.text() };
		},
		[path, method, body ?? null] as [string, string, unknown],
	);

const change = JSON.parse((await api(`/api/repos/${REPO}/changes?limit=5`)).body).items[0].change_id as string;
const title = `Canary repro 14.5 ${Date.now()}`;
const number = JSON.parse(
	(
		await api(`/api/repos/${REPO}/landings`, "POST", {
			title,
			body: "",
			source_bookmark: "main",
			target_bookmark: "main",
			change_ids: [change],
		})
	).body,
).number as number;
console.log(`landing under test: ${REPO}#${number} "${title}"`);

const composer = page.locator("textarea").last();
await composer.click();
await composer.fill(`/prs.land ${number} ${REPO}`);
await page.waitForTimeout(400);
await page.keyboard.press("Enter");
await page.waitForTimeout(18_000);

const card = await page.locator('[data-kind="pr"]').last().innerText();
console.log(`card: ${card.replace(/\n+/g, " | ").slice(0, 300)}`);
console.log(`platform landing: ${(await api(`/api/repos/${REPO}/landings/${number}`)).body.trim()}`);

const ghHeadAfter = await fetch(`https://api.github.com/repos/${REPO}/commits/HEAD`, { headers: ghHeaders })
	.then(async (r) => (r.ok ? ((await r.json()) as { sha: string }).sha : "unreadable"))
	.catch(() => "unreadable");
const ghPull = await fetch(
	`https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${REPO} "${title}" in:title type:pr`)}`,
	{ headers: ghHeaders },
)
	.then(async (r) => (r.ok ? (((await r.json()) as { total_count?: number }).total_count ?? 0) : -1))
	.catch(() => -1);
console.log(`github after: head=${ghHeadAfter.slice(0, 8)} pullsTitled="${title}"=${ghPull}`);

const failures: Array<string> = [];
/* The card must not claim a merge. */
if (/\bMERGED\b/i.test(card)) failures.push("the card claimed MERGED rather than the queue state");
/* And the pull request it just landed must be findable on GitHub. */
if (ghPull === 0) {
	failures.push(
		`the pull request the card landed ("${title}", card shows #${number}) does not exist on github.com/${REPO}; GitHub's default-branch head is unchanged at ${ghHeadAfter.slice(0, 8)} — the landing happened only in the jjhub mirror`,
	);
}

await page.screenshot({ path: "/tmp/canary-github-14.5.png", fullPage: true });
console.log(`origin: ${BASE}; screenshot: /tmp/canary-github-14.5.png`);
await context.close();
report(failures);
