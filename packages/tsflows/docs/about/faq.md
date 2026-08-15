# FAQ

## Is `BUILD.ts` really just TypeScript?

Yes. The CLI imports it through the programmatic `tsx` loader with
`tsconfig: false`. Every named export is inspected. Exports that are targets
become labels, exports that are `Workspace` or `DefaultRule` declarations become
workspace configuration, and everything else is ignored.

One constraint follows from the loader. `tsconfig: false` means no tsconfig is
read, so compiler options declared in the workspace do not apply: a `paths` alias
does not resolve, and a relative import names the real file, extension included,
as in `import { lib } from "../plan/BUILD.ts"`.

## Can a rule call read the filesystem?

No. `Rule.make` requires a pure plan-time body: it records plan nodes and
executes nothing. `file()`, `glob()`, and `gitDiff()` return inert values. The
planner expands and digests them during discovery. See
[Inputs](../concepts/inputs.md).

## How do I reference another target?

Import it.

```ts
import { lib as plan } from "../plan/BUILD.ts"

export const lib = TsBuild({ deps: [plan] /* ... */ })
```

Labels never appear in rule attributes. A target value found anywhere inside an
attrs object becomes a dependency edge. See
[Dependencies](../concepts/dependencies.md).

## Why is there no `run` verb?

`Rule.Kind` includes `run`, and several rules declare it, but `cli/src/Cli.ts`
defines no `run` command. A `run`-kind target is therefore never selected as a
root by `build`, `test`, `lint`, or `ci`. It still appears in `query` and
`graph`, and it still executes when a selected target depends on it.

## Which rules actually execute?

The CLI executor supplies implementations for the shared exec action, the
generated-file write and check actions, and the install actions. Rules built on
those run for real. Rules that call the irreversible-exec or llm-review actions
have no implementation in scope, so executing them fails with an
`unresolved_action` refusal. That is `LlmLint`, `NpmPublish`, `JsrPublish`, and
the `version` operation of `Changesets`. The per-rule status is on each page under
[Rule catalog](../reference/rules/README.md), and the summary table is in
[Running targets](../workspace/running-targets.md).

## Are actions sandboxed?

No. `ExecLive` spawns the tool with `node:child_process` in the workspace, with
`process.env` merged under the payload `env`. Declared effects exist in the
action declarations, and the flows filesystem boundary can capture and replay a
declared `TreeArtifact`, but nothing proves that a process wrote nowhere else.
See [Actions and boundaries](../concepts/actions-and-boundaries.md).

## Is `node_modules` cached?

No. `Install` splits into fetch and link. Fetch populates
`.flows/store/<manager>` and declares it as a `TreeArtifact`, which is
cache-admissible in principle. Link materializes `node_modules` from that store,
declares an `expected` boundary, and is never admitted to a cross-run cache. A
`node_modules` tree is a graph of links into a local store, so restoring one from
another machine would produce a tree pointing at nothing. See
[Install](../concepts/install.md).

## Why do two targets of the same rule need separate runtimes?

A target is a flow tagged by rule id. Two `TsBuild` targets share that tag, so
registering both with one engine would alias their bodies. The executor gives
each target a fresh in-memory runtime. `API-REVIEW.md` records this as an open
API question.

## Does `--plan` tell me whether a target is cached?

No. Planner output still reports `cacheLookup: "not-wired"` and `wouldRun: true`
for every target. The planner computes the content key but consults no cache. The
executor performs the lookup. See [Caching](../workspace/caching.md).

## Does the cache directory affect cache keys?

No, by design. The resolved cache directory is host state. Discovery never lists
a path inside it, declared globs never expand into it, and its name never reaches
a cache key or a content digest. `DepsLint` writes a generated config under it
using a plan-time token that the exec layer substitutes immediately before spawn.
See [Configuration](../workspace/configuration.md).

## Can I move the package-manager store?

Not today. Manager stores stay at `.flows/store/<manager>` regardless of
`cacheDirectory`. Those paths are declared `TreeArtifact` boundaries and
therefore key material, so a configurable location would have to travel as
resolved host state instead of as a declared path. `DESIGN.md` records this as
future work.
