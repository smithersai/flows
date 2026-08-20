/**
 * Measures the `grep` and `glob` flows against a real repository tree.
 *
 * The queries are the ones the wave-2 SWE-bench run issued on
 * `pytest-dev__pytest-6197`, read out of that run's journal
 * (`evals/swebench/work/pytest-dev__pytest-6197/.flows/engine.db`). The host
 * composition is the one `@smthrs/cli` builds for a real run: the kernel's
 * permission-checked filesystem and spawner over the Node platform.
 *
 *     bun packages/std/scripts/search-bench.ts <testbed-root> [portable|native]
 */
import { NodeServices } from "@effect/platform-node"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { Effect, Layer } from "effect"
import { resolve } from "node:path"
import * as Glob from "../src/Glob.ts"
import * as Grep from "../src/Grep.ts"

const root = resolve(process.argv[2] ?? ".")

const GREP_QUERIES = [
  { pattern: "__init__\\.py|isinitpath|pytest_collect_file", root: "src", include: "*.py", limit: 200 },
  { pattern: "__init__\\.py", root: "testing", include: "*.py", limit: 200 },
  { pattern: "path_matches_patterns|python_files", root: "src/_pytest", include: "*.py", limit: 100 },
  { pattern: "Package|__init__\\.py|package", root: "testing", include: "test_collection.py", limit: 100 },
  { pattern: "path_matches_patterns", root: "src/_pytest", include: "*.py", literal: true, limit: 50 },
  { pattern: "path_matches_patterns", root: "src", literal: true, limit: 50 },
  { pattern: "pkginit|__init__\\.py|path_matches_patterns", root: "testing", include: "*.py", limit: 100 },
  { pattern: "path_matches_patterns", root: ".", literal: true, limit: 50 }
]

const GLOB_QUERIES = [
  { pattern: "*.py", root: "src" },
  { pattern: "**/test_collection.py", root: "." },
  { pattern: "*.py", root: "." }
]

const host = Layer.provideMerge(AtomicFileSystem.layer, NodeServices.layer)
const platform = Layer.orDie(KernelFileSystem.layer).pipe(
  Layer.provide([Workspace.layer(root), GrantStore.layerNoop]),
  Layer.provideMerge(host)
)
const guarded = KernelChildProcessSpawner.layer.pipe(
  Layer.provide(GrantStore.layerNoop),
  Layer.provideMerge(platform)
)

const time = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const started = performance.now()
    const value = yield* Effect.orElseSucceed(effect, () => ({ matches: [], filesSearched: -1, paths: [], total: -1 }) as never)
    const elapsed = performance.now() - started
    return { elapsed, value, label }
  })

const program = Effect.gen(function*() {
  let total = 0
  for (const query of GREP_QUERIES) {
    const { elapsed, value } = yield* time("", Grep.run(query as never))
    total += elapsed
    console.log(
      `grep ${JSON.stringify(query.pattern)} root=${query.root}`.padEnd(70)
        + `${elapsed.toFixed(0).padStart(8)} ms  matches=${value.matches.length} files=${value.filesSearched}`
    )
  }
  for (const query of GLOB_QUERIES) {
    const { elapsed, value } = yield* time("", Glob.run(query as never))
    total += elapsed
    console.log(
      `glob ${JSON.stringify(query.pattern)} root=${query.root}`.padEnd(70)
        + `${elapsed.toFixed(0).padStart(8)} ms  paths=${value.paths.length}/${value.total}`
    )
  }
  console.log(`${"TOTAL".padEnd(70)}${total.toFixed(0).padStart(8)} ms`)
})

await Effect.runPromise(Effect.provide(program, guarded) as Effect.Effect<void, unknown, never>)
