import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Author, Catalog, Chain, Journal, ScriptRunner } from "@smthrs/chain-next";
import type { Outcome } from "@smthrs/chain-next";
import { MODEL_STREAM_PATH } from "smithers-shared/AgentApiRoutes";
import type { FetchLike } from "smithers-shared/NativeAgent";
import { DEFAULT_MODEL_ID, layerAuthor } from "./StreamModel";

/*
 * The relay seat, proven over a recorded provider stream: the real
 * @smthrs/model Anthropic wire (SSE framing, event decode, settle fold) runs
 * against a fixture response served by an injected fetch — no network, no
 * mocks below the fetch seam. The fixture shape is the model package's own
 * anthropic/text.sse, so a provider-wire drift breaks their suite before ours.
 */

const sseOf = (text: ReadonlyArray<string>): string =>
	[
		`event: message_start`,
		`data: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_relay",
				type: "message",
				role: "assistant",
				content: [],
				model: DEFAULT_MODEL_ID,
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 12, output_tokens: 0 },
			},
		})}`,
		"",
		`event: content_block_start`,
		`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
		"",
		...text.flatMap((chunk) => [
			`event: content_block_delta`,
			`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } })}`,
			"",
		]),
		`event: content_block_stop`,
		`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
		"",
		`event: message_delta`,
		`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}`,
		"",
		`event: message_stop`,
		`data: ${JSON.stringify({ type: "message_stop" })}`,
		"",
		"",
	].join("\n");

const fixtureFetch = (
	streams: ReadonlyArray<string>,
): { readonly fetchImpl: FetchLike; readonly requests: Array<Request> } => {
	const requests: Array<Request> = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		const body = streams[requests.length - 1] ?? streams[streams.length - 1] ?? "";
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	return { fetchImpl, requests };
};

describe("the relay author seat", () => {
	test("authors from a recorded provider stream through the Worker relay path", async () => {
		const { fetchImpl, requests } = fixtureFetch([sseOf(["Hello", ", world"])]);
		const text = await Effect.runPromise(
			Effect.gen(function* () {
				const author = yield* Author.Author;
				return yield* author.author({ prefix: "You are Smithers.", context: ["ctx line"] });
			}).pipe(
				Effect.provide(layerAuthor({ baseUrl: "https://app.test", fetchImpl })),
			) as Effect.Effect<string, never, never>,
		);
		expect(text).toBe("Hello, world");

		expect(requests).toHaveLength(1);
		const sent = requests[0]!;
		expect(sent.method).toBe("POST");
		expect(new URL(sent.url).origin).toBe("https://app.test");
		expect(new URL(sent.url).pathname).toBe(MODEL_STREAM_PATH);
		const body = (await sent.json()) as {
			readonly model: string;
			readonly stream: boolean;
			readonly tools?: ReadonlyArray<unknown>;
		};
		// The sealed-step law rides the wire: the author call carries no tools.
		expect(body.model).toBe(DEFAULT_MODEL_ID);
		expect(body.tools ?? []).toEqual([]);
	});

	test("a chain runs a turn end-to-end over the relay seat", async () => {
		const script = ["```flow", `const noted = await ctx.call("probe", {})`, `return done({ noted })`, "```"].join("\n");
		const { fetchImpl } = fixtureFetch([sseOf([script.slice(0, 20), script.slice(20)])]);
		let probed = 0;
		const probe: Catalog.Entry = {
			name: "probe",
			description: "test probe",
			handler: () =>
				Effect.sync(() => {
					probed += 1;
					return { ok: true };
				}),
		};
		const outcome = await Effect.runPromise(
			Chain.run({ goal: "probe the app" }).pipe(
				Effect.provide(
					(() => {
						const base = Layer.mergeAll(
							Journal.layerMemory([]),
							layerAuthor({ baseUrl: "https://app.test", fetchImpl }),
							ScriptRunner.layerInProcess,
						);
						return Layer.mergeAll(base, Catalog.layer([probe]).pipe(Layer.provide(base)));
					})(),
				),
			) as Effect.Effect<Outcome.Terminal, never, never>,
		);
		expect(outcome._tag).toBe("Done");
		expect(probed).toBe(1);
	});
});
