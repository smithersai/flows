/**
 * Serializable input to one harness run.
 *
 * The layer, capability, and placement declarations project
 * `packages/core/src/KeyMaterial.ts` and the canonical registry descriptor in
 * `packages/registry/src/Descriptor.ts`. Governing notes are
 * `docs/specs/Concepts/Flow Builder Brief.md` and
 * `docs/specs/Concepts/Step Keys.md`.
 *
 * @since 0.1.0
 */
import * as Capability from "@smthrs/capability/Capability"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import type * as HostServices from "@smthrs/kernel/HostServices"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Effect, Schema } from "effect"
import type { Layer } from "effect"

/**
 * A resolved `harness:model` seat.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Seat = Schema.String.check(
  Schema.makeFilter(
    (seat) => {
      const separator = seat.indexOf(":")
      return separator > 0 && separator < seat.length - 1
    },
    { expected: "a harness:model seat" }
  )
)

/**
 * A resolved `harness:model` seat.
 *
 * @category models
 * @since 0.1.0
 */
export type Seat = typeof Seat.Type

/**
 * Recorded text and its declared content digest.
 *
 * @category models
 * @since 0.1.0
 */
export class TextDeclaration extends Schema.Class<TextDeclaration>(
  "flows/harness/AgentStep/TextDeclaration"
)({
  text: Schema.String,
  digest: Schema.String
}) {}

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

const ContextWindowTokens = NonNegativeSafeInt.pipe(
  Schema.withConstructorDefault(Effect.succeed(0)),
  Schema.withDecodingDefaultKey(Effect.succeed(0))
)

/**
 * Serializable declarations needed to run an agent step.
 *
 * Runtime providers, tool implementations, and host implementations are
 * deliberately excluded.
 *
 * @category models
 * @since 0.1.0
 */
export class AgentStep extends Schema.Class<AgentStep>("flows/harness/AgentStep")({
  seat: Seat,
  thinkingLevel: ModelRequest.ReasoningEffort,
  layers: Schema.Array(Schema.String),
  capabilityEnvelope: Schema.Array(Capability.CapabilityPattern),
  placement: Schema.Option(Descriptor.Placement),
  input: Schema.Unknown,
  system: TextDeclaration,
  instructions: Schema.Array(TextDeclaration),
  prompt: TextDeclaration,
  journal: Schema.Array(JournalEvent.Entry),
  activeToolNames: Schema.Array(Schema.String),
  toolDefinitions: Schema.Array(ModelRequest.ToolDefinition),
  contextWindowTokens: ContextWindowTokens,
  envelope: Schema.optional(TextDeclaration),
  environment: Schema.optional(TextDeclaration),
  selfDocumentation: Schema.optional(TextDeclaration)
}) {}

/**
 * The protected host layer accepted at the harness boundary.
 *
 * @category models
 * @since 0.1.0
 */
export type HostLike = Layer.Layer<HostServices.HostService>
