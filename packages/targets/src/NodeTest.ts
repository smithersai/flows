/**
 * `node --test` suites.
 *
 * The runner built into Node executes an explicit, ordered file list, which
 * makes the test set itself declared key material rather than a glob the tool
 * discovers. This models the smithers `node --test scripts/*.test.mjs` gates
 * and tevm's `test:eip3155` suite.
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
 * Attributes for {@link NodeTest}.
 *
 * `tests` is the explicit, ordered list of test files passed to the runner.
 * `sources` is the read set beyond the test files: every module and fixture a
 * suite reads is declared here, because only a declared read is key material.
 * `deps` carries the targets whose outputs the suites read. `cwd` is the
 * workspace-relative directory the runner starts in and defaults to the
 * workspace root. `env` declares the environment variables the suites read
 * and is key material. `concurrency` maps to the runner's `--concurrency`
 * flag; `null` omits it and keeps the runner default.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  tests: Schema.Array(Input.File),
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed({}))
  ),
  cwd: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("."))
  ),
  concurrency: Schema.NullOr(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
  ).pipe(
    Schema.withConstructorDefault(Effect.succeed(null))
  )
})

/**
 * Attributes for {@link NodeTest}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Runs `node --test` over an explicit file list.
 *
 * The plan records one {@link Exec.Exec} node that runs `--test` under the
 * registered toolchain runtime, from `cwd`, with the declared environment and
 * the declared test files in order. Test and source digests are declared
 * through the attrs, and dependency target keys and the declared environment
 * complete the key material. The target is cacheable: a suite that reads a
 * file nobody declared is an unkeyed input, so the read set is the contract
 * that makes the cache sound.
 *
 * The interpreter is the registered runtime. On a Node workspace the argv is
 * `node --test`; a workspace on another runtime declares that runtime's own
 * test rule instead.
 *
 * Executing the plan requires {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const NodeTest = Target.make("NodeTest", {
  attrs: Attrs,
  kinds: ["test"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: true,
  implementation: (attrs) => {
    const toolchain = PackageManager.registeredToolchain()
    return Target.runTool({
      cwd: attrs.cwd,
      env: attrs.env,
      argv: Runtime.run(toolchain.runtime, [
        "--test",
        ...(attrs.concurrency === null ? [] : ["--concurrency", String(attrs.concurrency)]),
        ...attrs.tests.map((test) => test.path)
      ])
    })
  }
})
