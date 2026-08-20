/*
 * Repro — checklist §13.4: "/issues.view on a number that does not exist."
 *
 * Expected: an honest message. IssuesSeam.showIssue returns exactly that string
 * for a 404 ("Issue #<n> in <repo> answered 404. …run /repos.import <repo>").
 * Actual: nothing is surfaced. No card is added, no transcript message is
 * appended, and no toast is raised — the flow is a silent no-op, while the
 * network tab shows the 404. /prs.view on a missing number behaves the same.
 *
 * Exits non-zero while the bug is present.
 *
 *   cp -R ~/.multi-e2e-profile /tmp/canary-github-profile
 *   bun apps/ui/canary-repros/github/13.4.ts
 */
import { BASE, ensureSignedIn, open, report } from "./_lib";

const { context, page } = await open();
await ensureSignedIn(page);

const failures: Array<string> = [];

const probe = async (line: string, label: string): Promise<void> => {
	const beforeCards = await page.locator("[data-kind]").count();
	const beforeLast = beforeCards > 0 ? await page.locator("[data-kind]").last().innerText() : "";
	const beforeText = await page.locator(".smithers-transcript").innerText();

	const composer = page.locator("textarea").last();
	await composer.click();
	await composer.fill(line);
	await page.waitForTimeout(400);
	await page.keyboard.press("Enter");

	/* Sample continuously: a toast that appeared and auto-dismissed still counts
	 * as the product having said something. */
	const toasts = new Set<string>();
	for (let tick = 0; tick < 10; tick += 1) {
		await page.waitForTimeout(1500);
		for (const text of await page.locator("[class*=toast]").allTextContents()) {
			if (text.trim() !== "") toasts.add(text.trim());
		}
	}

	const afterCards = await page.locator("[data-kind]").count();
	const afterLast = afterCards > 0 ? await page.locator("[data-kind]").last().innerText() : "";
	const afterText = await page.locator(".smithers-transcript").innerText();

	const saidSomething =
		afterCards !== beforeCards ||
		afterLast !== beforeLast ||
		afterText.length !== beforeText.length ||
		[...toasts].some((toast) => /404|doesn't exist|does not exist|not found|didn't run/i.test(toast));

	console.log(
		`${label}: cards ${beforeCards}->${afterCards}, transcript ${beforeText.length}->${afterText.length} chars, toasts ${JSON.stringify([...toasts].slice(-2))}`,
	);
	if (!saidSomething) failures.push(`${label} — "${line}" produced no card, no message and no toast`);
};

await probe("/issues.view 99999 codeplanesmithers/canary-sandbox", "issues.view missing number");
await probe("/prs.view 99999 codeplanesmithers/canary-sandbox", "prs.view missing number");

await page.screenshot({ path: "/tmp/canary-github-13.4.png", fullPage: true });
console.log(`origin: ${BASE}; screenshot: /tmp/canary-github-13.4.png`);
await context.close();
report(failures);
