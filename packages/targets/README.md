# @smthrs/targets

`@smthrs/targets` defines the pure authoring surface used by `BUILD.ts` files.
Target calls perform no filesystem reads and start no processes. They return
Flow declarations with planner metadata attached.

The package exports one named namespace, `Smithers`, the way `effect` exports
`Effect`. A `BUILD.ts` file imports it once and reaches the whole catalog
through it, so the import line never changes as a workspace grows. Library code
that consumes this package imports the module it needs directly instead, as
`@smthrs/targets/Target`.

Every catalog target is implemented. Only the `Target.ts` stub machinery remains,
for future catalog additions.

A workspace declares its toolchain once and passes it to everything that runs a
tool. `Smithers.Runtime.Node` and `.Bun` declare a runtime;
`Smithers.PackageManager.Pnpm`, `.Npm`, `.Yarn`, and `.BunPackages` declare a
package manager over one. `Runtime` and `PackageManager` are each both the
namespace their constructors live under and the type those constructors return.
Every tool-running target takes the manager as a required attr and asks
`Smithers.PackageManager.exec` for its argv, so nothing in the catalog spells
`pnpm` or `node` into an argv of its own and switching either is one edit to the
root `BUILD.ts` file.

```ts
import { Smithers } from "@smthrs/targets"

export const runtime: Smithers.Runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })
export const nodeModules = Smithers.Install({ packageManager })
```

`Smithers.Secret("NAME")` declares a credential without reading it. The value is
resolved lazily, at execution, and only for a target that declared the secret;
what reaches a child process is an unguessable placeholder that the
substituting proxy replaces on outbound requests. Key material records the
variable name, never the value.

`Smithers.Workspace` is the workspace configuration declaration the root
`BUILD.ts` file exports. It validates and performs
no I/O. `cacheDirectory` defaults to `.flows` and must name a single
workspace-relative directory; `gitignored` defaults to false. The CLI resolves
the declaration against `--cache-dir` and passes the result explicitly to
`Input` glob expansion. `DepsLint` uses a constant plan-time token that the
exec layer replaces with the resolved directory immediately before spawn. The
resolved directory is host state and never reaches target attrs, a cache key, or
a content digest.

`Smithers.RemoteCache.make({ endpoint, token })` is the matching inert declaration for
the HTTP result cache. The endpoint must use HTTPS. `token` is a `Secret`
declaration and defaults to `Smithers.Secret("SMITHERS_CACHE_TOKEN")`; the bearer token
value is never a declaration field or key input.

See `../API-REVIEW.md` for the review order and current API questions.
