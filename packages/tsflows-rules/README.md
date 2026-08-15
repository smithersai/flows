# tsflows-rules

`tsflows-rules` defines the pure authoring surface used by `BUILD.ts` files.
Rule calls perform no filesystem reads and start no processes. They return
Flow declarations with planner metadata attached.

Only `PnpmWorkspace` has an executable implementation. Every other catalog
rule plans normally and reaches a typed `NotImplemented: <rule>` failure if a
caller deliberately executes it.

`Workspace` is the workspace configuration declaration the root `BUILD.ts` file
exports. `Workspace({ cacheDirectory, gitignored })` validates and performs
no I/O. `cacheDirectory` defaults to `.flows` and must name a single
workspace-relative directory; `gitignored` defaults to false. The CLI resolves
the declaration against `--cache-dir` and passes the result explicitly to
`Input` glob expansion. `DepsLint` uses a constant plan-time token that the
exec layer replaces with the resolved directory immediately before spawn. The
resolved directory is host state and never reaches rule attrs, a cache key, or
a content digest.

`RemoteCache.make({ endpoint, tokenEnv })` is the matching inert declaration
for the HTTP result cache. The endpoint must use HTTPS. `tokenEnv` defaults to
`TSFLOWS_CACHE_TOKEN` and names host state; the bearer token value is never a
declaration field or key input.

See `../API-REVIEW.md` for the review order and current API questions.
