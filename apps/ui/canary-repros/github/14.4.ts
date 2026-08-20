/*
 * Repro — checklist §14.4: "/prs.review <n> approve|request-changes|comment
 * [text] — all three verbs."
 *
 * comment and request-changes work. `approve` on a landing the signed-in user
 * authored is refused by the platform with a real reason —
 *   POST /api/repos/<repo>/landings/<n>/reviews  ->  422
 *   {"message":"author cannot approve their own landing request"}
 * — and the product says NOTHING: the card is unchanged, no transcript message
 * is appended, no toast is raised. The user is left believing the approval
 * landed.
 *
 * Exits non-zero while the bug is present.
 *
 *   bun apps/ui/canary-repros/github/14.4.ts
 */
import { BASE, ensureSignedIn, open, report } from "./_lib";

const REPO = process.env.CANARY_DISPOSABLE_REPO ?? "";
const number = Number(process.env.CANARY_FIXTURE_LANDING_NUMBER ?? "");
const expectedTitle = process.env.CANARY_FIXTURE_LANDING_TITLE ?? "";
if (REPO === "" || !Number.isSafeInteger(number) || number <= 0 || expectedTitle === "") {
	throw new Error("CANARY_DISPOSABLE_REPO, CANARY_FIXTURE_LANDING_NUMBER, and CANARY_FIXTURE_LANDING_TITLE are required");
}
const { context, page } = await open();
await ensureSignedIn(page);

const fixture = await page.evaluate(async ([repo, n]: [string, number]) => {
	const response = await fetch(`/api/repos/${repo}/landings/${n}`);
	return { status: response.status, body: await response.json().catch(() => null) };
}, [REPO, number] as [string, number]);
if (fixture.status !== 200 || fixture.body?.title !== expectedTitle || fixture.body?.state !== "open") {
	throw new Error(`fixture fence failed: expected open "${expectedTitle}", got ${JSON.stringify(fixture)}`);
}
console.log(`landing under test: ${REPO}#${number}`);

const failures: Array<string> = [];

const verb = async (type: "comment" | "request-changes" | "approve"): Promise<void> => {
	const marker = `uicanaries-14.4-${type}-${Date.now()}`;
	const beforeCards = await page.locator("[data-kind]").count();
	const beforeLast = beforeCards > 0 ? await page.locator("[data-kind]").last().innerText() : "";
	const beforeText = await page.locator(".smithers-transcript").innerText();
	const composer = page.locator("textarea").last();
	await composer.click();
	await composer.fill(`/prs.review ${number} ${type} ${marker} ${REPO}`);
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
	const said =
		afterCards !== beforeCards || afterLast !== beforeLast || afterText.length !== beforeText.length || toasts.size > 0;
	const reviews = await page.evaluate(async ([repo, n]: [string, number]) => {
		const response = await fetch(`/api/repos/${repo}/landings/${n}/reviews?limit=100`);
		return { status: response.status, body: await response.json().catch(() => null) };
	}, [REPO, number] as [string, number]);
	const persisted = reviews.status === 200 && JSON.stringify(reviews.body).includes(marker);
	const surfaced = [...toasts, afterText.slice(beforeText.length), afterLast].join("\n");
	const honestRefusal = /couldn't|didn't|cannot|refus|failed|author/i.test(surfaced);
	console.log(`${type}: persisted=${persisted}, changed=${said}, refusal=${honestRefusal}`);
	if (!persisted && !honestRefusal) failures.push(`${type} neither persisted an exact review nor surfaced an honest refusal`);
};

await verb("comment");
await verb("request-changes");
await verb("approve");

await page.screenshot({ path: "/tmp/canary-github-14.4.png", fullPage: true });
console.log(`origin: ${BASE}; screenshot: /tmp/canary-github-14.4.png`);
await context.close();
report(failures);
