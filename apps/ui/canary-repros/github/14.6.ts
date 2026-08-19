/*
 * Repro — checklist §14.6: "Land a PR that cannot merge (conflicts, failing
 * required checks): honest refusal naming the reason."
 *
 * The script sets a required check on the repo, opens a landing, marks that
 * check failed, and runs /prs.land. The platform refuses correctly —
 *   PUT /api/repos/<repo>/landings/<n>/land  ->  422
 *   {"message":"required status checks are not passing: ci/canary-required"}
 * — but the product surfaces NOTHING: the card stays OPEN, no message is
 * appended and no toast appears. The user cannot tell the land was refused.
 *
 * Shared root cause with 13.4 / 14.3 / 14.4: AppController.surfaceCommandFailure
 * toasts the failure only for the argument-less `runCommand` path used by the
 * slash menu. A flow typed WITH arguments is submitted through the composer's
 * `send` flow, and the inner flow's returned error string is dropped there.
 * Verified side by side: bare `/prs.land` (slash menu) DOES toast
 * "/prs.land didn't run — prs.land needs a pull request number", while
 * `/prs.land 3 owner/repo` is silent.
 *
 * The script restores landing_queue_required_checks to its previous value.
 *
 * Exits non-zero while the bug is present.
 *
 *   bun apps/ui/canary-repros/github/14.6.ts
 */
import { BASE, ensureSignedIn, open, report } from "./_lib";

const REPO = process.env.REPO ?? "codeplanesmithers/canary-sandbox";
const CHECK = "ci/canary-required";
const { context, page } = await open();
await ensureSignedIn(page);

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

const repoBefore = JSON.parse((await api(`/api/repos/${REPO}`)).body) as {
	landing_queue_required_checks?: string[];
};
const previousChecks = repoBefore.landing_queue_required_checks ?? [];

await api(`/api/repos/${REPO}`, "PATCH", { landing_queue_required_checks: [CHECK] });

/* Any change id will do as the landing's tip; take the newest one. */
const change = JSON.parse((await api(`/api/repos/${REPO}/changes?limit=5`)).body).items[0].change_id as string;
const created = await api(`/api/repos/${REPO}/landings`, "POST", {
	title: `Canary repro 14.6 unmergeable ${Date.now()}`,
	body: "",
	source_bookmark: "main",
	target_bookmark: "main",
	change_ids: [change],
});
const number = JSON.parse(created.body).number as number;
await api(`/api/repos/${REPO}/statuses/${change}`, "POST", {
	context: CHECK,
	status: "failure",
	description: "canary repro 14.6",
});
console.log(`landing ${REPO}#${number} on change ${change}, required check ${CHECK} = failure`);

const beforeCards = await page.locator("[data-kind]").count();
const beforeLast = beforeCards > 0 ? await page.locator("[data-kind]").last().innerText() : "";
const beforeText = await page.locator(".smithers-transcript").innerText();

const composer = page.locator("textarea").last();
await composer.click();
await composer.fill(`/prs.land ${number} ${REPO}`);
await page.waitForTimeout(400);
await page.keyboard.press("Enter");
const toasts = new Set<string>();
for (let tick = 0; tick < 12; tick += 1) {
	await page.waitForTimeout(1500);
	for (const toast of await page.locator("[class*=toast]").allTextContents()) {
		if (toast.trim() !== "") toasts.add(toast.trim());
	}
}
const afterText = await page.locator(".smithers-transcript").innerText();
const afterLast =
	(await page.locator("[data-kind]").count()) > 0 ? await page.locator("[data-kind]").last().innerText() : "";

const platform = await api(`/api/repos/${REPO}/landings/${number}/land`, "PUT");
console.log(`platform PUT land -> ${platform.status} ${platform.body.trim()}`);
console.log(`transcript ${beforeText.length}->${afterText.length}, lastCardChanged=${afterLast !== beforeLast}`);
console.log(`toasts: ${JSON.stringify([...toasts].slice(-2))}`);

const failures: Array<string> = [];
const named = [...toasts, afterText.slice(beforeText.length), afterLast].some((text) =>
	new RegExp(CHECK.replace("/", "\\/")).test(text ?? ""),
);
if (platform.status >= 400 && !named) {
	failures.push(
		`/prs.land ${number} was refused by the platform (${platform.status} ${platform.body.trim()}) and the app named no reason — card unchanged, no message, no toast`,
	);
}

await api(`/api/repos/${REPO}`, "PATCH", { landing_queue_required_checks: previousChecks });
console.log(`restored landing_queue_required_checks to ${JSON.stringify(previousChecks)}`);
await page.screenshot({ path: "/tmp/canary-github-14.6.png", fullPage: true });
console.log(`origin: ${BASE}; screenshot: /tmp/canary-github-14.6.png`);
await context.close();
report(failures);
