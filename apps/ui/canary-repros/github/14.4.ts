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

const REPO = process.env.REPO ?? "codeplanesmithers/canary-sandbox";
const { context, page } = await open();
await ensureSignedIn(page);

/* Pick any open landing; create one only if the repo has none. */
const number = await page.evaluate(async (repo) => {
	const response = await fetch(`/api/repos/${repo}/landings`);
	const body = (await response.json().catch(() => [])) as Array<{ number: number; state: string }>;
	const open = Array.isArray(body) ? body.find((row) => row.state === "open") : undefined;
	return open?.number ?? 0;
}, REPO);
if (number === 0) {
	console.error(`no open landing in ${REPO} — seed one before running this repro`);
	process.exit(2);
}
console.log(`landing under test: ${REPO}#${number}`);

/* The platform's own answer, so the refusal the UI must relay is on the record. */
const direct = await page.evaluate(
	async ([repo, n]: [string, number]) => {
		const response = await fetch(`/api/repos/${repo}/landings/${n}/reviews`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "approve", body: "canary repro 14.4 direct" }),
		});
		return { status: response.status, body: (await response.text()).trim() };
	},
	[REPO, number] as [string, number],
);
console.log(`platform POST reviews (approve) -> ${direct.status} ${direct.body}`);

const failures: Array<string> = [];

const verb = async (line: string, label: string): Promise<{ said: boolean }> => {
	const beforeCards = await page.locator("[data-kind]").count();
	const beforeLast = beforeCards > 0 ? await page.locator("[data-kind]").last().innerText() : "";
	const beforeText = await page.locator(".smithers-transcript").innerText();
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
	const said =
		afterCards !== beforeCards || afterLast !== beforeLast || afterText.length !== beforeText.length || toasts.size > 0;
	console.log(`${label}: changed=${said}, toasts=${JSON.stringify([...toasts].slice(-2))}`);
	return { said };
};

await verb(`/prs.review ${number} comment canary repro 14.4 comment ${REPO}`, "comment");
await verb(`/prs.review ${number} request-changes canary repro 14.4 request-changes ${REPO}`, "request-changes");
const approve = await verb(`/prs.review ${number} approve canary repro 14.4 approve ${REPO}`, "approve");

if (direct.status >= 400 && !approve.said) {
	failures.push(
		`/prs.review ${number} approve was refused by the platform (${direct.status} ${direct.body}) and the app surfaced nothing — no card change, no message, no toast`,
	);
}

await page.screenshot({ path: "/tmp/canary-github-14.4.png", fullPage: true });
console.log(`origin: ${BASE}; screenshot: /tmp/canary-github-14.4.png`);
await context.close();
report(failures);
