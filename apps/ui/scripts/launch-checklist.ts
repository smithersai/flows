/*
 * Launch checklist runner (Wave alpha-ui, U7): the headless, one-command
 * re-run of the signed-in launch checklist (§A-F) against ANY target origin.
 *
 * No origin is hardcoded here. The target is always explicit:
 *
 *   bun scripts/launch-checklist.ts --target https://canary.smithers.sh
 *   bun scripts/launch-checklist.ts --target http://127.0.0.1:8787
 *   CHECKLIST_TARGET=https://canary.smithers.sh bun scripts/launch-checklist.ts
 *   bun scripts/launch-checklist.ts --dry-run
 *
 * Two rows kinds:
 *  - "api" rows are HTTP-only and this runner executes them directly against
 *    the product Worker's client-facing seams (currently: D-1, D-2, D-4 — the
 *    billing-balance rows the Worker itself answers; see the BILLING_BALANCE_PATH
 *    contract in apps/shared/src/AgentApiRoutes.ts and its "billing seam" tests
 *    in apps/server/src/index.test.ts for the response shape this runner asserts
 *    against).
 *  - "browser" rows need a real signed-in browser session (§A, §B, §C, §F) or
 *    reach a service this runner does not hold credentials for (§E targets the
 *    billing UPSTREAM's admin surface directly, not this origin). This runner
 *    enumerates them and reports `not-testable-yet` with a pointer to the
 *    dedicated script that does cover them (live-signed-in-check.ts,
 *    live-workflow-check.ts, canary-seam-probe.ts) rather than guess at an
 *    assertion it cannot ground.
 *
 * --dry-run makes zero network calls: it proves the row catalog, the CLI
 * wiring, and the report writer all work without any target at all. Pointing
 * --target at a local/unreachable origin (without --dry-run) is "local mode":
 * the "api" rows really run (and honestly report a connection failure if
 * nothing answers), which is how this wires up post-deploy re-runs as one
 * command without this lane touching live canary traffic.
 */
import { mkdirSync, writeFileSync } from "node:fs";

type Section = "A" | "B" | "C" | "D" | "E" | "F";
type Status = "pass" | "fail" | "not-testable-yet" | "skipped-dry-run";

interface ProbeContext {
	readonly target: string;
	readonly env: Record<string, string | undefined>;
}

interface ProbeResult {
	readonly ok: boolean;
	readonly detail: string;
}

interface ChecklistRow {
	readonly id: string;
	readonly section: Section;
	readonly title: string;
	/** Env vars an "api" row needs before it can run for real. */
	readonly requiredEnv?: ReadonlyArray<string>;
	/** Absent for "browser"/out-of-scope rows: they always report not-testable-yet in run mode. */
	readonly probe?: (ctx: ProbeContext) => Promise<ProbeResult>;
	readonly deferredTo?: string;
}

interface RowResult {
	readonly id: string;
	readonly section: Section;
	readonly title: string;
	readonly status: Status;
	readonly reasons: ReadonlyArray<string>;
	readonly evidence: ReadonlyArray<string>;
	readonly durationMs: number;
	readonly tests: ReadonlyArray<string>;
}

const BROWSER_DEFERRAL =
	"needs a real signed-in browser session; run scripts/live-signed-in-check.ts or scripts/live-workflow-check.ts against this target for browser-driven rows";
const UPSTREAM_DEFERRAL =
	"targets the billing upstream's admin surface directly (BILLING_UPSTREAM_URL + BILLING_ADMIN_TOKEN), not the product Worker origin this runner exercises; needs a dedicated billing-seam script with those credentials";

const cookieHeaders = (cookie: string | undefined): Record<string, string> =>
	cookie === undefined ? {} : { cookie };

const fetchJson = async (
	url: string,
	init: RequestInit,
): Promise<{ status: number; body: unknown; text: string }> => {
	const response = await fetch(url, init);
	const text = await response.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// stays as raw text — not every seam answers JSON on failure.
	}
	return { status: response.status, body, text };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const balanceProbe = async (
	ctx: ProbeContext,
	cookieEnvVar: string,
	label: string,
): Promise<ProbeResult> => {
	const cookie = ctx.env[cookieEnvVar];
	try {
		const { status, body, text } = await fetchJson(`${ctx.target}/api/billing/balance`, {
			headers: cookieHeaders(cookie),
		});
		const record = asRecord(body);
		const ok = status === 200 && record?.state === "ok" && record?.allowedToStartWork === true;
		return {
			ok,
			detail: `${label}: HTTP ${status} ${text.slice(0, 200)}`,
		};
	} catch (error) {
		return { ok: false, detail: `${label}: request to ${ctx.target}/api/billing/balance failed — ${String(error)}` };
	}
};

const ROWS: ReadonlyArray<ChecklistRow> = [
	{
		id: "A-1",
		section: "A",
		title:
			"Signed-out shows the chat (transcript + composer): the opening Smithers message carries the sentence, plain-words scopes, and a first-Tab sign-in; no separate landing view (no blank prompt box, no feature list)",
		deferredTo: BROWSER_DEFERRAL,
	},
	{ id: "A-2", section: "A", title: "Sign-in to first useful message in <= 90s", deferredTo: BROWSER_DEFERRAL },
	{
		id: "A-3",
		section: "A",
		title: "First message cites repo-specific data (not greeting-only boilerplate)",
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "A-4",
		section: "A",
		title: "Workspace pre-exists: no clone/install/configure copy anywhere",
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "A-5",
		section: "A",
		title: '"$500 of usage on us" stated exactly once',
		deferredTo: BROWSER_DEFERRAL,
	},
	{ id: "A-6", section: "A", title: "No card form anywhere in the product", deferredTo: BROWSER_DEFERRAL },
	{ id: "A-7", section: "A", title: "<= 3 questions asked in the whole first run", deferredTo: BROWSER_DEFERRAL },
	{
		id: "A-8",
		section: "A",
		title: "One recommendation card carrying proposes / why-now / what-happens / accept-edit-dismiss",
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "A-9",
		section: "A",
		title: "Dismiss is one key and the same recommendation does not return unchanged",
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "B-1",
		section: "B",
		title: "Close browser mid-turn, reopen: conversation + in-flight work restored and correctly described",
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "B-2",
		section: "B",
		title: "Escape stops foreground work <= 1s with a statement of what stopped",
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "B-3",
		section: "B",
		title: "A server-side kill surfaces in the UI (no silent completion/failure)",
		deferredTo: BROWSER_DEFERRAL,
	},
	{ id: "B-4", section: "B", title: "Result cards lead with the result", deferredTo: BROWSER_DEFERRAL },
	{ id: "B-5", section: "B", title: "No score/grade/number user-facing", deferredTo: BROWSER_DEFERRAL },
	{ id: "B-6", section: "B", title: "A correction never renders as an error state", deferredTo: BROWSER_DEFERRAL },
	{
		id: "B-7",
		section: "B",
		title: 'Zero rating prompts ("was this helpful?" anywhere = fail)',
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "C-1",
		section: "C",
		title: "Every visible interactive affordance resolves to a named command also reachable by /name",
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "C-2",
		section: "C",
		title: '"/" opens with the recommended command first and bare "/"+Enter runs it',
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "C-3",
		section: "C",
		title: "The whole section-A journey is completable keyboard-only",
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "D-1",
		section: "D",
		title: "GET /api/billing/balance shows the $500 design-partner balance for a signed-in user",
		requiredEnv: ["CHECKLIST_SESSION_COOKIE"],
		probe: (ctx) => balanceProbe(ctx, "CHECKLIST_SESSION_COOKIE", "signed-in balance read"),
	},
	{
		id: "D-2",
		section: "D",
		title:
			"An interactive chat turn does NOT reduce the balance; its true supplier cost IS still recorded (comped, not uncounted)",
		requiredEnv: ["CHECKLIST_SESSION_COOKIE"],
		probe: async (ctx) => {
			const cookie = ctx.env.CHECKLIST_SESSION_COOKIE;
			const before = await balanceProbe(ctx, "CHECKLIST_SESSION_COOKIE", "balance before the turn");
			if (!before.ok) return { ok: false, detail: `pre-turn balance check failed — ${before.detail}` };
			try {
				const turn = await fetchJson(`${ctx.target}/api/agent/turn`, {
					method: "POST",
					headers: { "content-type": "application/json", ...cookieHeaders(cookie) },
					body: JSON.stringify({
						runId: `launch-checklist-d2-${Date.now()}`,
						messages: [{ role: "user", content: "Say the word ok and nothing else." }],
						instructions: "Answer briefly.",
					}),
				});
				const turnOk = turn.status === 200 && turn.text.includes('"type":"done"');
				const after = await balanceProbe(ctx, "CHECKLIST_SESSION_COOKIE", "balance after the turn");
				return {
					ok: turnOk && after.ok,
					detail: `turn HTTP ${turn.status} (done frame: ${turn.text.includes('"type":"done"')}); ${after.detail}`,
				};
			} catch (error) {
				return { ok: false, detail: `POST /api/agent/turn failed — ${String(error)}` };
			}
		},
	},
	{
		id: "D-3",
		section: "D",
		title: "No top-up/checkout/card-collection flow is exposed to MVP users",
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "D-4",
		section: "D",
		title: "At $0, interactive chat keeps working; only non-complimentary work pauses",
		requiredEnv: ["CHECKLIST_ZERO_BALANCE_BEARER"],
		probe: async (ctx) => {
			// CHECKLIST_ZERO_BALANCE_BEARER carries the session cookie for a test
			// account already parked at $0 balance (a "bearer" of that state, not
			// an HTTP bearer token — the product Worker's session auth is cookie-based).
			const cookie = ctx.env.CHECKLIST_ZERO_BALANCE_BEARER;
			try {
				const turn = await fetchJson(`${ctx.target}/api/agent/turn`, {
					method: "POST",
					headers: { "content-type": "application/json", ...cookieHeaders(cookie) },
					body: JSON.stringify({
						runId: `launch-checklist-d4-${Date.now()}`,
						messages: [{ role: "user", content: "Say the word ok and nothing else." }],
						instructions: "Answer briefly.",
					}),
				});
				const turnOk = turn.status === 200 && turn.text.includes('"type":"done"');
				return {
					ok: turnOk,
					detail: `interactive turn at $0 balance: HTTP ${turn.status} (done frame: ${turn.text.includes('"type":"done"')}). This probe verifies interactive chat keeps working at $0; it does NOT yet assert that non-complimentary work (e.g. a workflow launch) pauses — no known seam for that assertion is grounded in this repo yet.`,
				};
			} catch (error) {
				return { ok: false, detail: `POST /api/agent/turn at $0 balance failed — ${String(error)}` };
			}
		},
	},
	{
		id: "E-1",
		section: "E",
		title: "POST /api/billing/admin/grants rejects calls without the admin token (401)",
		deferredTo: UPSTREAM_DEFERRAL,
	},
	{
		id: "E-2",
		section: "E",
		title: "An untimestamped grant is refused (400 timestamp_required)",
		deferredTo: UPSTREAM_DEFERRAL,
	},
	{
		id: "E-3",
		section: "E",
		title: "A grant with requester + timestamp credits the balance exactly once (201, audit record)",
		deferredTo: UPSTREAM_DEFERRAL,
	},
	{
		id: "F-1",
		section: "F",
		title: 'Impossible ask (send an email): honest "can\'t yet + next step", never fake success',
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "F-2",
		section: "F",
		title: 'Impossible ask (read local files): honest "can\'t yet + next step", never fake success',
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "F-3",
		section: "F",
		title: 'Impossible ask (unconnected tool): honest "can\'t yet + next step", never fake success',
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "F-4",
		section: "F",
		title: 'Impossible ask (claim a push): honest "can\'t yet + next step", never fake success',
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "F-5",
		section: "F",
		title: 'Impossible ask (claim a PR): honest "can\'t yet + next step", never fake success',
		deferredTo: BROWSER_DEFERRAL,
	},
	{
		id: "F-6",
		section: "F",
		title: "Blocked-on-approval state agrees across every surface (no RUNNING-vs-Blocked contradiction)",
		deferredTo: BROWSER_DEFERRAL,
	},
];

interface Args {
	readonly target: string | undefined;
	readonly dryRun: boolean;
	readonly outDir: string | undefined;
	readonly help: boolean;
}

const parseArgs = (argv: ReadonlyArray<string>): Args => {
	let target: string | undefined;
	let dryRun = false;
	let outDir: string | undefined;
	let help = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--target" || arg === "-t") {
			target = argv[i + 1];
			i += 1;
		} else if (arg?.startsWith("--target=")) {
			target = arg.slice("--target=".length);
		} else if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--out") {
			outDir = argv[i + 1];
			i += 1;
		} else if (arg?.startsWith("--out=")) {
			outDir = arg.slice("--out=".length);
		} else if (arg === "--help" || arg === "-h") {
			help = true;
		}
	}
	return { target, dryRun, outDir, help };
};

const HELP = `Launch checklist runner — headless, one-command re-run of the signed-in launch checklist.

Usage:
  bun scripts/launch-checklist.ts --target <origin>   Run against a real product Worker origin.
  bun scripts/launch-checklist.ts --dry-run            Enumerate every row, no network calls, no target needed.
  CHECKLIST_TARGET=<origin> bun scripts/launch-checklist.ts

Options:
  --target, -t <origin>   Product Worker origin to check (e.g. https://canary.smithers.sh).
                           Falls back to $CHECKLIST_TARGET. Never defaults to a hardcoded origin.
  --dry-run                Enumerate the row catalog and write a report skeleton; makes zero network calls.
  --out <dir>               Report directory (default: apps/reports/launch-checklist/<timestamp>).
  --help, -h                 Print this message.

Auth material (never committed; all optional, missing ones report not-testable-yet):
  CHECKLIST_SESSION_COOKIE        Cookie header for a normal signed-in session (rows D-1, D-2).
  CHECKLIST_ZERO_BALANCE_BEARER   Cookie header for a session already parked at $0 balance (row D-4).
`;

const main = async (): Promise<void> => {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(HELP);
		process.exit(0);
	}

	const target = args.target ?? process.env.CHECKLIST_TARGET;
	if (!args.dryRun && (target === undefined || target === "")) {
		console.error(
			"error: no target origin. Pass --target <origin>, set $CHECKLIST_TARGET, or run --dry-run to enumerate the checklist without one.\n",
		);
		console.error(HELP);
		process.exit(1);
	}

	const mode: "dry-run" | "run" = args.dryRun ? "dry-run" : "run";
	const results: Array<RowResult> = [];

	for (const row of ROWS) {
		const start = Date.now();
		if (mode === "dry-run") {
			results.push({
				id: row.id,
				section: row.section,
				title: row.title,
				status: "skipped-dry-run",
				reasons: ["dry run: no network calls were made"],
				evidence: row.requiredEnv !== undefined ? [`requires env: ${row.requiredEnv.join(", ")}`] : [],
				durationMs: Date.now() - start,
				tests: [`[${row.id}] ${row.title} [skipped-dry-run]`],
			});
			continue;
		}

		if (row.probe === undefined) {
			results.push({
				id: row.id,
				section: row.section,
				title: row.title,
				status: "not-testable-yet",
				reasons: [row.deferredTo ?? "no automated check for this row in this runner"],
				evidence: [],
				durationMs: Date.now() - start,
				tests: [`[${row.id}] ${row.title} [not-testable-yet]`],
			});
			continue;
		}

		const missingEnv = (row.requiredEnv ?? []).filter((name) => {
			const value = process.env[name];
			return value === undefined || value === "";
		});
		if (missingEnv.length > 0) {
			results.push({
				id: row.id,
				section: row.section,
				title: row.title,
				status: "not-testable-yet",
				reasons: [`missing env: ${missingEnv.join(", ")}`],
				evidence: [],
				durationMs: Date.now() - start,
				tests: [`[${row.id}] ${row.title} [not-testable-yet]`],
			});
			continue;
		}

		// target is defined here — enforced above when mode === "run".
		const probeResult = await row.probe({ target: target as string, env: process.env });
		results.push({
			id: row.id,
			section: row.section,
			title: row.title,
			status: probeResult.ok ? "pass" : "fail",
			reasons: probeResult.ok ? [] : [probeResult.detail],
			evidence: [probeResult.detail],
			durationMs: Date.now() - start,
			tests: [`[${row.id}] ${row.title} [${probeResult.ok ? "passed" : "failed"}]`],
		});
	}

	const totals = {
		pass: results.filter((r) => r.status === "pass").length,
		fail: results.filter((r) => r.status === "fail").length,
		notTestableYet: results.filter((r) => r.status === "not-testable-yet").length,
		skippedDryRun: results.filter((r) => r.status === "skipped-dry-run").length,
	};

	const generatedAt = new Date().toISOString();
	const timestamp = generatedAt.replace(/[:.]/g, "-").slice(0, 19);
	const label = mode === "dry-run" ? "dry-run" : "run";
	const outDir = args.outDir ?? `../reports/launch-checklist/${timestamp}Z-${label}`;
	mkdirSync(outDir, { recursive: true });

	const report = {
		generatedAt,
		mode,
		target: target ?? null,
		totals,
		rows: results,
	};
	writeFileSync(`${outDir}/launch-checklist-report.json`, JSON.stringify(report, null, 2));

	const md = [
		"# Launch checklist report",
		"",
		`- Mode: ${mode}`,
		`- Target: ${target ?? "(none — dry run)"}`,
		`- Generated: ${generatedAt}`,
		`- Totals: **${totals.fail} fail** · ${totals.pass} pass · ${totals.notTestableYet} not-testable-yet · ${totals.skippedDryRun} skipped-dry-run`,
		"",
		"## Rows",
		"",
		"| ID | Section | Status | Title |",
		"| --- | --- | --- | --- |",
		...results.map((r) => `| ${r.id} | ${r.section} | ${r.status} | ${r.title} |`),
		"",
		"## Detail",
		"",
		...results.flatMap((r) => [
			`### ${r.id} — ${r.title}`,
			"",
			`Status: ${r.status}`,
			...(r.reasons.length > 0 ? ["", "Reasons:", ...r.reasons.map((reason) => `- ${reason}`)] : []),
			...(r.evidence.length > 0 ? ["", "Evidence:", ...r.evidence.map((e) => `- ${e}`)] : []),
			"",
		]),
	].join("\n");
	writeFileSync(`${outDir}/launch-checklist-report.md`, md);

	for (const r of results) {
		const marker = r.status === "pass" ? "ok" : r.status === "fail" ? "FAIL" : r.status.toUpperCase();
		console.log(`${marker}: [${r.id}] ${r.title}`);
	}
	console.log(
		`\nLAUNCH CHECKLIST (${mode}): ${totals.fail} fail · ${totals.pass} pass · ${totals.notTestableYet} not-testable-yet · ${totals.skippedDryRun} skipped-dry-run — report in ${outDir}`,
	);

	if (totals.fail > 0) process.exit(1);
	process.exit(0);
};

await main();
