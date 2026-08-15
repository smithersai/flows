# Install

`tsflows` expresses dependency installation as one flow with two rounds and
three actions: measure, fetch, and link. Only pnpm performs work today; npm,
Bun, and Yarn are explicit typed refusals.

The CLI runs the supported composition:

```sh
tsflows install --workspace /absolute/or/relative/workspace
```

The library layer requires an absolute project root and explicit platform:

```ts
PackageManager.layerPnpm({
  projectRoot: "/workspace",
  platform: { os: "linux", arch: "x64", libc: "glibc" }
})
```

The complete embedding also supplies `Install.layer` from
`@smthrs/tsflows-next`, an interpreter
registration for `Install.Install`, a flow runtime, and Node filesystem,
process, and crypto services. The CLI composition in
`packages/tsflows-cli/src/engine.ts` is the reference.

## Two rounds

The flow payload is `{ environment?: Environment }` and starts empty.

```text
round 1:
  Measure.call({})
    -> Install.to({ environment: measured })

round 2:
  Fetch[environment.manager].call({ environment })
    -> Link.call({ environment, store })
```

`maxRounds` is two, and round two never hands off again.

The package-manager implementation is a runtime layer, so a pure first-round
body cannot branch on it. `to` carries the measured value into the next round
as ordinary payload. That body can select one manager-specific fetch action
with one exact lockfile declaration rather than putting every supported
lockfile into one boundary.

## Measure

`Measure` runs `<manager> --version`, digests the manager lockfile, and digests
the project `.npmrc` when present.

```ts
Environment = {
  manager: "npm" | "pnpm" | "bun" | "yarn"
  managerVersion: string
  platform: { os, arch, libc } | null
  lockfile: { path, digest }
  npmrc: { path, digest } | null
}
```

The action uses an `expected` boundary and is never answered from the cross-run
engine cache. The manager binary on `PATH` is not a declared file input, so
reusing another host's measurement would put a version into downstream keys
that this host never ran.

Version output is limited to 64 KiB and one control-free line. `.npmrc` is
limited to 256 KiB, `package.json` to 4 MiB, and lockfiles to 64 MiB. Reads use
stable regular-file descriptors, exact UTF-8, and canonical-path checks inside
the project root.

## Fetch identity

The second-round payload includes:

1. the lockfile path and SHA-256 digest;
2. the project `.npmrc` digest or `null`;
3. manager name and exact measured version;
4. `{os, arch, libc}` for a platform-sensitive manager.

The scheduler also folds declaration identity, layers, capabilities, effects,
and settled dependencies into its step key. The absolute project root and
store path are host placement, not content identity.

Before fetch starts, the implementation re-runs the manager version probe and
re-digests the lockfile and `.npmrc`. Any disagreement with round one fails
with `environment_mismatch`.

Fetch returns a `StoreManifest`:

```ts
{
  manager, managerVersion, platform, digest
}
```

Its digest is SHA-256 over a versioned canonical tuple of the measured
environment. It describes what populated the store; it is not the store bytes.

## Why fetch is not cache-admissible

Fetch declares `.flows/store/<manager>` as a `TreeArtifact`, but its boundary
mode is `expected`, not `hard`. The current manager process runs against an
absolute workspace root and opens the lockfile and `.npmrc` itself. The parent
can compare those files before and after execution but cannot freeze their
paths across the child's opens. The unsandboxed observer also cannot attest
that no undeclared path was read or written.

Consequently no fetch result or store tree is replayed from a cross-run engine
cache today. A sandbox lane that supplies hermetic-read and whole-tree evidence
is required before changing this policy.

## Link

Link verifies the measured environment and `StoreManifest`, digests the root
`package.json`, runs the manager's link operation, digests the manager's own
tree evidence, and returns:

```ts
LinkManifest = { store: Digest, manifest: Digest, linked: true }
```

Link always reconciles `node_modules`. A hidden lockfile or modules manifest
describes the graph a manager intended to create, but cannot prove that every
package file is still present and unmodified. There is no
`node_modules/.flows-link.json` freshness shortcut.

The action uses an `expected` boundary and declares no materialized output.
`node_modules` is a host-local graph of links into the store and is never
restored from another machine.

## Manager support

| Manager | Status      | Behavior                                                                             |
| ------- | ----------- | ------------------------------------------------------------------------------------ |
| pnpm    | Implemented | Frozen fetch into `.flows/store/pnpm`, then frozen offline link with scripts ignored |
| npm     | Unsupported | No verified fetch-only verb satisfying the declared lockfile boundary                |
| Bun     | Unsupported | No documented fetch-only and offline-link pair satisfying the contract               |
| Yarn    | Unsupported | Named for future compatibility; no implementation is wired                           |

The pnpm commands are:

```text
pnpm fetch --frozen-lockfile --ignore-scripts --reporter=append-only \
  --store-dir <projectRoot>/.flows/store/pnpm

pnpm install --offline --frozen-lockfile --ignore-scripts \
  --reporter=append-only --store-dir <projectRoot>/.flows/store/pnpm
```

`layerNpm`, `layerBun`, and `layerNoop("yarn", options)` still provide the
service shape. Version, fetch, link, and manifest operations fail with
`PackageManagerError { code: "unsupported" }`, making unsupported selection
deterministic rather than a missing-layer defect.

## Environment and credentials

Package-manager children use `extendEnv: false`. They receive deterministic
locale/color settings, selected bootstrap and network variables, and variables
explicitly referenced as `${NAME}` in the project `.npmrc`.

Literal auth tokens, passwords, key files, and certificate fields in `.npmrc`
are refused. Placeholders that reference process-control names such as
`NODE_*`, `NPM_CONFIG_*`, `PNPM_*`, `BUN_*`, loader variables, or shell startup
variables are also refused. User and global npm configuration paths are forced
to the null device.

Remote-cache endpoint and token variables are removed before the install layer
receives its environment snapshot.

## Store placement

Manager stores are fixed below `.flows/store/<manager>`. Discovery and glob
expansion always exclude that tree.

Because the install action declaration contains that fixed path, the direct
`install` command rejects a custom `cacheDirectory`. Other target verbs may use
one. Making install placement configurable requires changing the declared
boundary and host-state substitution together; silently writing one path while
declaring another is not allowed.

## Lifecycle scripts

Every supported command passes `--ignore-scripts`. Arbitrary package lifecycle
code needs a separate non-sealed execution model and is not part of this flow.

## Next

- [Actions and boundaries](actions-and-boundaries.md)
- [PnpmWorkspace](../reference/rules/pnpm-workspace.md)
- [Remote caching](../workspace/remote-caching.md)
