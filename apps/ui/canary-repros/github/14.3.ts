/*
 * Repro — checklist §14.3: "/prs.create <title> [from:<bookmark>] — with and
 * without the bookmark argument."
 *
 * Expected: with a valid from:<bookmark> a pull request is opened and the "pr"
 * card appears; without it, an honest message naming /branches.list.
 * Actual: BOTH forms are completely silent — no card, no transcript message,
 * no toast — and no landing is created on the platform. The seam does return
 * honest strings for both branches (LandingsSeam.createLanding), but a flow
 * typed WITH arguments goes through the composer's `send` path, which drops
 * the returned string (see 14.6.md for the shared root cause).
 *
 * Exits non-zero while the bug is present.
 *
 *   bun apps/ui/canary-repros/github/14.3.ts
 */
import { BASE, ensureSignedIn, open, report } from "./_lib";

const REPO = process.env.REPO ?? "codeplanesmithers/canary-sandbox";
const { context, page } = await open();
await ensureSignedIn(page);

const landings = async (): Promise<number> =>
	await page.evaluate(async (repo) => {
		const response = await fetch(`/api/repos/${repo}/landings`);
		const body = await response.json().catch(() => []);
		return Array.isArray(body) ? body.length : -1;
	}, REPO);

const bookmark = await page.evaluate(async (repo) => {
	const response = await fetch(`/api/repos/${repo}/bookmarks`);
	const body = (await response.json().catch(() => ({ items: [] }))) as { items?: Array<{ name: string }> };
	return (body.items ?? []).map((row) => row.name).find((name) => name !== "main") ?? "";
}, REPO);
console.log(`source bookmark under test: ${bookmark || "(none found)"}`);

const failures: Array<string> = [];

const attempt = async (line: string, label: string): Promise<void> => {
	const beforeCards = await page.locator("[data-kind]").count();
	const beforeLast = beforeCards > 0 ? await page.locator("[data-kind]").last().innerText() : "";
	const beforeText = await page.locator(".smithers-transcript").innerText();
	const beforeLandings = await landings();

	const composer = page.locator("textarea").last();
	await composer.click();
	await composer.fill(line);
	await page.waitForTimeout(400);
	await page.keyboard.press("Enter");
	const toasts = new Set<string>();
	for (let tick = 0; tick < 11; tick += 1) {
		await page.waitForTimeout(1500);
		for (const toast of await page.locator("[class*=toast]").allTextContents()) {
			if (toast.trim() !== "") toasts.add(toast.trim());
		}
	}

	const afterCards = await page.locator("[data-kind]").count();
	const afterLast = afterCards > 0 ? await page.locator("[data-kind]").last().innerText() : "";
	const afterText = await page.locator(".smithers-transcript").innerText();
	const afterLandings = await landings();

	const openedOne = afterLandings > beforeLandings;
	const saidSomething =
		afterCards !== beforeCards || afterLast !== beforeLast || afterText.length !== beforeText.length || toasts.size > 0;
	console.log(
		`${label}: landings ${beforeLandings}->${afterLandings}, cards ${beforeCards}->${afterCards}, transcript ${beforeText.length}->${afterText.length}, toasts ${JSON.stringify([...toasts].slice(-2))}`,
	);
	if (!openedOne && !saidSomething) failures.push(`${label} — "${line}" opened no pull request and said nothing at all`);
};

await attempt(`/prs.create Canary repro 14.3 with bookmark from:${bookmark} ${REPO}`, "with from:<bookmark>");
await attempt(`/prs.create Canary repro 14.3 without bookmark ${REPO}`, "without from:<bookmark>");

await page.screenshot({ path: "/tmp/canary-github-14.3.png", fullPage: true });
console.log(`origin: ${BASE}; screenshot: /tmp/canary-github-14.3.png`);
await context.close();
report(failures);
