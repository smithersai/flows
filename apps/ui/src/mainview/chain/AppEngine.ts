/*
 * The app-side `EngineLike`: the harness cell loop's engine port, implemented
 * over what the browser actually has.
 *
 * `EngineLike` is a PORT, and its durability contract is the implementation's
 * own ("the implementation owns durability"). The durable flow engine's version
 * (`@smthrs/engine-harness` FlowEngineLike) keys every sealed step and every
 * call into a journal so a crashed run replays instead of re-executing. This
 * app has no cross-process replay to serve: a turn lives inside one browser
 * fiber, and the residency that survives a reload is the persisted TanStack
 * collection the journal writes to — the same discipline CollectionJournal.ts
 * already uses. So the four operations the cell path needs are implemented
 * directly, and the journal records what a reload has to reconcile.
 *
 * Mounting the durable engine in the browser is recorded as a follow-up rather
 * than forced: doing it would need library changes, and packages/* is not this
 * port's to change.
 */
import * as Cell from "@smthrs/harness/Cell";
import * as EngineLike from "@smthrs/harness/EngineLike";
import type * as FlowBinding from "@smthrs/harness/FlowBinding";
import { HarnessError } from "@smthrs/harness/HarnessError";
import * as Model from "@smthrs/model/Model";
import { Effect, Stream } from "effect";

/** How a park reaches the controller: the loop's error channel, named. */
export class Parked extends HarnessError {}

export interface AppEngineOptions {
	/** The relay-backed model seat this turn streams through. */
	readonly model: Model.Model;
	/** The bindings a cell may call, keyed by flow name. */
	readonly catalog: FlowBinding.Catalog;
	/**
	 * Records one nondeterministic controller read.
	 *
	 * A live browser turn re-executes nothing, so the default performs the read
	 * and returns it. The runtime passes a journalling implementation when the
	 * read has to survive a reload.
	 */
	readonly journal?: (name: string, frame: number, value: unknown) => void;
	/** Called when the loop parks, before the error reaches the controller. */
	readonly onSuspend?: (reason: EngineLike.SuspendReason) => void;
}

const missing = (name: string): HarnessError =>
	new HarnessError({
		code: "assembly_failed",
		message: `No flow named "${name}" is registered. Re-read ctx.flows and reissue the call.`,
	});

/**
 * Builds the engine port one turn runs on.
 *
 * @category constructors
 */
export const make = (options: AppEngineOptions): EngineLike.EngineLike =>
	EngineLike.make({
		/*
		 * A sealed step is a provider-neutral request the seat already knows how to
		 * stream. The durable engine additionally digests the prepared wire request
		 * into a step key so an identical request replays; nothing here replays, so
		 * the key material is carried by the step and unused rather than recomputed
		 * incorrectly.
		 */
		sealStep: (step) => options.model.stream(step.request),

		/*
		 * The cell path never splices plan batches: batching exists for the
		 * elaborate/child path, which this loop does not take. Refusing loudly
		 * beats returning an empty stream that would read as "nothing to do".
		 */
		splice: () =>
			Stream.fail(
				new HarnessError({
					code: "engine_failed",
					message: "The browser cell loop does not splice plan batches",
				}),
			),

		/*
		 * One flow call from inside a cell. The binding decodes the input through
		 * the flow's own schema and settles a failure as a catchable CallResult, so
		 * everything this has to own is resolution: an unknown name is a harness
		 * failure, never a silent success.
		 */
		call: (call: Cell.Call) => {
			const binding = options.catalog.bindings.get(call.flowName);
			return binding === undefined ? Effect.fail(missing(call.flowName)) : binding.run(call);
		},

		record: <A>(boundary: EngineLike.RecordBoundary<A>) =>
			boundary.execute.pipe(
				Effect.tap((value) =>
					Effect.sync(() => {
						options.journal?.(boundary.name, boundary.identity.frame, value);
					}),
				),
			),

		suspend: (reason) =>
			Effect.suspend(() => {
				options.onSuspend?.(reason);
				return Effect.fail(
					new Parked({ code: "suspended", message: reason.message, cause: reason }),
				);
			}),
	});
