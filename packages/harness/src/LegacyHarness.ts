/**
 * The superseded provider-tool-call loop.
 *
 * This is the original built-in harness: assemble a context window, hand the
 * model a `flow` tool, elaborate its tool calls into a child plan, splice the
 * children through the engine, repeat. It is **not** the production
 * architecture any more — the cell path in `CellTurn` /
 * `@smthrs/engine-harness/CellHarness` is — and it lives behind its own
 * module so that nothing reads as though it were the default.
 *
 * It is kept, and kept working, for one reason: foreign agent CLIs speak the
 * provider tool-call protocol, and the adapters in `plugins/packages/adapters`
 * implement the neutral `Harness.Harness` contract on top of it. Deleting the
 * loop would delete their protocol surface, so the request and tool-event
 * schemas it depends on (`Turn`, `Elaborate`, `Tools`, `FlowTool`, `Plan`)
 * stay exactly where they are.
 *
 * New hosts should compose `CellHarness.run` instead. See
 * `docs/specs/Concepts/Durable Cell Loop.md`.
 *
 * @since 0.1.0
 */
import { Model, ModelRequest } from "@smthrs/model"
import { Registry } from "@smthrs/registry"
import { Cause, Effect, Layer, Option, Schema, Stream } from "effect"
import * as AgentEvent from "./AgentEvent.ts"
import * as AgentStep from "./AgentStep.ts"
import * as Assemble from "./Assemble.ts"
import type * as Elaborate from "./Elaborate.ts"
import * as EngineLike from "./EngineLike.ts"
import * as FlowTool from "./FlowTool.ts"
import { Harness } from "./Harness.ts"
import { HarnessError } from "./HarnessError.ts"
import * as Steering from "./Steering.ts"
import * as Tools from "./Tools.ts"
import * as Turn from "./Turn.ts"
import * as Visibility from "./Visibility.ts"

/**
 * Resume carry-over supplied by the owning engine, outside declared key
 * material.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class ResumeState extends Schema.Class<ResumeState>("flows/harness/Harness/ResumeState")({
  agentEngine: Schema.String,
  agentResume: Schema.String,
  discardResumeSession: Schema.Boolean
}) {}

/**
 * Optional carried state for constructing the legacy adapter.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MakeOptions {
  readonly resume?: ResumeState | undefined
  readonly visibility?: ReadonlyArray<Visibility.Seat> | undefined
}

const modelIdFromSeat = (seat: string): string => {
  const separator = seat.indexOf(":")
  return separator < 0 ? seat : seat.slice(separator + 1)
}

const normalizedToolName = (name: string): string => name.trim().toLowerCase()

const visibilityFor = (
  seat: string,
  configured: ReadonlyArray<Visibility.Seat> | undefined
): Visibility.Seat =>
  configured?.find((candidate) => candidate.name === seat) ??
    Visibility.make({
      name: seat,
      rules: [new Visibility.Rule({ effect: "allow", pattern: "*" })]
    })

const normalizeCause = (cause: Cause.Cause<HarnessError>): HarnessError => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (error !== undefined) return error
  return new HarnessError({
    code: Cause.hasInterrupts(cause) ? "aborted" : "unknown",
    message: Cause.hasInterrupts(cause) ? "Harness run interrupted" : "Harness run failed",
    cause
  })
}

/**
 * Captures the legacy harness dependencies from the current layer context.
 *
 * The `Model` service is captured as part of the selected seat even though
 * cache consultation and durable model settlement are delegated through the
 * engine port.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (
  options: MakeOptions = {}
): Effect.Effect<
  Harness,
  never,
  Model.Model | Registry.Registry | EngineLike.EngineLike | Steering.Source
> =>
  Effect.gen(function*() {
    yield* Model.Model
    const registry = yield* Registry.Registry
    const engine = yield* EngineLike.EngineLike
    const steering = yield* Steering.Source

    return Harness.of({
      run: (step, host) => {
        void host
        const stream = Stream.unwrap(
          Effect.fn("LegacyHarness.run")(function*() {
            const decodedStep = Schema.decodeUnknownResult(AgentStep.AgentStep)(step)
            if (decodedStep._tag === "Failure") {
              return Stream.fail(
                new HarnessError({
                  code: "invalid_step",
                  message: "The harness received an invalid agent step",
                  cause: decodedStep.failure
                })
              )
            }
            const currentStep = decodedStep.success
            const descriptors = yield* registry.visible()
            const seatVisibility = visibilityFor(currentStep.seat, options.visibility)
            const visibleDescriptors = Visibility.filter(descriptors, seatVisibility)
            const declarations: Record<string, Elaborate.FlowDeclaration> = {}
            for (const descriptor of visibleDescriptors) {
              declarations[descriptor.name] = {
                flowName: descriptor.name,
                input: Schema.Unknown,
                capabilities: descriptor.capabilities,
                effects: descriptor.effects,
                placement: descriptor.placement
              }
            }
            const catalog: Elaborate.Catalog = { tools: declarations }
            const modelParams = ModelRequest.GenerationParams.make({
              reasoningEffort: currentStep.thinkingLevel
            })
            const definitions = yield* Effect.fromResult(Tools.Catalog.makeResult([
              FlowTool.definition,
              ...currentStep.toolDefinitions.filter(
                (definition) => normalizedToolName(definition.name) !== normalizedToolName(FlowTool.definition.name)
              )
            ])).pipe(
              Effect.mapError((cause) =>
                new HarnessError({
                  code: "assembly_failed",
                  message: "Unable to assemble the harness context",
                  cause
                })
              )
            )
            const loaderNames = Tools.initial(definitions).map((definition) => definition.name)
            const contextWindow = Assemble.assemble({
              journal: currentStep.journal,
              system: currentStep.system,
              instructions: currentStep.instructions,
              prompt: currentStep.prompt,
              modelId: modelIdFromSeat(currentStep.seat),
              params: { ...modelParams },
              flowInput: currentStep.input,
              activeToolNames: [...loaderNames, ...currentStep.activeToolNames],
              toolDefinitions: definitions.definitions,
              registry: visibleDescriptors,
              seat: seatVisibility,
              envelope: currentStep.envelope,
              environment: currentStep.environment,
              selfDocumentation: currentStep.selfDocumentation
            })
            const turn = Turn.run({
              state: Turn.make({
                seat: currentStep.seat,
                modelParams,
                layers: currentStep.layers,
                capabilityEnvelope: currentStep.capabilityEnvelope,
                placement: currentStep.placement,
                contextWindow,
                contextWindowTokens: currentStep.contextWindowTokens
              }),
              catalog
            }).pipe(
              Stream.provideService(EngineLike.EngineLike, engine),
              Stream.provideService(Steering.Source, steering)
            )
            if (options.resume === undefined) return turn
            return Stream.concat(
              Stream.succeed(
                new AgentEvent.ResumeToken({
                  eventType: "flows.harness.resume-token.v1",
                  agentEngine: options.resume.agentEngine,
                  agentResume: options.resume.agentResume,
                  discardResumeSession: options.resume.discardResumeSession
                })
              ),
              turn
            )
          })()
        )
        return stream.pipe(
          Stream.catchCause((cause) => Stream.fail(normalizeCause(cause)))
        )
      }
    })
  })

/**
 * Provides the legacy harness and captures its runtime dependencies.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (
  options: MakeOptions = {}
): Layer.Layer<
  Harness,
  never,
  Model.Model | Registry.Registry | EngineLike.EngineLike | Steering.Source
> => Layer.effect(Harness)(make(options))
