/*
 * Canary repro A.54 — /prs.create is a total no-op. Every form of the
 * invocation (missing `from:`, unknown bookmark, unwatched repo, valid
 * bookmark) renders NOTHING: no pull-request card, no chat message, no toast.
 * The success path was never observed on canary.
 *
 * Expected: `/prs.create <title> from:<bookmark> [owner/repo]` opens the pull
 *           request and surfaces the same `pr` card `/prs.view` lands on; a
 *           bad form is refused with the seam's own honest line (e.g.
 *           "prs.create needs a source branch — run /branches.list, then
 *           /prs.create <title> from:<bookmark>").
 * Actual:   zero rendered lines in all four forms.
 *
 * Root cause: the refusals `createLandingsSeam.createLanding`
 * (apps/ui/src/mainview/state/seams/LandingsSeam.ts:341) returns are dropped
 * by `send()` in apps/ui/src/mainview/state/AppController.ts:2317, which runs
 * the flow as `void commands.run(name, args)` and discards the outcome.
 *
 *   bun apps/ui/canary-repros/flow-sweep/A.54.ts
 */
import { openApp, report } from "./_lib";

const app = await openApp();
const failures: string[] = [];
try {
	const forms = [
		"/prs.create flow-sweep repro title-only codeplanesmithers/canary-sandbox",
		"/prs.create flow-sweep repro from:no-such-bookmark-zz codeplanesmithers/canary-sandbox",
		"/prs.create flow-sweep repro from:main codeplanesmithers/no-such-repo-zz",
		"/prs.create flow-sweep repro from:codeplanesmithers-patch-1 codeplanesmithers/canary-sandbox",
	];
	for (const form of forms) {
		const outcome = await app.invoke(form, 14000);
		console.log(`${form}\n  net: ${outcome.net.join(" | ") || "(none)"}\n  added: ${JSON.stringify(outcome.added)}`);
		if (outcome.added.length === 0) failures.push(`${form} rendered nothing at all`);
	}
} finally {
	await app.close();
}
report(failures);
