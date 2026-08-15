# Agent package migration

Nineteen `@smthrs/*` packages moved from the agent repository into this pnpm
workspace: cli, control, core, engine-harness, evals, fs, gateway, harness,
memory, model, notifications, observability, patterns, plugin, registry,
scorers, std, testing, and triggers. The workspace globs, root TypeScript
globs, and `StandardPackage` build rule already cover every migrated package.
The lockfile resolves them as ordinary workspace siblings.

The existing `@smthrs/observability-next` package remained the package
identity. Its browser-safe `Otlp` surface remains available. The agent
repository's Logger, JournalLogger, Metric, Resource, NodeOtel, BrowserOtel,
and Otel modules were folded into the same package. NodeOtel and BrowserOtel
remain subpath-only exports so the root package stays browser-bundleable. The
agent package's separate changelog was not copied over because this package
retains the flows repository's existing history and identity.

The stale `@smthrs/host` dependency in the agent triggers manifest had no
source imports. The agent workspace's installed entry was only a symlink into
the old flows mount. Flows commit `94bab62` deleted the real host package after
kernel and the platform packages absorbed its contracts and adapters. The
dependency was removed rather than vendored. Triggers uses the current
database sibling directly. No dangling host dependency remains.

The `queue/` to `factory/queue/` rename was unrelated to package migration. It
was reverted in its own commit, restoring the exact pre-migration queue files
and paths.

The dead chain package from the agent repository was not migrated. A separate
`packages/chain` promoted from the app repository's vendored sources belongs
to the concurrent app migration and is unrelated to this package move. The
agent repository's `flows` symlink package and its old workspace mount were
not migrated. Generated build, coverage, and dependency directories were not
migrated.

Package metadata, exports, scripts, TypeScript projects, build scripts, lint
configuration, and tests were normalized to flows repository conventions.
Dependencies use the workspace's Effect `4.0.0-rc.108` family and current
workspace package identities instead of the agent repository's beta versions
and file links. Compatibility edits adapt the moved sources to those current
Effect and sibling APIs. Registry discovery reads bounded metadata through the
atomic host's supported `readFile` operation; its test double now provides that
operation while still proving that `readFileString` is never used. The cli and
fs coverage configurations preserve their source packages' loaded-module
coverage scope; adding a new all-source include made their unchanged upstream
thresholds fail on modules that those suites do not exercise.

The testing package's graph-root key golden was deliberately re-pinned after
the branch changed plan function identity from FNV-1a source hashes to SHA-256
source hashes. The graph leaf keys did not change. This is an intentional cache
identity break from the plan work stream, not migration-induced drift.

`pnpm install --frozen-lockfile` succeeds. Each of the nineteen migrated
packages is verified independently with its own `check`, `test`, and `lint`
scripts. Root-wide failures caused by concurrent app or tsflows work are not a
migration completion gate and were not modified here. During verification,
in-flight app workspace wiring temporarily made pnpm's automatic dependency
status check attempt an inconsistent install, and in-flight core identity work
temporarily broke plan-dependent tests. The owning runs completed those edits;
the final package gates were rerun against their settled state.
