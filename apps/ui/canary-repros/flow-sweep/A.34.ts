/*
 * Canary repro A.34 — /world.delete deletes a note with NO confirmation and
 * answers nothing at all when the document id is wrong.
 *
 * Expected: §10.6 — the confirm dialog names the note's title, cancel is
 *           clean, and a bogus document id is refused out loud.
 * Actual:   the note is removed immediately with no dialog (0 [role=dialog]
 *           nodes) and a bogus id renders nothing.
 *
 *   bun apps/ui/canary-repros/flow-sweep/A.34.ts
 */
import { openApp, report } from "./_lib";

const app = await openApp();
const failures: string[] = [];
try {
	// Record the document id world.new-note mints, by stack frame.
	await app.page.evaluate(() => {
		const w = window as unknown as { __docs: string[] };
		w.__docs = [];
		const original = crypto.randomUUID.bind(crypto);
		Object.defineProperty(crypto, "randomUUID", {
			value: () => {
				const value = original();
				if (((new Error().stack ?? "").split("\n")[2] ?? "").includes("createWorldDocument")) w.__docs.push(value);
				return value;
			},
			configurable: true,
		});
	});
	await app.invoke("/chat", 3000);
	await app.invoke("/world", 5000);
	await app.invoke("/world.new-note", 4000);
	const docs = await app.page.evaluate(() => (window as unknown as { __docs: string[] }).__docs.slice());
	const id = docs[docs.length - 1] ?? "";
	console.log("document id:", id);

	const bogus = await app.invoke("/world.delete not-a-document-id", 4000);
	console.log("bogus id added:", JSON.stringify(bogus.added));
	if (bogus.added.length === 0) failures.push("/world.delete with an unknown document id rendered nothing");

	const notesBefore = ((await app.page.locator("body").innerText()).match(/Untitled \d+/g) ?? []).length;
	await app.invoke(`/world.delete ${id}`, 4500);
	const dialogs = await app.page.locator('[role="dialog"]').count();
	const notesAfter = ((await app.page.locator("body").innerText()).match(/Untitled \d+/g) ?? []).length;
	console.log("dialogs:", dialogs, "notes before:", notesBefore, "after:", notesAfter);
	if (dialogs === 0) failures.push("/world.delete showed no confirmation dialog before deleting");
} finally {
	await app.close();
}
report(failures);
