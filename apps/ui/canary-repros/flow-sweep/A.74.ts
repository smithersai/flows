/*
 * Canary repro A.74–A.77 — the four debug READS (/debug.snapshot,
 * /debug.events, /debug.chain, /debug.net) render nothing for the human.
 * Each handler returns `{ value }` — the payload the agent boundary hands to
 * the model — and values never render in the transcript (§2b), so typing the
 * flow produces no card, no message, and no toast. Opening the dev-tools
 * panel first does not help: the only trace is the `command.ran` row in the
 * transition log.
 *
 * Expected: §26.2–§26.5 — each one "reads" its surface for the human.
 * Actual:   a silent no-op on the target origin.
 *
 * This file covers A.74, A.75, A.76 and A.77 (A.75.ts, A.76.ts and A.77.ts
 * re-export it). Requires an admin session: the flows only register when
 * /api/auth/session answers admin:true.
 *
 *   bun apps/ui/canary-repros/flow-sweep/A.74.ts
 */
import { openApp, report } from "./_lib";

const app = await openApp();
const failures: string[] = [];
try {
	const session = await app.page.evaluate(async () => (await fetch("/api/auth/session")).text());
	if (!session.includes('"admin":true')) {
		throw new Error(`this repro needs an admin session; /api/auth/session says ${session}`);
	}
	await app.invoke("/chat", 3000);
	// With the dev-tools panel open, so "it renders in the panel" is ruled out.
	await app.invoke("/admin.devtools", 4000);
	for (const flow of ["/debug.snapshot", "/debug.events", "/debug.chain", "/debug.net"]) {
		const outcome = await app.invoke(flow, 4500);
		// The transition log grows on every dispatch; ignore its rows.
		const meaningful = outcome.added.filter(
			(line) => !/^#\d+ /.test(line) && !/^transitions \d+ rows$/.test(line) && line.trim() !== "",
		);
		console.log(`${flow} -> ${JSON.stringify(meaningful)}`);
		if (meaningful.length === 0) failures.push(`${flow} rendered no reading at all`);
	}
	await app.invoke("/admin.devtools", 3000);
} finally {
	await app.close();
}
report(failures);
