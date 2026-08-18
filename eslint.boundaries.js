// The module-boundary gate. Shared by every package's `eslint.config.js`.
//
// The repository already declares a dependency tier in every package manifest
// (`smthrs.group`: "engine" | "agent" | "tooling"). The local Nx plugin in
// tools/nx maps that field onto `group:<tier>` project tags; this config turns
// the tier into an enforced rule:
//
// - engine (the published release train) may depend on engine only.
// - agent may build on engine and agent, never on tooling.
// - tooling (the build system) may reach everything.
// - packages may never depend on apps.
//
// A dependency edge is allowed when any constraint whose `sourceTag` matches
// the importing project also lists a tag the imported project carries.
import nxPlugin from "@nx/eslint-plugin"

/**
 * Flat-config block enabling `@nx/enforce-module-boundaries` for package
 * sources. Appended after `jsdocConvention` in each package config.
 */
export const moduleBoundaries = {
  name: "flows/module-boundaries",
  files: ["src/**/*.ts"],
  plugins: { "@nx": nxPlugin },
  rules: {
    "@nx/enforce-module-boundaries": [
      "error",
      {
        // This workspace consumes workspace dependencies through source-first
        // exports, not built artifacts, so buildability is not a constraint.
        enforceBuildableLibDependency: false,
        // Circular imports are gated per package by the madge-based `circular`
        // script over `src`. The graph-level cycles here are intentional
        // dev-time edges through `BUILD.ts` files: the rule catalog
        // (@smthrs/targets) imports the packages it scaffolds targets for, and
        // package BUILD.ts files import the catalog back. Ignoring edges
        // to and from the catalog excludes exactly those dev-time cycles;
        // a source-level cycle that does not involve the catalog still fails.
        // The kernel / platform-browser pair is a pre-existing runtime cycle
        // on main (each lists the other in `dependencies`); it is allowlisted
        // here so the gate catches new cycles instead of re-reporting it.
        ignoredCircularDependencies: [
          ["*", "@smthrs/targets"],
          ["@smthrs/targets", "*"],
          ["@smthrs/kernel", "@smthrs/platform-browser"],
          ["@smthrs/platform-browser", "@smthrs/kernel"]
        ],
        allow: [],
        depConstraints: [
          {
            sourceTag: "group:engine",
            onlyDependOnLibsWithTags: ["group:engine"]
          },
          {
            sourceTag: "group:agent",
            onlyDependOnLibsWithTags: ["group:engine", "group:agent"]
          },
          {
            sourceTag: "group:tooling",
            onlyDependOnLibsWithTags: ["group:engine", "group:agent", "group:tooling"]
          },
          {
            sourceTag: "type:package",
            onlyDependOnLibsWithTags: ["type:package"]
          }
        ]
      }
    ]
  }
}
