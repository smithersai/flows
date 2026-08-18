"""Linter aspects for the flows workspace.

`bazel build --config=lint //...` applies these aspects over the normal build
graph. Lint actions are ordinary Bazel actions: sandboxed, cached, and
remote-execution eligible.

The ESLint aspect visits ts_project targets. ESLint 9 discovers flat config
from the working directory, which under the aspect is the Bazel bin root, so
the aspect supplies the root aggregator config (//:eslint_config); that config
imports each package's own eslint.config.js with its files globs re-scoped.
Each package wraps its config in a js_library so the config, the shared jsdoc
convention, and the plugin packages are all declared action inputs.
"""

load("@aspect_rules_lint//lint:eslint.bzl", "lint_eslint_aspect")

eslint = lint_eslint_aspect(
    binary = Label("//tools/lint:eslint"),
    configs = [Label("//:eslint_config")],
)
