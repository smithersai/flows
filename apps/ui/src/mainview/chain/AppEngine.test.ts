import { describe, expect, test } from "bun:test";
import * as Capability from "@smthrs/capability-next/Capability";
import * as Flow from "@smthrs/core/Flow";
import * as CellTurn from "@smthrs/harness/CellTurn";
import * as ContextWindow from "@smthrs/harness/ContextWindow";
import * as EngineLike from "@smthrs/harness/EngineLike";
import * as FlowBinding from "@smthrs/harness/FlowBinding";
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox";
import * as Steering from "@smthrs/harness/Steering";
import * as Model from "@smthrs/model/Model";
import type * as ModelEvent from "@smthrs/model/ModelEvent";
import * as ModelRequest from "@smthrs/model/ModelRequest";
import { Effect, Layer, Option, Result, Schema, Stream } from "effect";
import * as AppEngine from "./AppEngine";

/*
 * The workspace harness cell loop, running in this app's environment.
 *
 * This is the groundwork for replacing ChainRuntime with CellTurn/CellHarness
 * (DESIGN.md §14). It proves the three ports the loop needs are all satisfiable
 * here — the QuickJS browser sandbox evaluates cells, the app-side EngineLike
 * streams a seat and dispatches flow calls, and a steering source closes the
 * composition — and it pins the one blocker that stops the swap from landing:
 * the loop's capability envelope only understands `@smthrs/capability-next`
 * actions, while this app's flows claim the chain-era policy vocabulary.
 */

const cell = (...lines: ReadonlyArray<string>): string => ["```cell", ...lines, "```"].join("\n");

/** A seat that replays scripted assistant turns, one per model step. */
const scriptedModel = (turns: ReadonlyArray<string>): Model.Model => {
	let index = 0;
	return Model.make({
		stream: () => {
			const text = turns[index] ?? cell('return { intent: "complete", output: null };');
			index += 1;
			return Stream.fromArray([
				{ type: "text-start", id: "t" },
				{ type: "text-delta", id: "t", text },
				{ type: "text-end", id: "t" },
				{ type: "settle", stopReason: "stop" },
			] as ReadonlyArray<ModelEvent.ModelEvent>);
		},
	});
};

const EchoText = Schema.Struct({ text: Schema.String });

const echo = (capabilities: ReadonlyArray<string>) =>
	FlowBinding.make({
		flow: Flow.make({
			name: "echo",
			description: "Echo the text back, upper-cased",
			input: EchoText,
			output: EchoText,
			capabilities,
		}),
		// The binding decodes through EchoText before this runs; the assertion on
		// the settled value is what proves the decode/encode round trip.
		handler: (input) =>
			Effect.succeed({ text: (input as { readonly text: string }).text.toUpperCase() }),
	});

const run = (options: {
	readonly turns: ReadonlyArray<string>;
	readonly capabilities: ReadonlyArray<string>;
}) => {
	const catalog = Result.getOrThrow(FlowBinding.catalogResult([echo(options.capabilities)]));
	const engine = AppEngine.make({ model: scriptedModel(options.turns), catalog });
	const state = CellTurn.make({
		session: "app-engine-test",
		seat: "harness:model:claude-sonnet-5",
		modelParams: ModelRequest.GenerationParams.make({}),
		layers: [],
		// The widest envelope the capability package can express.
		capabilityEnvelope: [new Capability.CapabilityPattern({ action: "*", resource: "**" })],
		placement: Option.none(),
		contextWindow: ContextWindow.make({
			modelId: "claude-sonnet-5",
			segments: [
				{ kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("Echo hi.")] },
			],
		}),
		maxFrames: 3,
	});
	return Effect.runPromise(
		Stream.runCollect(CellTurn.run({ state, flows: catalog.descriptors })).pipe(
			Effect.provide(
				Layer.mergeAll(EngineLike.layer(engine), QuickJSSandbox.layer, Steering.layerNoop()),
			),
		),
	);
};

const CALL_CELL = cell(
	"const out = await ctx.call('echo', { text: 'hi' });",
	'return { intent: "complete", output: out };',
);

const settledMessages = (events: Iterable<{ readonly _tag: string }>): Array<string> =>
	[...events]
		.filter((event) => event._tag === "cell-settled")
		.map((event) => JSON.stringify((event as unknown as { readonly outcome: unknown }).outcome));

describe("the workspace harness cell loop runs in this app", () => {
	test("the QuickJS sandbox, the app engine port, and a steering source compose into a turn", async () => {
		const events = await run({ turns: [CALL_CELL], capabilities: [] });
		const tags = [...events].map((event) => event._tag);
		// The loop's own lifecycle, start to finish, with no host stubs left over.
		expect(tags).toContain("turn-opened");
		expect(tags).toContain("model-delta");
		expect(tags).toContain("cell-produced");
		expect(tags).toContain("cell-settled");
		expect(tags).toContain("turn-closed");
		expect(tags).toContain("resolved");
	});

	test("a cell's flow call is answered by the binding through EngineLike.call", async () => {
		const events = await run({ turns: [CALL_CELL], capabilities: [] });
		const settled = [...events].find((event) => event._tag === "cell-call-settled") as
			| unknown as
			| { readonly result: { readonly outcome: string; readonly value: unknown } }
			| undefined;
		expect(settled).toBeDefined();
		expect(settled?.result.outcome).toBe("success");
		// The binding decoded the payload through the flow's schema and encoded
		// its success back — the same contract the app's own dispatch uses.
		expect(settled?.result.value).toEqual({ text: "HI" });
	});

	/*
	 * The blocker, pinned as a test rather than described in prose.
	 *
	 * `CellTurn` screens a flow's declared capabilities against the run's
	 * envelope with `Capability.parse`, which recognizes only the fixed
	 * `@smthrs/capability-next` action set (fs:*, net:*, model:call, proc:spawn,
	 * jj:*). An unparseable claim takes the `onNone: () => true` branch and is
	 * REFUSED. Every flow in this app claims the chain-era policy vocabulary
	 * (`app:act`, `outbound:launch`, `session:net-read`, `approve:self`), which
	 * carries DESIGN.md §14's three-tier approval policy and has no honest
	 * fs/net/proc equivalent — so under the cell loop every one of them would be
	 * refused, no matter how wide the envelope.
	 *
	 * See LIBRARY-CHANGE-REQUESTS.md entry 2.
	 */
	test("an app-vocabulary capability claim is refused by the loop's envelope", async () => {
		const events = await run({ turns: [CALL_CELL], capabilities: ["app:act"] });
		expect(settledMessages(events).join("\n")).toContain(
			"outside this run's capability envelope",
		);
	});
});
