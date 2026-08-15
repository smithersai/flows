/**
 * The built-in host capabilities, expressed as ordinary executable flows.
 *
 * There is no `ctx.fs`, no `ctx.shell`, no `ctx.memory`, and no `ctx.wait`. A
 * cell that reads a file and a cell that calls a remote MCP tool run the same
 * two lines — look the flow up in `ctx.flows`, invoke it with `ctx.call` — and
 * both boundaries are the same keyed, journaled, permission-gated activity.
 * This module is what makes that true for the standard capabilities: each
 * helper pairs a declaration that already exists (`@smthrs/std`,
 * `@smthrs/memory/Flows`) with the handler that already exists, through the
 * one binding contract in `@smthrs/harness/FlowBinding`.
 *
 * Each helper takes the `Context` the host built, because a handler's
 * requirements are the host's to supply — a browser host provides a different
 * `FileSystem` than a Node host, and neither of them changes what the cell
 * sees.
 *
 * Two capabilities cannot be written generically, and both take a narrow
 * injected port rather than a fake:
 *
 * - {@link approval} needs a human. The port is one `ask`. A host with nobody to
 *   ask refuses with {@link ApprovalUnavailable}, which the cell may catch; a
 *   host that wants the run to *wait* fails with a `HarnessError` carrying a
 *   `Permission.PermissionRequired`, or gates the call in
 *   `CellHarness.authorize` — either way the park stays in the typed error
 *   channel where the cell can neither see nor swallow it.
 * - {@link clock} needs the durable engine, so it is the one helper here whose
 *   context is `FlowEngine`. It is not part of the browser-safe core, and
 *   nothing in `CellHarness` imports it.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import { DurableClock } from "@smthrs/flow-next"
import type { FlowRuntime } from "@smthrs/flow-next"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import type { HarnessError } from "@smthrs/harness/HarnessError"
import type * as ChildProcessSpawner from "@smthrs/kernel-next/ChildProcessSpawner"
import type * as Path from "@smthrs/kernel-next/Path"
import * as MemoryFlows from "@smthrs/memory/Flows"
import type * as MemoryStore from "@smthrs/memory/MemoryStore"
import type * as Recall from "@smthrs/memory/Recall"
import * as Bash from "@smthrs/std/Bash"
import * as Read from "@smthrs/std/Read"
import * as Write from "@smthrs/std/Write"
import type { Context } from "effect"
import { Duration, Effect, Schema } from "effect"
import type * as FileSystem from "effect/FileSystem"

/**
 * Reading and writing files, as two ordinary flows.
 *
 * @category constructors
 * @since 0.1.0
 */
export const filesystem = (
  services: Context.Context<FileSystem.FileSystem | Path.Path>
): FlowBinding.Source =>
  FlowBinding.source("std/filesystem", [
    FlowBinding.provide(FlowBinding.make({ flow: Read.flow, handler: Read.run }), services),
    FlowBinding.provide(FlowBinding.make({ flow: Write.flow, handler: Write.run }), services)
  ])

/**
 * Shell execution, as one ordinary flow.
 *
 * @category constructors
 * @since 0.1.0
 */
export const shell = (
  services: Context.Context<ChildProcessSpawner.ChildProcessSpawner | Path.Path>
): FlowBinding.Source =>
  FlowBinding.source("std/shell", [
    FlowBinding.provide(FlowBinding.make({ flow: Bash.flow, handler: Bash.run }), services)
  ])

/**
 * Durable memory, as two ordinary flows.
 *
 * @category constructors
 * @since 0.1.0
 */
export const memory = (
  services: Context.Context<MemoryStore.MemoryStore | Recall.Recall>
): FlowBinding.Source =>
  FlowBinding.source("memory", [
    FlowBinding.provide(
      FlowBinding.make({ flow: MemoryFlows.remember, handler: MemoryFlows.runRemember }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({ flow: MemoryFlows.recall, handler: MemoryFlows.runRecall }),
      services
    )
  ])

/**
 * Input for the durable wait flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const WaitInput = Schema.Struct({
  seconds: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
    description: "How long to wait, in seconds"
  }),
  reason: Schema.optional(Schema.String).annotate({ description: "Why the run is waiting" })
})

/**
 * Output for the durable wait flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const WaitOutput = Schema.Struct({ waitedSeconds: Schema.Number })

/**
 * The durable wait declaration.
 *
 * `irreversible` is the honest tier: waiting is not content-addressable, so the
 * boundary is run-scoped on the cell identity and a replayed cell returns the
 * recorded completion instead of sleeping again.
 *
 * @category flows
 * @since 0.1.0
 */
export const waitFlow = Flow.make({
  name: "wait",
  description:
    "Wait for a number of seconds before the cell continues. The wait is durable: a replay does not re-wait.",
  input: WaitInput,
  output: WaitOutput,
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})

/**
 * A durable wait, as one ordinary flow.
 *
 * The sleep itself is the engine's `DurableClock`, so a short wait runs in
 * memory and a long one is scheduled by the engine. Either way the enclosing
 * cell call is the durable boundary, which is what makes the wait replay rather
 * than repeat.
 *
 * The clock's name is the call identity, not the duration. A durable clock is
 * identified by name — the deferred it awaits is `DurableClock/<name>` — so
 * naming it after the duration would make a cell that waits twice for the same
 * number of seconds await one already-settled deferred and return from the
 * second wait immediately. The call identity is both unique per call and stable
 * across replay, which is exactly what the name has to be.
 *
 * @category constructors
 * @since 0.1.0
 */
export const clock = (
  services: Context.Context<FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>
): FlowBinding.Source =>
  FlowBinding.source("engine/clock", [
    FlowBinding.provide(
      FlowBinding.make({
        flow: waitFlow,
        handler: (input, call) =>
          Effect.as(
            DurableClock.sleep({
              name:
                `harness/wait/${call.identity.session}/${call.identity.frame}/${call.identity.cell}/${call.identity.ordinal}`,
              duration: Duration.seconds(input.seconds)
            }),
            { waitedSeconds: input.seconds }
          )
      }),
      services
    )
  ])

/**
 * Input for the approval flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AskInput = Schema.Struct({
  question: Schema.String.annotate({ description: "What the run needs a human to decide" }),
  options: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "The answers the run can act on, when the question is a choice"
  })
})

/**
 * Output for the approval flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AskOutput = Schema.Struct({
  answer: Schema.String,
  approved: Schema.Boolean
})

/**
 * The approval declaration.
 *
 * @category flows
 * @since 0.1.0
 */
export const askFlow = Flow.make({
  name: "ask",
  description: "Ask the person running this task a question, and wait for their answer.",
  input: AskInput,
  output: AskOutput,
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})

/**
 * A host that has nobody to ask.
 *
 * Separate from `HarnessError` on purpose: this is a refusal the agent can see
 * and route around, and the binding contract turns it into an ordinary
 * catchable call failure. Parking is the other seam — a host that wants the run
 * to wait for a person fails with a `HarnessError` carrying a
 * `Permission.PermissionRequired`, or gates the call in `CellHarness.authorize`,
 * which is where a park can be re-decided against a later grant instead of
 * being journaled forever.
 *
 * @category errors
 * @since 0.1.0
 */
export class ApprovalUnavailable extends Schema.TaggedError<ApprovalUnavailable>()(
  "flows/engine-harness/ApprovalUnavailable",
  { message: Schema.String }
) {}

/**
 * The narrow host port an approval flow needs.
 *
 * @category models
 * @since 0.1.0
 */
export interface Asker {
  readonly ask: (
    input: typeof AskInput.Type
  ) => Effect.Effect<typeof AskOutput.Type, HarnessError | ApprovalUnavailable>
}

/**
 * Human approval, as one ordinary flow.
 *
 * @category constructors
 * @since 0.1.0
 */
export const approval = (asker: Asker): FlowBinding.Source =>
  FlowBinding.source("host/approval", [
    FlowBinding.make({ flow: askFlow, handler: asker.ask })
  ])

/**
 * An approval port for a host with nobody to ask.
 *
 * @category constructors
 * @since 0.1.0
 */
export const askerNoop = (): Asker => ({
  ask: (input) =>
    Effect.fail(
      new ApprovalUnavailable({
        message: `This host has nobody to ask "${input.question}". Decide without approval or stop.`
      })
    )
})
