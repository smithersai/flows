/**
 * Arbitrary repo scripts declared as lint- or test-kind targets.
 *
 * A hand-written invariant gate, such as smithers' check-single-effect-version
 * or check-dependency-boundaries, is an executable plus a read set. Declaring
 * one as a target makes the gate addressable by the `lint` and `test` verbs
 * and cacheable over exactly the files it reads. `ToolBuild` cannot express
 * this: its kinds are `["build"]` and every declared output must exist after
 * the run, so a check that produces nothing has no declaration form.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Runtime from "./Runtime.ts"
import * as Target from "./Target.ts"

/**
 * The verbs a script check participates in.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Kind = Schema.Literals(["lint", "test"])

/**
 * The verbs a script check participates in.
 *
 * @category models
 * @since 0.1.0
 */
export type Kind = typeof Kind.Type

/**
 * Attributes for {@link ScriptCheck}.
 *
 * `script` is the program the declared runtime executes and `args` is its
 * argument list. `srcs` is the complete read set beyond the script itself:
 * every file the script reads is declared here, because only a declared read
 * is key material. `deps` carries the targets whose outputs the script reads.
 * `kinds` declares which verbs run the check; the target's verb membership is
 * exactly this list, so a lint gate is never selected by `test`. `cwd` is the
 * workspace-relative directory the script runs in and defaults to the
 * workspace root. `env` declares the environment variables the script reads
 * and is key material. `expectedExitCodes` lists the exit codes treated as
 * success and defaults to `[0]`. `timeoutMs` bounds the process lifetime and
 * defaults to ten minutes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  script: Input.File,
  args: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed([]))
  ),
  srcs: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed({}))
  ),
  cwd: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("."))
  ),
  kinds: Schema.NonEmptyArray(Kind),
  expectedExitCodes: Schema.NonEmptyArray(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(0xffff_ffff))
  ).pipe(
    Schema.withConstructorDefault(Effect.succeed([0]))
  ),
  timeoutMs: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Exec.maximumTimeoutMs)
  ).pipe(Schema.withConstructorDefault(Effect.succeed(Exec.defaultTimeoutMs)))
})

/**
 * Attributes for {@link ScriptCheck}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/** The plan body every verb membership shares. */
const implementation = (
  attrs: Attrs
): ReturnType<typeof Target.runTool> => {
  const toolchain = PackageManager.registeredToolchain()
  return Target.runTool({
    cwd: attrs.cwd,
    env: attrs.env,
    argv: Runtime.run(toolchain.runtime, [attrs.script.path, ...attrs.args]),
    expectedExitCodes: [...attrs.expectedExitCodes],
    timeoutMs: attrs.timeoutMs
  })
}

/** Builds one definition with exactly `kinds` as its verb membership. */
const makeDefinition = (kinds: ReadonlyArray<Kind>) =>
  Target.make("ScriptCheck", {
    attrs: Attrs,
    kinds,
    success: Exec.Result,
    error: Exec.ExecError,
    cache: true,
    implementation
  })

/**
 * One definition per declared verb membership.
 *
 * `Target.make` fixes a definition's kinds, and a script check's membership is
 * declared per target, so the definitions are keyed on the membership itself.
 * Every entry shares the attrs schema and the implementation, and with them
 * one implementation digest.
 */
const definitions = new Map<string, ReturnType<typeof makeDefinition>>()

const definitionFor = (kinds: ReadonlyArray<Kind>): ReturnType<typeof makeDefinition> => {
  const unique = [...new Set(kinds)]
  const key = unique.join("")
  const existing = definitions.get(key)
  if (existing !== undefined) return existing
  const created = makeDefinition(unique)
  definitions.set(key, created)
  return created
}

/** Decodes `kinds` alone so a declaration can select its verb membership. */
const KindsProbe = Schema.Struct({ kinds: Schema.NonEmptyArray(Kind) })

/**
 * Declares an arbitrary repo script as a lint- or test-kind target with a
 * declared read set.
 *
 * The plan records one {@link Exec.Exec} node that runs the script under the
 * registered toolchain runtime, from `cwd`, with `args` and the declared
 * environment. The target's verb membership is exactly `kinds`: a target
 * declared with `["lint"]` plans under `lint` and is refused under `test`.
 *
 * The target is cacheable, keyed on the script digest, `args`, the `srcs`
 * digests, dependency outputs, `env`, `expectedExitCodes`, and `timeoutMs`. A
 * script that reads a file nobody declared is an unkeyed input, the same
 * silent-stale class as any undeclared read; the declaration is the contract
 * that makes the cache sound.
 *
 * Executing the plan requires {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const ScriptCheck = (attrs: (typeof Attrs)["~type.make.in"]) => {
  let kinds: ReadonlyArray<Kind>
  try {
    kinds = KindsProbe.make(attrs).kinds
  } catch (cause) {
    throw Target.declarationRejected("ScriptCheck", undefined, cause)
  }
  return definitionFor(kinds)(attrs)
}
