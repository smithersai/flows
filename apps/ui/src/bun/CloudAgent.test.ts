import { describe, expect, test } from "bun:test";
import type { Card } from "smithers-shared/Cards";
import type { AgentTurnFrame, StartAgentTurnRequest } from "smithers-shared/NativeAgent";
import { createCloudAgent } from "./CloudAgent";

const request: StartAgentTurnRequest = {
	runId: "run-1",
	messages: [{ role: "user", content: "Hello who are you" }],
	instructions: "Be brief.",
};

const ndjsonResponse = (lines: ReadonlyArray<unknown>, init?: ResponseInit): Response =>
	new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
				controller.close();
			},
		}),
		{ status: 200, ...init },
	);

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("createCloudAgent", () => {
	test("streams upstream NDJSON frames to the publisher", async () => {
		const frames: AgentTurnFrame[] = [];
		const agent = createCloudAgent((frame) => frames.push(frame), {
			chatUrl: "https://example.test/chat",
			origin: "https://example.test",
			fetchImpl: async () =>
				ndjsonResponse([
					{ type: "delta", kind: "reasoning", text: "hmm" },
					{ type: "delta", kind: "text", text: "Hello!" },
					{ type: "done" },
				]),
		});

		expect(agent.start(request)).toEqual({ status: "started" });
		await flush();
		expect(frames).toEqual([
			{ runId: "run-1", type: "delta", kind: "reasoning", text: "hmm" },
			{ runId: "run-1", type: "delta", kind: "text", text: "Hello!" },
			{ runId: "run-1", type: "done" },
		]);
	});

	test("publishes a done error frame when upstream responds with an HTTP failure", async () => {
		const frames: AgentTurnFrame[] = [];
		const agent = createCloudAgent((frame) => frames.push(frame), {
			fetchImpl: async () => new Response("bad gateway", { status: 502 }),
		});

		expect(agent.start(request)).toEqual({ status: "started" });
		await flush();
		expect(frames).toEqual([
			{
				runId: "run-1",
				type: "done",
				error: "Smithers Cloud chat failed (HTTP 502): bad gateway",
			},
		]);
	});

	test("rejects a duplicate runId while a turn is active", () => {
		const agent = createCloudAgent(() => {}, {
			fetchImpl: async () =>
				new Response(new ReadableStream<Uint8Array>({ start: () => {} }), { status: 200 }),
		});
		expect(agent.start(request)).toEqual({ status: "started" });
		expect(agent.start(request).status).toBe("error");
	});

	test("cancel aborts an active turn and reports not-found otherwise", async () => {
		const frames: AgentTurnFrame[] = [];
		const agent = createCloudAgent((frame) => frames.push(frame), {
			fetchImpl: async () =>
				new Response(new ReadableStream<Uint8Array>({ start: () => {} }), { status: 200 }),
		});
		expect(agent.cancel("run-1")).toEqual({ status: "not-found" });
		expect(agent.start(request)).toEqual({ status: "started" });
		expect(agent.cancel("run-1")).toEqual({ status: "cancelled" });
		await flush();
		expect(frames.some((frame) => frame.type === "done" && frame.error !== undefined)).toBe(false);
	});

	test("promotes upstream card frames into the shared turn contract", async () => {
		const planCard: Card = {
			id: "card-plan",
			kind: "plan",
			title: "Ship the MVP",
			status: "active",
			createdAt: 1,
			ordinal: 1,
			payload: { items: [{ id: "item-1", title: "Wave 1", status: "active" }] },
		};
		const frames: AgentTurnFrame[] = [];
		const agent = createCloudAgent((frame) => frames.push(frame), {
			fetchImpl: async () =>
				ndjsonResponse([
					{ type: "card", card: planCard },
					{ type: "card.update", id: "card-plan", patch: { status: "acted" } },
					{ type: "card", card: { id: "card-bad", kind: "nonsense" } },
					{ type: "done" },
				]),
		});

		expect(agent.start(request)).toEqual({ status: "started" });
		await flush();
		expect(frames).toEqual([
			{ runId: "run-1", type: "card", card: planCard },
			{ runId: "run-1", type: "card.update", id: "card-plan", patch: { status: "acted" } },
			{ runId: "run-1", type: "done" },
		]);
	});

	test("cancel releases the turn's response stream (scoped transport)", async () => {
		/*
		 * The AbortController transport aborted only the fetch promise: the
		 * stream reader it had already handed out stayed open. The scoped
		 * Effect transport releases the reader on interruption, so the
		 * underlying stream sees its own cancel.
		 */
		let streamCancelled = false;
		const agent = createCloudAgent(() => {}, {
			fetchImpl: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start: () => {},
						cancel: () => {
							streamCancelled = true;
						},
					}),
					{ status: 200 },
				),
		});
		expect(agent.start(request)).toEqual({ status: "started" });
		await flush();
		expect(agent.cancel("run-1")).toEqual({ status: "cancelled" });
		await flush();
		expect(streamCancelled).toBe(true);
	});

	test("a cancelled turn's teardown does not deregister the turn that replaced it", async () => {
		/*
		 * The teardown runs after `cancel` already dropped the entry, so by then
		 * the same run id can hold a replacement turn. Deleting by run id evicted
		 * that live turn: it answered `not-found` to cancel and a second `start`
		 * for it was permitted, leaving two fibers streaming one run.
		 */
		const agent = createCloudAgent(() => {}, {
			fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ start: () => {} }), { status: 200 }),
		});
		expect(agent.start(request)).toEqual({ status: "started" });
		await flush();
		expect(agent.cancel("run-1")).toEqual({ status: "cancelled" });
		expect(agent.start(request)).toEqual({ status: "started" });
		await flush();
		expect(agent.cancel("run-1")).toEqual({ status: "cancelled" });
	});
});
