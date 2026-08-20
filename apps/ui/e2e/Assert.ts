/*
 * The hermetic e2e harness — assertions and the per-suite reporter.
 *
 * Every check throws SuiteFailure instead of calling process.exit. One suite's
 * regression must not kill the wrangler process the other suites share, so the
 * runner catches the throw, records the failure, and moves on.
 */

/** Thrown by every assertion so one suite's failure never kills the shared stack. */
export class SuiteFailure extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "SuiteFailure";
	}
}

export interface Reporter {
	/** Prints `ok: <suiteId> — <line>`. One line per proven outcome, as worker-e2e does. */
	readonly ok: (line: string) => void;
	/** Throws SuiteFailure. Returns never so callers can narrow. */
	readonly fail: (reason: string) => never;
	/** Fails with `reason` when `condition` is false. */
	readonly check: (condition: boolean, reason: string) => void;
	readonly equals: <T>(actual: T, expected: T, what: string) => void;
	readonly includes: (haystack: string, needle: string, what: string) => void;
	readonly excludes: (haystack: string, needle: string, what: string) => void;
	/** Asserts the status and returns the parsed JSON body. */
	readonly json: <T>(response: Response, expected: number, what: string) => Promise<T>;
	/** How many `ok:` lines this suite has printed. */
	readonly okCount: () => number;
}

export const createReporter = (suiteId: string): Reporter => {
	let printed = 0;
	const fail = (reason: string): never => {
		throw new SuiteFailure(reason);
	};
	const check = (condition: boolean, reason: string): void => {
		if (!condition) fail(reason);
	};
	return {
		ok: (line) => {
			printed += 1;
			console.log(`ok: ${suiteId} — ${line}`);
		},
		fail,
		check,
		equals: (actual, expected, what) => {
			if (!Object.is(actual, expected)) {
				fail(`${what}: expected ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`);
			}
		},
		includes: (haystack, needle, what) => {
			if (!haystack.includes(needle)) {
				fail(`${what}: missing ${JSON.stringify(needle)} in ${JSON.stringify(haystack.slice(0, 400))}`);
			}
		},
		excludes: (haystack, needle, what) => {
			if (haystack.includes(needle)) {
				fail(`${what}: found ${JSON.stringify(needle)} in ${JSON.stringify(haystack.slice(0, 400))}`);
			}
		},
		json: async <T>(response: Response, expected: number, what: string): Promise<T> => {
			if (response.status !== expected) {
				fail(`${what} answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
			}
			const body = await response.text();
			try {
				return JSON.parse(body) as T;
			} catch {
				return fail(`${what} did not answer JSON: ${body.slice(0, 300)}`);
			}
		},
		okCount: () => printed,
	};
};

export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `predicate` every 100ms until true. Fails with `what` after `timeoutMs` (default 10000). */
export const waitUntil = async (
	report: Reporter,
	what: string,
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 10_000,
): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() >= deadline) report.fail(`${what} (waited ${timeoutMs}ms)`);
		await wait(100);
	}
};
