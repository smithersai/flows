/*
 * The hermetic e2e harness — the suite module contract.
 *
 * This is the only file the suite lanes import for types. A suite is a data
 * object with a `run`; the runner owns the stack lifecycle, so a suite never
 * boots, resets, or stops anything itself.
 */
import type { Reporter } from "./Assert.ts";
import type { Stack } from "./Stack.ts";
import type { E2eBrowser } from "./Browser.ts";

/**
 * "A" boots the Worker with every backend seam unconfigured, so the honest
 * 501s are provable. "B" points every seam at the doubles.
 */
export type Phase = "A" | "B";

export interface SuiteContext {
	/** http://127.0.0.1:<port> — the product Worker under wrangler dev. */
	readonly origin: string;
	readonly phase: Phase;
	readonly stack: Stack;
	readonly report: Reporter;
	/** Lazy. `open()` rejects with BrowserUnavailableError when no system Chrome exists. */
	readonly browser: E2eBrowser;
}

export interface Suite {
	/** The checklist id this suite proves, e.g. "E1.9" — or a group id, e.g. "E8". */
	readonly id: string;
	/**
	 * Every checklist id this suite claims, when the suite `id` does not name
	 * them all. Optional: the runner otherwise derives the claim from `id` and
	 * from the leading id of each `report.ok("E1.2 ...")` line in the source.
	 *
	 * The runner compares the claim against the ids actually printed this run
	 * and fails the run on the difference, so a browser-only section that
	 * skipped can never be reported as proven.
	 */
	readonly ids?: ReadonlyArray<string>;
	readonly title: string;
	/** "B" (all seams at the doubles) unless the suite needs unconfigured seams. Default "B". */
	readonly phase?: Phase;
	/** Sorted ascending inside a phase; use 90+ for suites that leave state behind. Default 0. */
	readonly order?: number;
	/** True when the suite drives a headless page. A missing browser skips it, never fails it. */
	readonly browser?: boolean;
	readonly run: (ctx: SuiteContext) => Promise<void>;
}

export const defineSuite = (suite: Suite): Suite => suite;
