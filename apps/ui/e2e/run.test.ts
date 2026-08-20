import { describe, expect, test } from "bun:test";
import { SuiteFailure } from "./Assert.ts";
import { SuiteTimeoutFailure, suiteFailureAction } from "./run.ts";

describe("suite timeout isolation", () => {
	test("a timeout aborts the run instead of scheduling another suite", () => {
		expect(suiteFailureAction(new SuiteTimeoutFailure("timed out"))).toBe("abort-run");
	});

	test("an ordinary suite assertion still allows independent later suites", () => {
		expect(suiteFailureAction(new SuiteFailure("assertion failed"))).toBe("continue");
	});
});
