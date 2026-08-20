import { describe, expect, test } from "bun:test";
import { runBoundedProcess } from "./run-bounded-process.ts";

/*
 * The capture budget is measured in BYTES and cut on a valid UTF-8 boundary:
 * the old string accumulation sliced UTF-16 code units, so a multibyte stream
 * could keep up to 3x the byte budget and split a surrogate pair, and every
 * chunk re-copied the whole capture (quadratic in the output size).
 */

const node = process.execPath;

describe("runBoundedProcess output capture", () => {
	test("output under the byte budget passes through exactly", async () => {
		const result = await runBoundedProcess(
			node,
			["-e", "process.stdout.write('hello world')"],
			process.cwd(),
			{ timeoutMs: 10_000, maxCaptureBytes: 1024 },
		);
		expect(result.passed).toBe(true);
		expect(result.stdout).toBe("hello world");
		expect(result.overflowed).toBe(false);
	});

	test("output exactly at the byte budget is not an overflow", async () => {
		const result = await runBoundedProcess(
			node,
			["-e", "process.stdout.write('x'.repeat(64))"],
			process.cwd(),
			{ timeoutMs: 10_000, maxCaptureBytes: 64 },
		);
		expect(result.passed).toBe(true);
		expect(result.stdout).toBe("x".repeat(64));
		expect(result.overflowed).toBe(false);
	});

	test("a multibyte stream over the budget is cut on a valid UTF-8 boundary", async () => {
		// 100 × 'é' (2 bytes each) = 200 bytes against a 65-byte budget: the cut
		// lands on byte 65, mid-sequence, and must decode as 32 'é' + U+FFFD.
		const result = await runBoundedProcess(
			node,
			["-e", "process.stdout.write('é'.repeat(100))"],
			process.cwd(),
			{ timeoutMs: 10_000, maxCaptureBytes: 65 },
		);
		expect(result.overflowed).toBe(true);
		expect(result.passed).toBe(false);
		expect(result.stdout).toBe(`${"é".repeat(32)}\uFFFD`);
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(65 + 3);
	});

	test("a process that keeps writing past the budget is terminated and flagged", async () => {
		const result = await runBoundedProcess(
			node,
			["-e", "let n = 0; const write = () => { process.stdout.write('y'.repeat(4096), () => { if (++n < 100) write(); }); }; write();"],
			process.cwd(),
			{ timeoutMs: 30_000, maxCaptureBytes: 8_192 },
		);
		expect(result.overflowed).toBe(true);
		expect(result.passed).toBe(false);
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8_192 + 3);
	});

	test("a quiet process that overstays its budget is flagged as timed out", async () => {
		const result = await runBoundedProcess(
			node,
			["-e", "setTimeout(() => {}, 60_000)"],
			process.cwd(),
			{ timeoutMs: 250, terminationGraceMs: 250 },
		);
		expect(result.timedOut).toBe(true);
		expect(result.passed).toBe(false);
	}, 15_000);
});
