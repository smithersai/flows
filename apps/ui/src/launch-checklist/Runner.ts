/*
 * Launch checklist (U7) — the runner.
 *
 * Pure with respect to the outside world: it takes a row catalog and a probe
 * context and returns results plus a report. Launching a browser, reading the
 * clock, writing files, and exiting the process all belong to the CLI
 * (scripts/launch-checklist.ts), which is why this module is unit-testable
 * with fake pages and a fake fetch.
 */
import { BrowserUnavailableError, type ChecklistReport, type ChecklistRow, type ProbeContext, type RowResult, type Status, type Totals } from "./Types.ts";

export interface RunOptions {
	readonly rows: ReadonlyArray<ChecklistRow>;
	readonly mode: "dry-run" | "run";
	readonly context: ProbeContext;
}

const missingEnvFor = (row: ChecklistRow, env: Readonly<Record<string, string | undefined>>): ReadonlyArray<string> =>
	(row.requiredEnv ?? []).filter((name) => {
		const value = env[name];
		return value === undefined || value === "";
	});

const result = (
	row: ChecklistRow,
	status: Status,
	reasons: ReadonlyArray<string>,
	evidence: ReadonlyArray<string>,
	durationMs: number,
): RowResult => ({
	id: row.id,
	section: row.section,
	title: row.title,
	status,
	reasons,
	evidence,
	durationMs,
	tests: [`[${row.id}] ${row.title} [${status === "pass" ? "passed" : status === "fail" ? "failed" : status}]`],
});

export const runChecklist = async ({ rows, mode, context }: RunOptions): Promise<ReadonlyArray<RowResult>> => {
	const results: Array<RowResult> = [];
	for (const row of rows) {
		const start = context.now();
		if (mode === "dry-run") {
			results.push(
				result(
					row,
					"skipped-dry-run",
					["dry run: no network calls were made and no browser was launched"],
					[
						...(row.requiredEnv !== undefined ? [`requires env: ${row.requiredEnv.join(", ")}`] : []),
						...(row.browser === true ? ["drives a headless page on the target"] : ["HTTP-only probe"]),
					],
					context.now() - start,
				),
			);
			continue;
		}

		const missing = missingEnvFor(row, context.env);
		if (missing.length > 0) {
			results.push(result(row, "not-testable-yet", [`missing env: ${missing.join(", ")}`], [], context.now() - start));
			continue;
		}

		try {
			const probeResult = await row.probe(context);
			results.push(
				result(
					row,
					probeResult.status,
					probeResult.status === "pass" ? [] : [probeResult.detail],
					[probeResult.detail],
					context.now() - start,
				),
			);
		} catch (error) {
			/*
			 * A missing browser is a capability gap, not a product failure: the
			 * row honestly reports not-testable-yet and names what is missing.
			 * Anything else the probe threw is a real failure of the check.
			 */
			const status: Status = error instanceof BrowserUnavailableError ? "not-testable-yet" : "fail";
			results.push(result(row, status, [String(error instanceof Error ? error.message : error)], [], context.now() - start));
		}
	}
	return results;
};

export const totalsOf = (rows: ReadonlyArray<RowResult>): Totals => ({
	pass: rows.filter((row) => row.status === "pass").length,
	fail: rows.filter((row) => row.status === "fail").length,
	notTestableYet: rows.filter((row) => row.status === "not-testable-yet").length,
	skippedDryRun: rows.filter((row) => row.status === "skipped-dry-run").length,
});

export const buildReport = (
	mode: "dry-run" | "run",
	target: string | undefined,
	generatedAt: string,
	rows: ReadonlyArray<RowResult>,
): ChecklistReport => ({
	generatedAt,
	mode,
	target: target ?? null,
	totals: totalsOf(rows),
	rows,
});

/** Only a real `fail` fails the command; not-testable-yet and dry runs do not. */
export const exitCodeFor = (totals: Totals): number => (totals.fail > 0 ? 1 : 0);

export const renderMarkdown = (report: ChecklistReport): string =>
	[
		"# Launch checklist report",
		"",
		`- Mode: ${report.mode}`,
		`- Target: ${report.target ?? "(none — dry run)"}`,
		`- Generated: ${report.generatedAt}`,
		`- Totals: **${report.totals.fail} fail** · ${report.totals.pass} pass · ${report.totals.notTestableYet} not-testable-yet · ${report.totals.skippedDryRun} skipped-dry-run`,
		"",
		"## Rows",
		"",
		"| ID | Section | Status | Title |",
		"| --- | --- | --- | --- |",
		...report.rows.map((row) => `| ${row.id} | ${row.section} | ${row.status} | ${row.title} |`),
		"",
		"## Detail",
		"",
		...report.rows.flatMap((row) => [
			`### ${row.id} — ${row.title}`,
			"",
			`Status: ${row.status}`,
			...(row.reasons.length > 0 ? ["", "Reasons:", ...row.reasons.map((reason) => `- ${reason}`)] : []),
			...(row.evidence.length > 0 ? ["", "Evidence:", ...row.evidence.map((line) => `- ${line}`)] : []),
			"",
		]),
	].join("\n");
