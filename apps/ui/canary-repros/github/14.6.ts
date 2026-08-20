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
import { withVerifiedRestoration } from "../../scripts/canary-restoration";

const REPO = process.env.CANARY_DISPOSABLE_REPO ?? "";
const CHANGE = process.env.CANARY_FIXTURE_CHANGE_ID ?? "";
const LANDING = Number(process.env.CANARY_FIXTURE_LANDING_NUMBER ?? "");
const EXPECTED_TITLE = process.env.CANARY_FIXTURE_LANDING_TITLE ?? "";
if (REPO === "" || CHANGE === "" || !Number.isSafeInteger(LANDING) || LANDING <= 0 || EXPECTED_TITLE === "") {
	throw new Error(
		"CANARY_DISPOSABLE_REPO, CANARY_FIXTURE_CHANGE_ID, CANARY_FIXTURE_LANDING_NUMBER, and CANARY_FIXTURE_LANDING_TITLE are required",
	);
}
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

const repoResponse = await api(`/api/repos/${REPO}`);
if (repoResponse.status !== 200) throw new Error(`fixture repo could not be read: HTTP ${repoResponse.status}`);
const repoBefore = JSON.parse(repoResponse.body) as {
	landing_queue_required_checks?: string[];
};
const previousChecks = repoBefore.landing_queue_required_checks ?? [];
const failures: Array<string> = [];
await withVerifiedRestoration(
	async () => {
		const landingResponse = await api(`/api/repos/${REPO}/landings/${LANDING}`);
		if (landingResponse.status !== 200) throw new Error(`fixture landing could not be read: HTTP ${landingResponse.status}`);
		const landing = JSON.parse(landingResponse.body) as { title?: string; state?: string };
		if (landing.title !== EXPECTED_TITLE || landing.state !== "open") {
			throw new Error(`fixture fence failed: expected open "${EXPECTED_TITLE}", got ${JSON.stringify(landing)}`);
		}

		const patched = await api(`/api/repos/${REPO}`, "PATCH", { landing_queue_required_checks: [CHECK] });
		if (patched.status < 200 || patched.status >= 300) throw new Error(`required-check PATCH failed: HTTP ${patched.status}`);
		const status = await api(`/api/repos/${REPO}/statuses/${CHANGE}`, "POST", {
			context: CHECK,
			status: "failure",
			description: "canary repro 14.6 disposable fixture",
		});
		if (status.status < 200 || status.status >= 300) throw new Error(`fixture status write failed: HTTP ${status.status}`);

		const beforeCards = await page.locator("[data-kind]").count();
		const beforeLast = beforeCards > 0 ? await page.locator("[data-kind]").last().innerText() : "";
		const beforeText = await page.locator(".smithers-transcript").innerText();
		const composer = page.locator("textarea").last();
		await composer.click();
		await composer.fill(`/prs.land ${LANDING} ${REPO}`);
		await page.keyboard.press("Enter");
		const toasts = new Set<string>();
		for (let tick = 0; tick < 12; tick += 1) {
			await page.waitForTimeout(1500);
			for (const toast of await page.locator("[class*=toast]").allTextContents()) if (toast.trim() !== "") toasts.add(toast.trim());
		}
		const afterText = await page.locator(".smithers-transcript").innerText();
		const afterLast = (await page.locator("[data-kind]").count()) > 0 ? await page.locator("[data-kind]").last().innerText() : "";
		const platform = await api(`/api/repos/${REPO}/landings/${LANDING}/land`, "PUT");
		const named = [...toasts, afterText.slice(beforeText.length), afterLast].some((text) => text.includes(CHECK));
		if (platform.status >= 400 && !named) {
			failures.push(`/prs.land ${LANDING} was refused by the platform (${platform.status} ${platform.body.trim()}) and the app named no reason`);
		}
	},
	async () => {
		const restored = await api(`/api/repos/${REPO}`, "PATCH", { landing_queue_required_checks: previousChecks });
		if (restored.status < 200 || restored.status >= 300) throw new Error(`restore PATCH answered HTTP ${restored.status}`);
	},
	async () => {
		const restored = await api(`/api/repos/${REPO}`);
		if (restored.status !== 200) throw new Error(`restored repo could not be read: HTTP ${restored.status}`);
		const checks = (JSON.parse(restored.body) as { landing_queue_required_checks?: string[] }).landing_queue_required_checks ?? [];
		if (JSON.stringify(checks) !== JSON.stringify(previousChecks)) {
			throw new Error(`required checks are ${JSON.stringify(checks)}, expected ${JSON.stringify(previousChecks)}`);
		}
	},
	`restore landing_queue_required_checks on ${REPO} to ${JSON.stringify(previousChecks)}`,
);
await page.screenshot({ path: "/tmp/canary-github-14.6.png", fullPage: true });
console.log(`origin: ${BASE}; screenshot: /tmp/canary-github-14.6.png`);
await context.close();
report(failures);
