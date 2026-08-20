/*
 * Canary repro A.12 — /repos.watch.toggle <fullName> ACCEPTS a repository
 * that is not in the chooser. Toggling `no-such/repo` increments the
 * chooser's selected count instead of refusing, so the confirm button offers
 * to watch a repository the account does not have.
 *
 * Expected: an unknown full name is refused (the sibling /repos.watch flow
 *           already does exactly this: "I couldn't find no-such/repo among
 *           your repositories — the chooser is open with the ones I can see.")
 * Actual:   the selected count goes up by one and nothing is said.
 *
 *   bun apps/ui/canary-repros/flow-sweep/A.12.ts
 */
import { openApp, report } from "./_lib";

const count = (lines: ReadonlyArray<string>): number | undefined => {
	for (const line of lines) {
		const match = /^Watch (\d+) repositor/.exec(line);
		if (match !== null) return Number(match[1]);
	}
	return undefined;
};

const app = await openApp();
const failures: string[] = [];
try {
	await app.invoke("/chat", 3000);
	await app.invoke("/repos.watch", 8000);
	await app.invoke("/repos.watch.none", 4000);
	const before = count((await app.page.locator("body").innerText()).split("\n"));
	const outcome = await app.invoke("/repos.watch.toggle no-such/repo", 4000);
	const after = count((await app.page.locator("body").innerText()).split("\n"));
	console.log("selected before:", before, "after:", after, "added:", JSON.stringify(outcome.added));
	if (before !== undefined && after !== undefined && after > before) {
		failures.push(`/repos.watch.toggle no-such/repo raised the selection from ${before} to ${after}`);
	}
	if (!outcome.added.some((line) => line.includes("no-such/repo"))) {
		failures.push("/repos.watch.toggle no-such/repo never named the repository it could not find");
	}
} finally {
	await app.close();
}
report(failures);
