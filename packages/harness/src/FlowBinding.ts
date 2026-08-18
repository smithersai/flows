/**
 * The executable-flow binding contract.
 *
 * A cell's only authority is `ctx.call(flow, input)`, so *every* capability an
 * agent can reach — a standard filesystem flow, a memory flow, an incoming MCP
 * tool, a durable child agent — has to arrive as an ordinary flow declaration
 * plus the code that runs it. This module is the smallest contract that pairs
 * the two.
 *
 * Three types carry the whole idea:
 *
 * - a {@link Binding} is one flow declaration, its projected
 *   `Descriptor.FlowDescriptor`, and a runner that decodes cell input through
 *   the flow's input schema, executes the handler, and validates the handler's
 *   output back into serializable JSON;
 * - a {@link Source} produces bindings, possibly effectfully, so a lazily
 *   connected server or a plugin can contribute without being resolved at
 *   import time;
 * - a {@link Catalog} is the deterministic composition of sources, and it
 *   refuses duplicate executable names rather than letting one descriptor be
 *   dispatched to another implementation.
 *
 * This is deliberately *not* a second registry. The descriptors a catalog
 * projects are ordinary `FlowDescriptor`s, and {@link registry} composes them
 * onto an existing `Registry.Registry` behind that same contract — with the
 * file-discovered entries winning, so discovery precedence is untouched.
 *
 * The failure split is the one `EngineLike.call` declares. A refusal the agent
 * could plausibly correct — malformed input, a flow that failed, output that is
 * not serializable — becomes a `failure` {@link Cell.CallResult} the cell
 * observes as a catchable exception. Anything the cell must never swallow — a
 * permission requirement, an abort, a suspension — stays in the typed error
 * channel, and an interruption is never caught at all.
 *
 * Governing design: `docs/specs/Concepts/Durable Cell Loop.md` and
 * `docs/specs/Concepts/Flow Registry.md`.
 *
 * @since 0.1.0
 */
import * as Permission from "@smthrs/capability/Permission"
import type * as Effects from "@smthrs/core/Effects"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import type { Context, Schema as SchemaTypes } from "effect"
import { Effect, Option, Result, Schema } from "effect"
import type * as Cell from "./Cell.ts"
import { CallResult } from "./Cell.ts"
import { HarnessError } from "./HarnessError.ts"

/**
 * The declaration half of a binding.
 *
 * Structural on purpose: a `Flow.Flow` from `@smthrs/core` satisfies it, and
 * so does any other value that declares the same four fields, which keeps this
 * module from depending on flow construction.
 *
 * @category models
 * @since 0.1.0
 */
export interface Declared {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
}

/**
 * The metadata a projected descriptor needs that a flow declaration does not
 * carry.
 *
 * Every default is the conservative one: a binding is model-invocable, has no
 * placement, and is attributed to the `binding` source.
 *
 * @category models
 * @since 0.1.0
 */
export interface DescriptorOptions {
  /** Overrides the declaration's own name. */
  readonly name?: string | undefined
  /** The stable locator recorded as the descriptor's body and path. */
  readonly path?: string | undefined
  readonly modelInvocable?: boolean | undefined
  readonly placement?: Option.Option<Descriptor.Placement> | undefined
  readonly provenance?: Descriptor.Provenance | undefined
}

/**
 * The conservative effect declaration used when a flow declares none.
 *
 * `irreversible` is the safe default: it is never content-shared across
 * executions, so a binding that forgot to declare its tier can never replay
 * another run's recorded result.
 */
const declaredEffects = (effects: Effects.Declaration | undefined): Descriptor.EffectDeclaration => ({
  reads: effects?.reads ?? [],
  writes: effects?.writes ?? [],
  mode: effects?.mode ?? "expected",
  onConflict: effects?.onConflict ?? "serialize",
  tier: effects?.tier ?? "irreversible"
})

/**
 * Projects an ordinary flow declaration into a registry descriptor.
 *
 * @category conversions
 * @since 0.1.0
 */
export const descriptorOf = (
  declaration: Declared,
  options: DescriptorOptions = {}
): Descriptor.FlowDescriptor => {
  const name = options.name ?? declaration.name ?? ""
  const path = options.path ?? `binding://${name}`
  return new Descriptor.FlowDescriptor({
    name,
    description: declaration.description ?? "",
    body: new Descriptor.BodyRefModule({ path }),
    input: new Descriptor.SchemaRefModule({ path, field: "input" }),
    output: new Descriptor.SchemaRefModule({ path, field: "output" }),
    model: Option.none(),
    flows: [],
    capabilities: declaration.capabilities,
    effects: declaredEffects(declaration.effects),
    placement: options.placement ?? Option.none(),
    modelInvocable: options.modelInvocable ?? true,
    path,
    frontmatter: {},
    provenance: options.provenance ?? new Descriptor.Provenance({ source: "binding", root: "binding://" })
  })
}

/**
 * One flow declaration and the code that runs it.
 *
 * `R` is whatever the handler still needs from the host. A catalog only accepts
 * fully supplied bindings, so a host uses {@link provide} to close `R` with the
 * context it built.
 *
 * @category models
 * @since 0.1.0
 */
export interface Binding<R = never> {
  readonly descriptor: Descriptor.FlowDescriptor
  readonly run: (call: Cell.Call) => Effect.Effect<CallResult, HarnessError, R>
}

/**
 * A refusal the cell observes as a catchable exception.
 */
const refused = (message: string): CallResult => new CallResult({ outcome: "failure", value: null, message })

/**
 * Renders an arbitrary failure value as stable text for the next frame.
 */
const describe = (error: unknown): string => {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  const message = (error as { readonly message?: unknown } | null)?.message
  return typeof message === "string" ? message : JSON.stringify(error) ?? String(error)
}

/**
 * Decides whether a handler failure is the cell's business.
 *
 * A permission requirement, a denial, and every harness-level failure are the
 * controller's to act on: parking, escalating, or aborting the run. Returning
 * them as call results would let a cell catch its own permission park and
 * proceed as though it had authority.
 */
const escalated = (error: unknown): HarnessError | undefined => {
  if (error instanceof HarnessError) return error
  if (error instanceof Permission.PermissionRequired) {
    return new HarnessError({ code: "suspended", message: error.message, cause: error })
  }
  if (error instanceof Permission.PermissionDenied) {
    return new HarnessError({ code: "suspended", message: error.message, cause: error })
  }
  return undefined
}

/**
 * Everything one executable binding declares.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options<
  I extends SchemaTypes.Top & SchemaTypes.ConstraintDecoder<unknown, never>,
  O extends SchemaTypes.Top & SchemaTypes.ConstraintEncoder<unknown, never>,
  E,
  R
> extends DescriptorOptions {
  /** The ordinary flow declaration. Its schemas are the call's contract. */
  readonly flow: {
    readonly input: I
    readonly output: O
  } & Declared
  /**
   * The runtime implementation, with whatever requirements the host supplies.
   *
   * The decoded input is the whole contract for an ordinary capability. The
   * call is passed as well because a handler that opens a *durable* boundary of
   * its own — a timer, a child run — needs a replay-stable name for it, and
   * `call.identity` is exactly that name: re-executing the cell reaches the
   * same ordinal with the same declaration.
   */
  readonly handler: (input: I["Type"], call: Cell.Call) => Effect.Effect<O["Type"], E, R>
}

/**
 * Binds one flow declaration to its runtime implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <
  I extends SchemaTypes.Top & SchemaTypes.ConstraintDecoder<unknown, never>,
  O extends SchemaTypes.Top & SchemaTypes.ConstraintEncoder<unknown, never>,
  E,
  R = never
>(options: Options<I, O, E, R>): Binding<R> => {
  const descriptor = descriptorOf(options.flow, options)
  const decodeInput = Schema.decodeUnknownResult(options.flow.input)
  const encodeOutput = Schema.encodeUnknownResult(options.flow.output)
  const asJson = Schema.decodeUnknownResult(Schema.Json)
  return {
    descriptor,
    run: (call) =>
      Effect.gen(function*() {
        const decoded = decodeInput(call.input)
        if (decoded._tag === "Failure") {
          return refused(
            `Flow ${descriptor.name} rejected its input: ${
              describe(decoded.failure)
            }. Re-read ctx.flows and reissue the call.`
          )
        }
        const produced = yield* Effect.result(options.handler(decoded.success, call))
        if (produced._tag === "Failure") {
          const escalate = escalated(produced.failure)
          if (escalate !== undefined) return yield* Effect.fail(escalate)
          return refused(`Flow ${descriptor.name} failed: ${describe(produced.failure)}`)
        }
        const encoded = encodeOutput(produced.success)
        if (encoded._tag === "Failure") {
          return refused(`Flow ${descriptor.name} produced output its own schema rejects.`)
        }
        const json = asJson(encoded.success)
        if (json._tag === "Failure") {
          return refused(`Flow ${descriptor.name} produced output that is not serializable.`)
        }
        return new CallResult({ outcome: "success", value: json.success })
      })
  }
}

/**
 * Supplies a binding's remaining requirements from a context the host built.
 *
 * @category combinators
 * @since 0.1.0
 */
export const provide = <R, R2>(
  self: Binding<R>,
  services: Context.Context<R2>
): Binding<Exclude<R, R2>> => ({
  descriptor: self.descriptor,
  run: (call) => Effect.provide(self.run(call), services)
})

/**
 * A named producer of executable bindings.
 *
 * Producing bindings is an effect so a source may connect a server, read a
 * manifest, or resolve a credential the first time a host composes it — the
 * lazy lifecycle an incoming MCP wrapper needs, expressed once here instead of
 * as a special case in the controller.
 *
 * @category models
 * @since 0.1.0
 */
export interface Source {
  readonly name: string
  readonly bindings: () => Effect.Effect<ReadonlyArray<Binding>, HarnessError>
}

/**
 * Constructs a source over a fixed binding list.
 *
 * @category constructors
 * @since 0.1.0
 */
export const source = (name: string, bindings: ReadonlyArray<Binding>): Source => ({
  name,
  bindings: () => Effect.succeed(bindings)
})

/**
 * The deterministic composition of every executable binding a host resolved.
 *
 * @category models
 * @since 0.1.0
 */
export interface Catalog {
  /** Bindings in composition order. */
  readonly entries: ReadonlyArray<Binding>
  /** The same bindings, keyed by flow name. */
  readonly bindings: ReadonlyMap<string, Binding>
  /** The descriptors those bindings project, in composition order. */
  readonly descriptors: ReadonlyArray<Descriptor.FlowDescriptor>
}

/** The empty catalog, which resolves nothing and discloses nothing. */
const emptyCatalog: Catalog = { entries: [], bindings: new Map(), descriptors: [] }

/**
 * The empty catalog.
 *
 * @category constructors
 * @since 0.1.0
 */
export const empty = (): Catalog => emptyCatalog

const duplicate = (name: string): HarnessError =>
  new HarnessError({
    code: "assembly_failed",
    message:
      `Two executable bindings are named "${name}". A flow name resolves to exactly one implementation; rename one or drop it before composing the host.`
  })

const unnamed = (): HarnessError =>
  new HarnessError({
    code: "assembly_failed",
    message: "An executable binding has no flow name. Give the declaration a name, or pass one to FlowBinding.make."
  })

/**
 * Composes bindings into a catalog, refusing duplicate names.
 *
 * @category constructors
 * @since 0.1.0
 */
export const catalogResult = (
  bindings: ReadonlyArray<Binding>
): Result.Result<Catalog, HarnessError> => {
  const composed = new Map<string, Binding>()
  const descriptors: Array<Descriptor.FlowDescriptor> = []
  for (const binding of bindings) {
    const name = binding.descriptor.name
    if (name.length === 0) return Result.fail(unnamed())
    if (composed.has(name)) return Result.fail(duplicate(name))
    composed.set(name, binding)
    descriptors.push(binding.descriptor)
  }
  return Result.succeed({
    entries: Object.freeze([...bindings]),
    bindings: composed,
    descriptors: Object.freeze(descriptors)
  })
}

/**
 * Resolves ordered sources into one catalog.
 *
 * @category constructors
 * @since 0.1.0
 */
export const catalog = (
  sources: ReadonlyArray<Source>
): Effect.Effect<Catalog, HarnessError> =>
  Effect.gen(function*() {
    const collected: Array<Binding> = []
    for (const entry of sources) {
      collected.push(...(yield* entry.bindings()))
    }
    return yield* Effect.fromResult(catalogResult(collected))
  })

/**
 * Discloses a catalog's descriptors through an existing registry.
 *
 * File-discovered entries win: a binding whose name a source already discovered
 * is not disclosed, which is what keeps `flow.ts > flow.mdx > SKILL.md`
 * precedence exactly where discovery put it. The shadowed binding is reported
 * as an ordinary `duplicate_name` warning rather than silently dispatched, and
 * the resolver refuses the shadowed name catchably.
 *
 * @category constructors
 * @since 0.1.0
 */
export const registry = (base: Registry.Registry, self: Catalog): Registry.Registry => {
  const added = (entries: ReadonlyArray<Descriptor.FlowDescriptor>): ReadonlyArray<Descriptor.FlowDescriptor> => {
    const discovered = new Set(entries.map((entry) => entry.name))
    return self.descriptors.filter((entry) => !discovered.has(entry.name))
  }
  const list = () => Effect.map(base.list(), (entries) => [...entries, ...added(entries)])
  // Shadowing is decided against everything discovery found, never against the
  // narrower visible set. A discovered entry that is not model-invocable still
  // owns its name — resolving it is what `getOption` does — so deciding
  // visibility against `base.visible()` would disclose a binding the boundary
  // then refuses on every call, and would make `visible()` report a flow
  // `list()` does not contain.
  const visible = () =>
    Effect.gen(function*() {
      const shown = yield* base.visible()
      const discovered = yield* base.list()
      return [...shown, ...added(discovered).filter((entry) => entry.modelInvocable)]
    })
  const getOption = (name: string) =>
    Effect.flatMap(base.getOption(name), (found) =>
      Option.isSome(found)
        ? Effect.succeed(found)
        : Effect.map(base.list(), (entries) =>
          entries.some((entry) => entry.name === name)
            ? Option.none()
            : Option.fromUndefinedOr(self.bindings.get(name)?.descriptor)))
  return Registry.makeNoop({
    list,
    visible,
    getOption,
    get: (name) =>
      Effect.flatMap(getOption(name), (found) => Option.isSome(found) ? Effect.succeed(found.value) : base.get(name)),
    loadBody: base.loadBody,
    runPrompt: base.runPrompt,
    refresh: base.refresh,
    warnings: () =>
      Effect.gen(function*() {
        const declared = yield* base.warnings()
        const entries = yield* base.list()
        const discovered = new Set(entries.map((entry) => entry.name))
        const shadowed = self.descriptors.filter((entry) => discovered.has(entry.name)).map((entry) =>
          new Descriptor.DiscoveryWarning({
            code: "duplicate_name",
            path: entry.path,
            name: entry.name,
            message:
              `Executable binding "${entry.name}" is shadowed by a discovered flow; the discovered entry keeps the name.`
          })
        )
        return [...declared, ...shadowed]
      })
  })
}
