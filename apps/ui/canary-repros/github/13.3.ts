/*
 * Repro — checklist §13.3: "/issues.view <n> renders the body and comments,
 * including markdown and images."
 *
 * Expected: a markdown image `![alt](https://…)` in an issue body or a comment
 * renders as an <img>.
 * Actual: the card's markdown renderer drops the image syntax — it emits a
 * literal "!" followed by an ordinary link, so the card contains zero <img>
 * elements. Everything else (headings, bold, inline code, fenced code, lists,
 * links) renders correctly, so this is images only.
 *
 * Fixture: the script creates its own issue carrying an image in the body and
 * an image in a comment, so it does not depend on any pre-seeded row.
 *
 * Exits non-zero while the bug is present.
 *
 *   bun apps/ui/canary-repros/github/13.3.ts
 */
import { BASE, ensureSignedIn, open, report } from "./_lib";
import { withVerifiedRestoration } from "../../scripts/canary-restoration";

const REPO = process.env.REPO ?? "codeplanesmithers/canary-sandbox";
const IMAGE = "https://github.githubassets.com/images/modules/logos_page/Octocat.png";

const { context, page } = await open();
await ensureSignedIn(page);

const number = await page.evaluate(
	async ([repo, image]) => {
		const post = async (path: string, body: unknown): Promise<any> => {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			return await response.json();
		};
		const created = await post(`/api/repos/${repo}/issues`, {
			title: "Canary repro 13.3: markdown image",
			body: `## Heading\n\nA **bold** word and \`code\`.\n\n![octocat](${image})`,
		});
		await post(`/api/repos/${repo}/issues/${created.number}/comments`, {
			body: `A comment image:\n\n![octocat in a comment](${image})`,
		});
		return created.number as number;
	},
	[REPO, IMAGE] as const,
);
const failures: Array<string> = [];
await withVerifiedRestoration(
	async () => {
		console.log(`fixture issue: ${REPO}#${number}`);
		const composer = page.locator("textarea").last();
		await composer.click();
		await composer.fill(`/issues.view ${number} ${REPO}`);
		await page.keyboard.press("Enter");
		await page.waitForTimeout(14_000);
		const card = page.locator('[data-kind="issue"]').last();
		const images = await card.locator("img").count();
		const text = await card.innerText();
		if (!/Heading/.test(text) || !/bold/.test(text)) failures.push("the markdown body did not render at all");
		if (images < 2) failures.push(`the issue card rendered ${images} <img> for two markdown images`);
		await page.screenshot({ path: "/tmp/canary-github-13.3.png", fullPage: true });
	},
	async () => {
		const response = await page.evaluate(async ([repo, n]: [string, number]) => {
			const result = await fetch(`/api/repos/${repo}/issues/${n}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ state: "closed" }),
			});
			return { status: result.status, body: await result.text() };
		}, [REPO, number] as [string, number]);
		if (response.status < 200 || response.status >= 300) throw new Error(`issue close answered HTTP ${response.status}: ${response.body}`);
	},
	async () => {
		const state = await page.evaluate(async ([repo, n]: [string, number]) => {
			const response = await fetch(`/api/repos/${repo}/issues/${n}`);
			return response.ok ? ((await response.json()) as { state?: string }).state : `HTTP ${response.status}`;
		}, [REPO, number] as [string, number]);
		if (state !== "closed") throw new Error(`issue state is ${String(state)}, not closed`);
	},
	`close ${REPO}#${number} manually`,
);
console.log(`origin: ${BASE}; screenshot: /tmp/canary-github-13.3.png`);
await context.close();
report(failures);
