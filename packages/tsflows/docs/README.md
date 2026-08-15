# tsflows documentation

tsflows is a Bazel-style build orchestrator for TypeScript workspaces. `BUILD.ts`
files are plain TypeScript modules whose named exports are targets. Rule calls
return flows with planner metadata. Direct imports between `BUILD.ts` files form
dependency edges.

These pages describe what the code does today. Behavior that is declared but not
wired is marked as such on the page that covers it.

## About

| Page                                        | Description                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| [What is tsflows](about/what-is-tsflows.md) | The everything-is-a-flow model, and how tsflows compares to Bazel, Turborepo, and nx. |
| [FAQ](about/faq.md)                         | Short answers to the questions the design raises.                                     |

## Getting started

| Page                                          | Description                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| [Install](getting-started/install.md)         | Wire `tsflows-rules` and the CLI into an existing pnpm workspace.        |
| [First build](getting-started/first-build.md) | Write a root `BUILD.ts` and one package `BUILD.ts`, then run every verb. |

## Workspace

| Page                                                    | Description                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [Structure](workspace/structure.md)                     | Discovery, `BUILD.ts` placement, package boundaries, default-rule synthesis.                                        |
| [Writing BUILD files](workspace/writing-build-files.md) | Targets as named exports, rule calls, import edges, macros.                                                         |
| [Configuration](workspace/configuration.md)             | The `Workspace` declaration, `cacheDirectory`, `gitignored`, `--cache-dir`.                                         |
| [Running targets](workspace/running-targets.md)         | `install`, `build`, `test`, `lint`, `ci`, and what actually executes.                                               |
| [Querying](workspace/querying.md)                       | `query`, `deps()`, and `graph`.                                                                                     |
| [Caching](workspace/caching.md)                         | Content keys, the result cache, and what re-keys a target.                                                          |
| [Remote caching](workspace/remote-caching.md)           | The HTTP read-through cache, the hosted and self-hosted `/ac` and `/cas` services, and the current engine boundary. |

## Concepts

| Page                                                         | Description                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [Labels](concepts/labels.md)                                 | The `//pkg:target` grammar, package defaults, and `//...` patterns.                |
| [Targets and rules](concepts/targets-and-rules.md)           | A target is a flow with planner metadata.                                          |
| [Inputs](concepts/inputs.md)                                 | `file()`, `glob()`, `gitDiff()`, and when they are digested.                       |
| [Dependencies](concepts/dependencies.md)                     | Import edges, `deps` attributes, and transitive planning.                          |
| [Actions and boundaries](concepts/actions-and-boundaries.md) | Sealed actions, `TreeArtifact` writes, host state, and hermeticity.                |
| [Install](concepts/install.md)                               | The measure round, fetch key material, the fetch/link split, and manager-as-layer. |

## Extending

| Page                                          | Description                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| [Writing rules](extending/writing-rules.md)   | `Rule.make`: the attrs schema, the plan-time implementation, and typed failures. |
| [Writing macros](extending/writing-macros.md) | `StandardPackage` as the worked example.                                         |
| [Default rules](extending/default-rules.md)   | `DefaultRule`, `directories`, `marker`, `unless`, and `macro`.                   |

## Reference

| Page                                      | Description                                                    |
| ----------------------------------------- | -------------------------------------------------------------- |
| [CLI](reference/cli.md)                   | Every verb, flag, output shape, and exit code.                 |
| [Workspace](reference/config.md)          | The `Workspace` declaration and its exact validation rules.    |
| [Rule catalog](reference/rules/README.md) | One page per rule, with attribute tables and execution status. |
