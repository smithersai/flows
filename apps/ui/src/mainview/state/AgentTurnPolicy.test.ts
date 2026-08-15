import { describe, expect, test } from "bun:test";
import type { Message } from "./AppState";
import {
	boundToolResult,
	contextMessages,
	estimateTextTokens,
	selectCompactionSlice,
	turnRequestBytes,
	utf8Bytes,
} from "./AgentTurnPolicy";

const message = (ordinal: number, role: Message["role"], text: string, act?: string): Message => ({
	id: `m-${ordinal}`,
	role,
	text,
	status: "complete",
	createdAt: ordinal,
	ordinal,
	...(act === undefined ? {} : { act }),
});

describe("agent turn production policy", () => {
	test("measures the exact UTF-8 request body rather than JS code units", () => {
		const request = { runId: "r", messages: [{ role: "user" as const, content: "🙂" }], instructions: "" };
		expect(turnRequestBytes(request)).toBe(utf8Bytes(JSON.stringify(request)));
		expect(utf8Bytes("🙂")).toBe(4);
		expect(estimateTextTokens("12345")).toBe(2);
	});

	test("injects a hidden Pi-compatible compaction summary and retains only newer messages", () => {
		const messages = [message(0, "user", "old question"), message(1, "smithers", "old answer"), message(2, "user", "new question")];
		expect(contextMessages(messages, { summary: "User chose blue.", throughOrdinal: 1, sourceMessageCount: 2, createdAt: 1 })).toEqual([
			{
				role: "user",
				content: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nUser chose blue.\n</summary>",
			},
			{ role: "user", content: "new question" },
		]);
	});

	test("excludes tool-act rows from both ordinary and compacted context", () => {
		const messages = [message(0, "user", "question"), message(1, "smithers", "Smithers ran /x", "tool"), message(2, "smithers", "answer")];
		expect(contextMessages(messages)).toEqual([
			{ role: "user", content: "question" },
			{ role: "assistant", content: "answer" },
		]);
	});

	test("cuts only before a complete user turn", () => {
		const messages = [
			message(0, "user", "u0"),
			message(1, "smithers", "a0"),
			message(2, "user", "u1"),
			message(3, "smithers", "a1"),
			message(4, "user", "u2"),
		];
		const slice = selectCompactionSlice(messages, 1);
		expect(slice?.compact.map((entry) => entry.text)).toEqual(["u0", "a0", "u1", "a1"]);
		expect(slice?.keep.map((entry) => entry.text)).toEqual(["u2"]);
		expect(slice?.throughOrdinal).toBe(3);
	});

	test("does not claim it can compact when no complete old turn exists", () => {
		expect(selectCompactionSlice([message(0, "user", "only")], 1)).toBeUndefined();
		expect(selectCompactionSlice([message(0, "user", "u"), message(1, "smithers", "a")], 1)).toBeUndefined();
	});

	test("tool outputs pass through losslessly under both limits", () => {
		expect(boundToolResult("ok\nvalue", 100, 10)).toEqual({
			modelOutput: "ok\nvalue",
			truncated: false,
			totalBytes: 8,
			totalLines: 2,
		});
	});

	test("tool outputs truncate by line count with an explicit evidence marker", () => {
		const bounded = boundToolResult("one\ntwo\nthree", 200, 2);
		expect(bounded.truncated).toBe(true);
		expect(bounded.modelOutput).toStartWith("one\ntwo");
		expect(bounded.modelOutput).not.toContain("three");
		expect(bounded.modelOutput).toContain("14 bytes, 3 lines total");
	});

	test("tool outputs truncate on UTF-8 byte boundaries without replacement characters", () => {
		const bounded = boundToolResult("🙂".repeat(100), 100, 1_000);
		expect(bounded.truncated).toBe(true);
		expect(utf8Bytes(bounded.modelOutput)).toBeLessThanOrEqual(100);
		expect(bounded.modelOutput).not.toContain("�");
		expect(bounded.modelOutput).toContain("400 bytes");
	});

	test("zero and marker-only budgets remain deterministic", () => {
		const bounded = boundToolResult("large", 0, 0);
		expect(bounded.truncated).toBe(true);
		expect(bounded.modelOutput).toContain("Tool result truncated");
	});
});
