/**
 * Replay-safe active-tool policy for the harness.
 *
 * @since 0.1.0
 */
import type { ModelRequest } from "@smthrs/model"
import { Result, Schema } from "effect"

/**
 * Stable failures produced while validating harness tool declarations.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ToolErrorCode = Schema.Literals(["lazy_tool_prompt_metadata"])

/**
 * Stable failures produced while validating harness tool declarations.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ToolErrorCode = typeof ToolErrorCode.Type

/**
 * Stable failures produced while validating harness tool declarations.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class ToolError extends Schema.TaggedError<ToolError>()("flows/harness/ToolError", {
  code: ToolErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * A lazy definition carries only provider tool wire fields. Prompt content is
 * intentionally not representable here: it would invalidate cached prefixes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface LazyDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly deferred: true
  readonly loader?: boolean | undefined
}

/**
 * The complete, declaration-ordered set of registered provider tools.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Catalog {
  readonly definitions: ReadonlyArray<ModelRequest.ToolDefinition>
}

const normalizedName = (name: string): string => name.trim().toLowerCase()

const hasPromptMetadata = (definition: object): boolean =>
  Object.keys(definition).some((key) => /^(?:prompt(?:snippet|guidelines)?|guidelines)$/i.test(key))

const lazyMetadataError = (): ToolError =>
  new ToolError({
    code: "lazy_tool_prompt_metadata",
    message: "Deferred tools may not carry prompt-modifying metadata"
  })

const checkedDefinitions = (
  definitions: ReadonlyArray<ModelRequest.ToolDefinition>
): Result.Result<ReadonlyArray<ModelRequest.ToolDefinition>, ToolError> => {
  for (const definition of definitions) {
    if (definition.deferred === true && hasPromptMetadata(definition)) return Result.fail(lazyMetadataError())
  }
  return Result.succeed(definitions)
}

const uncheckedCatalog = (definitions: ReadonlyArray<ModelRequest.ToolDefinition>): Catalog => ({ definitions })

/**
 * Constructs an ordered catalog. It does not alter a definition or perform
 * deferred-provider lowering; that protocol work remains in `/model`.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const Catalog = {
  /**
   * Constructs a catalog after validating deferred definitions.
   *
   * @category constructors
   * @since 0.1.0
   */
  makeResult: (definitions: ReadonlyArray<ModelRequest.ToolDefinition>): Result.Result<Catalog, ToolError> =>
    Result.map(checkedDefinitions(definitions), uncheckedCatalog)
}

/**
 * Produces the wire-safe lazy projection of one definition.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const lazy = (definition: ModelRequest.ToolDefinition): LazyDefinition => {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    deferred: true,
    ...(definition.loader === undefined ? {} : { loader: definition.loader })
  }
}

/**
 * Produces the wire-safe lazy projection of one definition with typed
 * validation failure data.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const lazyResult = (
  definition: ModelRequest.ToolDefinition
): Result.Result<LazyDefinition, ToolError> =>
  hasPromptMetadata(definition)
    ? Result.fail(lazyMetadataError())
    : Result.succeed(lazy(definition))

/**
 * Returns the initial active set. Loader tools remain active for the complete
 * session; ordinary registered tools await a recorded loader result.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const initial = (catalog: Catalog): ReadonlyArray<ModelRequest.ToolDefinition> =>
  catalog.definitions.filter((definition) => definition.loader === true)

/**
 * Adds the names recorded on a loader result to the active set. The operation
 * is idempotent and declaration ordered, so replaying the same result derives
 * the same request without any process-local activation state.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const activate = (
  catalog: Catalog,
  active: ReadonlyArray<ModelRequest.ToolDefinition>,
  addedToolNames: ReadonlyArray<string>
): ReadonlyArray<ModelRequest.ToolDefinition> => {
  const enabled = new Set(active.map((definition) => normalizedName(definition.name)))
  for (const definition of catalog.definitions) {
    if (definition.loader === true) enabled.add(normalizedName(definition.name))
  }
  for (const name of addedToolNames) enabled.add(normalizedName(name))
  return catalog.definitions.filter((definition) => enabled.has(normalizedName(definition.name)))
}
