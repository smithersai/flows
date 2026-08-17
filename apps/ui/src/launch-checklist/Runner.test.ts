/*
 * The runner's status discipline: what makes a row pass, fail, or honestly
 * decline — and the fact that a dry run touches nothing.
 */
import { describe, expect, test } from "bun:test";
import { buildReport, exitCodeFor, renderMarkdown, runChecklist, totalsOf } from "./Runner.ts";
import { BrowserUnavailableError, type ChecklistRow, type ProbeContext } from "./Types.ts";

const context = (env: Record<string, string | undefined> = {}): ProbeContext => {
	let clock = 0;
	return {
		target: "https://example.test",
		env,
		page: () => Promise.reject(new BrowserUnavailableError("no browser here")),
		fetch: () => Promise.reject(new Error("no network in this test")),
		now: () => (clock += 1),
		sleep: () => Promise.resolve(),
	};
};

const row = (overrides: Partial<ChecklistRow> & Pick<ChecklistRow, "probe">): ChecklistRow => ({
	id: "X-1",
	section: "A",
	title: "a row",
	...overrides,
});

describe("runChecklist", () => {
	test("a dry run skips every row without calling any probe", async () => {
		let called = false;
		const results = await runChecklist({
			rows: [
				row({
					probe: async () => {
						called = true;
						return { status: "pass", detail: "should never run" };
					},
				}),
			],
			mode: "dry-run",
			context: context(),
		});
		expect(called).toBe(false);
		expect(results[0]?.status).toBe("skipped-dry-run");
	});

	test("a missing auth env var reports not-testable-yet naming the variable", async () => {
		const results = await runChecklist({
			rows: [row({ requiredEnv: ["CHECKLIST_SESSION_COOKIE"], probe: async () => ({ status: "pass", detail: "" }) })],
			mode: "run",
			context: context({}),
		});
		expect(results[0]?.status).toBe("not-testable-yet");
		expect(results[0]?.reasons[0]).toContain("CHECKLIST_SESSION_COOKIE");
	});

	test("a machine with no browser reports not-testable-yet, never a product failure", async () => {
		const results = await runChecklist({
			rows: [row({ browser: true, probe: async (ctx) => ({ status: "pass", detail: await ctx.page(undefined).then(() => "") }) })],
			mode: "run",
			context: context(),
		});
		expect(results[0]?.status).toBe("not-testable-yet");
		expect(results[0]?.reasons[0]).toContain("no browser here");
	});

	test("any other throw from a probe is a real failure, not a deferral", async () => {
		const results = await runChecklist({
			rows: [
				row({
					probe: async () => {
						throw new Error("the composer textarea never mounted");
					},
				}),
			],
			mode: "run",
			context: context(),
		});
		expect(results[0]?.status).toBe("fail");
		expect(results[0]?.reasons[0]).toContain("never mounted");
	});

	test("a probe's own verdict carries through, with its detail as evidence", async () => {
		const results = await runChecklist({
			rows: [row({ probe: async () => ({ status: "fail", detail: "rating prompt rendered: was this helpful" }) })],
			mode: "run",
			context: context(),
		});
		expect(results[0]?.status).toBe("fail");
		expect(results[0]?.evidence[0]).toContain("was this helpful");
	});
});

describe("report shaping", () => {
	test("only a real fail fails the command", () => {
		expect(exitCodeFor(totalsOf([]))).toBe(0);
		expect(
			exitCodeFor({ pass: 3, fail: 0, notTestableYet: 9, skippedDryRun: 0 }),
		).toBe(0);
		expect(exitCodeFor({ pass: 3, fail: 1, notTestableYet: 0, skippedDryRun: 0 })).toBe(1);
	});

	test("the report keeps the historical shape and renders every row", async () => {
		const results = await runChecklist({
			rows: [row({ probe: async () => ({ status: "pass", detail: "ok" }) })],
			mode: "run",
			context: context(),
		});
		const report = buildReport("run", "https://example.test", "2026-08-16T00:00:00.000Z", results);
		expect(report.target).toBe("https://example.test");
		expect(report.totals).toEqual({ pass: 1, fail: 0, notTestableYet: 0, skippedDryRun: 0 });
		const markdown = renderMarkdown(report);
		expect(markdown).toContain("| X-1 | A | pass | a row |");
		expect(markdown).toContain("Evidence:");
	});
});
