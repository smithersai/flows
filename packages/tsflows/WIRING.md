# Wiring

`@smthrs/tsflows-next` is a pnpm workspace package of the flows repository at
`packages/tsflows`, alongside the private `tsflows-rules` and `tsflows-cli`
packages. The workspace install links everything; there is no separate
install step.

## Compile-time dependencies

| Dependency            | Version        | Use                                            |
| --------------------- | -------------- | ---------------------------------------------- |
| `effect`              | `4.0.0-rc.108` | Effects, schemas, layers, files, and processes |
| `@smthrs/flow-next`   | `0.1.0`        | Actions, flows, annotations, and file inputs   |
| `@smthrs/plan-next`   | `0.1.0`        | Planned nodes                                  |
| `@smthrs/crypto-next` | `0.1.0`        | SHA-256 digests                                |

The imports use published package paths. They are
`@smthrs/flow-next`, `@smthrs/flow-next/FileInput`,
`@smthrs/plan-next/Node`, `@smthrs/crypto-next`, `effect/FileSystem`, and the
two `effect/unstable/process` modules.

## Workspace membership

The flows checkout uses pnpm. Its `pnpm-workspace.yaml` includes
`packages/*` and `packages/tsflows/infra`.

1. The three packages live at `packages/tsflows`, `packages/tsflows-rules`,
   and `packages/tsflows-cli`.
2. Cross-package dependencies use the exact `0.1.0` workspace versions.
   `linkWorkspacePackages` resolves them to the local packages; no `file:` or
   `link:` specifiers remain.
3. The root `pnpm install` creates the package links and owns the single
   `pnpm-lock.yaml`. The old per-package npm lockfiles are deleted.
4. `pnpm --filter @smthrs/tsflows-next check` typechecks the library. The
   root `pnpm check` recurses into every package, including `rules`, `cli`,
   and `infra`.

No TypeScript path mapping is required. `tsconfig.json`, the build scripts,
the dual ESM/CJS export map, and the pinned tooling dependencies copy the
current `@smthrs/flow-next` package shape.

## BUILD.ts imports

The flows workspace root declares `"tsflows-rules": "0.1.0"` as a
devDependency, resolved to the workspace package. `BUILD.ts` files import the
rule catalog by bare specifier: `import { ... } from "tsflows-rules"`.

## Runtime layers

Running the flow also requires these layers:

- A `FlowRuntime` from the durable engine or the memory test runtime.
- Node implementations of `FileSystem`, `ChildProcessSpawner`, and `Crypto`.
- One `PackageManager` layer. The npm, pnpm, and Bun layers are implemented.

Run the engine from the project root so the declared relative paths and
manager command paths match. The flow payload is empty on its first round:

```ts
Install.Install.execute({}).pipe(
  Effect.provide(Install.layer),
  Effect.provide(PackageManager.layerNpm({
    platform: { os: "linux", arch: "x64", libc: "glibc" }
  })),
  Effect.provide(flowRuntimeLayer),
  Effect.provide(nodeHostLayer)
)
```

For remote caching, compose `RemoteCacheStore` with the local step cache and
compose `RemoteArtifacts` with the local artifact store. Pass the Terraform
endpoint and authorization header as layer construction options. They do not
enter a step key.

## Cache directory

The CLI resolves one workspace-relative cache directory per run: the
`--cache-dir` flag, then the `Workspace` declaration exported from the root
`BUILD.ts` file, then `.flows`. The CLI result cache lives at
`<cacheDirectory>/cache` and `DepsLint` writes its generated knip
configuration under the same directory. `Workspace` passes the value directly
to glob expansion, while `ExecLive` receives it as host state and replaces the
constant token used by `DepsLint` immediately before spawning the tool. The
real directory string therefore never enters a step payload or key, and
concurrent workspace instances do not share mutable configuration.

Manager stores are not part of that seam. They stay at
`.flows/store/<manager>` because a fetch declares them as a `TreeArtifact`
boundary, which is key material. Discovery always excludes this fixed store,
including when the configured cache lives elsewhere. Configurable store
placement is future work.

## Current engine boundary

Each fetch action declares `.flows/store/<manager>` as a `TreeArtifact`. The
filesystem boundary can capture and replay that tree locally. It cannot attest
writes outside the declaration, so its evidence stays run-local. Wire
`WorkspaceSandbox` for remote publication. This is an engine wiring
limitation, not a second cache protocol.
