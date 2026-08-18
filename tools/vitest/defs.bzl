"""Vitest under Bazel.

There is no first-class Vitest ruleset for Bazel; the canonical rules_js path
is to run the vitest CLI from the npm dependency graph under `js_test`. The
`vitest_test` macro below wraps the generated `js_test` factory for the vitest
binary.

Semantics that matter here:

- The test action runs in Bazel's sandbox with `chdir` set to the package
  directory, so vitest resolves the package's own vitest.config.ts and
  tsconfig the same way `pnpm test` does.
- Coverage thresholds in vitest.config.ts are enforced by vitest's exit code,
  so the coverage gate is a Bazel test result. The configs in this repository
  already write reports to a pid-scoped directory under the OS temp dir,
  which is writable inside the sandbox.
- Vitest transpiles TypeScript itself (via vite/esbuild). The test does not
  consume the ts_project outputs; it consumes the sources. Both are in `data`.
"""

# rules_js generates the bin factory per lockfile importer. Every package in
# this workspace pins the same vitest version, so the factory is loaded from
# one importer and works for all of them.
load("@npm//packages/canonical:vitest/package_json.bzl", vitest_bin = "bin")

def vitest_test(name, deps, config = "vitest.config.ts", coverage = False, **kwargs):
    """Runs `vitest run` as a Bazel test.

    Args:
        name: target name.
        deps: everything the suite imports: the package's ts_project targets
            (their sources propagate through JsInfo) and node_modules link
            targets for the npm packages the suite loads.
        config: vitest config file label, relative to the package.
        coverage: pass --coverage so threshold gates in the config apply.
        **kwargs: forwarded to the generated js_test.
    """
    args = ["run", "--config", config]
    if coverage:
        args.append("--coverage")

    vitest_bin.vitest_test(
        name = name,
        args = args,
        chdir = native.package_name(),
        data = deps + [config],
        # Vitest forks workers; give Bazel's scheduler an honest signal.
        size = kwargs.pop("size", "medium"),
        **kwargs
    )
