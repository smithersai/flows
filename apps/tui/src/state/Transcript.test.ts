import { describe, expect, test } from "bun:test";
import {
	applyFrame,
	cardPlaceholder,
	feedNdjson,
	toolCallLine,
	TranscriptStore,
	transcriptMessages,
} from "./Transcript";
import type { CardEntry, ToolEntry } from "./Transcript";
import { scrubToolEcho } from "./MessageScrub";

const planCard = {
	id: "plan-1",
	kind: "plan" as const,
	title: "Ship the TUI",
	status: "active" as const,
	createdAt: 1,
	ordinal: 0,
	payload: { items: [{ id: "a", title: "build", status: "pending" as const }] },
};

describe("feedNdjson — NDJSON frame decoding into transcript state", () => {
	test("text deltas stream into one assistant message that settles on done", () => {
		const store = new TranscriptStore();
		const applied = feedNdjson(
			store,
			[
				JSON.stringify({ runId: "r1", type: "delta", kind: "text", text: "Hello" }),
				JSON.stringify({ runId: "r1", type: "delta", kind: "text", text: " world" }),
				JSON.stringify({ runId: "r1", type: "done", reason: "stop" }),
			].join("\n"),
		);
		expect(applied).toBe(3);
		const entries = store.entries();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			kind: "message",
			role: "assistant",
			text: "Hello world",
			status: "complete",
		});
	});

	test("a delta split across chunks arrives with a partial trailing line", () => {
		const store = new TranscriptStore();
		const first = `{"runId":"r1","type":"delta","kind":"text","text":"Hel"}\n{"runId":"r1","type":"delta","kind":"text","text":"lo"}`;
		// Feed the two complete lines; the stream's trailing partial line is the
		// transport's buffer concern, not the fold's.
		expect(feedNdjson(store, first)).toBe(2);
		expect(store.entries()[0]).toMatchObject({ text: "Hello", status: "streaming" });
	});

	test("reasoning deltas accumulate on the reasoning channel", () => {
		const store = new TranscriptStore();
		feedNdjson(
			store,
			[
				JSON.stringify({ runId: "r1", type: "delta", kind: "reasoning", text: "thinking " }),
				JSON.stringify({ runId: "r1", type: "delta", kind: "reasoning", text: "hard" }),
				JSON.stringify({ runId: "r1", type: "delta", kind: "text", text: "answer" }),
			].join("\n"),
		);
		expect(store.entries()[0]).toMatchObject({ reasoning: "thinking hard", text: "answer" });
	});

	test("tool_call frames become compact tool entries", () => {
		const store = new TranscriptStore();
		feedNdjson(
			store,
			JSON.stringify({
				runId: "r1",
				type: "tool_call",
				call_id: "c1",
				name: "commands",
				arguments: '{"action":"list"}',
			}),
		);
		const entry = store.entries()[0] as ToolEntry;
		expect(entry.kind).toBe("tool");
		expect(toolCallLine(entry)).toBe('[tool] commands {"action":"list"}');
	});

	test("a done with an error marks the turn failed; cancelled marks it interrupted", () => {
		const failed = new TranscriptStore();
		feedNdjson(
			failed,
			[
				JSON.stringify({ runId: "r1", type: "delta", kind: "text", text: "partial" }),
				JSON.stringify({ runId: "r1", type: "done", error: "boom" }),
			].join("\n"),
		);
		expect(failed.entries()[0]).toMatchObject({ status: "failed", text: "partial" });

		const cancelled = new TranscriptStore();
		feedNdjson(cancelled, JSON.stringify({ runId: "r1", type: "done", reason: "cancelled" }));
		// Killed before the first delta: the turn still says what happened.
		expect(cancelled.entries()[0]).toMatchObject({ status: "interrupted" });
	});

	test("garbage lines and foreign frames are skipped", () => {
		const store = new TranscriptStore();
		const applied = feedNdjson(
			store,
			[
				"not json at all",
				JSON.stringify({ type: "delta", kind: "text", text: "no runId" }),
				JSON.stringify({ runId: "r1", type: "delta", kind: "text", text: "ok" }),
			].join("\n"),
		);
		expect(applied).toBe(1);
		expect(store.entries()).toHaveLength(1);
	});
});

describe("card frames render as placeholders", () => {
	test("a card frame becomes a one-line placeholder entry", () => {
		const store = new TranscriptStore();
		feedNdjson(store, JSON.stringify({ runId: "r1", type: "card", card: planCard }));
		const entry = store.entries()[0] as CardEntry;
		expect(entry).toMatchObject({ kind: "card", cardKind: "plan", title: "Ship the TUI" });
		expect(cardPlaceholder(entry)).toBe("[card] plan: Ship the TUI (active)");
	});

	test("card.update patches the placeholder in place", () => {
		const store = new TranscriptStore();
		feedNdjson(
			store,
			[
				JSON.stringify({ runId: "r1", type: "card", card: planCard }),
				JSON.stringify({
					runId: "r1",
					type: "card.update",
					id: "plan-1",
					patch: { title: "Shipped the TUI", status: "acted" },
				}),
			].join("\n"),
		);
		expect(store.entries()).toHaveLength(1);
		const entry = store.entries()[0] as CardEntry;
		expect(cardPlaceholder(entry)).toBe("[card] plan: Shipped the TUI (acted)");
	});
});

describe("transcriptMessages", () => {
	test("only complete, non-empty prose messages enter the model context", () => {
		const store = new TranscriptStore();
		store.appendUserMessage("t1", "first question");
		applyFrame(store, { runId: "t1", type: "delta", kind: "text", text: "first answer" });
		applyFrame(store, { runId: "t1", type: "done", reason: "stop" });
		applyFrame(store, { runId: "t1", type: "card", card: planCard });
		applyFrame(store, {
			runId: "t1",
			type: "tool_call",
			call_id: "c1",
			name: "commands",
			arguments: "{}",
		});
		store.appendDelta("t2", "text", "still streaming");
		expect(transcriptMessages(store.entries())).toEqual([
			{ role: "user", content: "first question" },
			{ role: "assistant", content: "first answer" },
		]);
	});
});

describe("scrubToolEcho", () => {
	test("a tool echo written as prose is stripped; real prose survives", () => {
		expect(scrubToolEcho('before {"action":"execute","name":"repos.watch","args":""} after')).toBe(
			"before after",
		);
		expect(scrubToolEcho('plain {"other":true} prose')).toBe('plain {"other":true} prose');
	});
});
