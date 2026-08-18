"""Package-rule wrappers that opt out of Gazelle management.

Gazelle's JS plugin owns every rule of kind npm_package: it rewrites srcs
from its own model and deletes npm_package rules when generation is disabled.
This repository's packages ship sources (exports map to ./src/*.ts), which
the plugin's model does not represent, so the pkg rule must carry a
hand-maintained srcs list. Instantiating npm_package through this macro
changes the rule's kind string, and Gazelle leaves kinds it does not know
alone. The rule is a plain npm_package in every other respect.

publishable = True (the default) adds a `pkg.publish` target (`bazel run`)
that publishes the package to npm; the release train runs it for every
package whose package.json carries smthrs.group "engine".
"""

load("@aspect_rules_js//npm:defs.bzl", _npm_package = "npm_package")

def workspace_npm_package(publishable = True, **kwargs):
    _npm_package(publishable = publishable, **kwargs)
