/*
 * Canary repro A.46 — /issues.list: a failing invocation with arguments is
 * SILENT. The composer accepts it, the seam runs and refuses, and NOTHING
 * reaches the screen: no card, no chat message, no toast.
 *
 * Expected: an unreadable repository is named in an honest refusal.
 * Actual:   zero new rendered lines.
 *
 * Root cause (shared by every arg-taking flow): `send()` in
 * apps/ui/src/mainview/state/AppController.ts:2317 runs the flow as
 * `void commands.run(parsed.name, parsed.args)` and DISCARDS the
 * CommandOutcome. The button path (`runCommand`/`runCommandArgs`, same file
 * ~4363/4369) attaches `surfaceCommandFailure`, which toasts
 * "/<name> didn't run" plus the seam's honest reason. Typing `/<name> <args>`
 * closes the slash menu (the menu only matches a bare name), so Enter goes
 * through `send()` and the refusal is dropped on the floor.
 *
 *   bun apps/ui/canary-repros/flow-sweep/A.46.ts
 */
import { openApp, report } from "./_lib";

const app = await openApp();
const failures: string[] = [];
try {
	const outcome = await app.invoke("/issues.list open codeplanesmithers/no-such-repo-zz", 9000);
	console.log("net:", outcome.net.join(" | ") || "(no /api/ traffic)");
	console.log("added lines:", JSON.stringify(outcome.added));
	const honest = outcome.added.filter(
		(line) =>
			line.toLowerCase().includes("no-such-repo-zz".toLowerCase()) ||
			/couldn't|could not|didn't run|not found|no such|isn't|is not|needs |refus/i.test(line),
	);
	console.log("honest lines:", JSON.stringify(honest));
	if (honest.length === 0) {
		failures.push(
			"/issues.list with a failing argument rendered no honest response — expected an unreadable repository is named in an honest refusal",
		);
	}
} finally {
	await app.close();
}
report(failures);
