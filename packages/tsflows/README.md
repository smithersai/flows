# @smthrs/tsflows-next

## Documentation

The full documentation suite lives in [`docs/`](docs/README.md): the
`BUILD.ts` authoring surface, the CLI, the rule catalog, and the concepts
behind targets, inputs, caching, and install.

`@smthrs/tsflows-next` expresses dependency installation as a flows workflow.

- `fetch` populates `.flows/store/<manager>` from the lockfile. It is a
  sealed Action with a hard `TreeArtifact` boundary. The existing artifact CAS
  records the store files. Its result value is a store-manifest digest.
- `link` runs locally from that store. It materializes `node_modules`, returns
  a manifest digest, and never records or publishes the tree as an artifact.

The package includes npm, pnpm, and Bun layers. The fetch/link split does not
depend on the selected manager. Add `.flows/` to the target repository's
ignore file. It contains replayable cache data, not source.

## Cache directory

The CLI keeps its result cache and rule scratch files in a workspace-relative
cache directory. It defaults to `.flows`. The root `BUILD.ts` file configures
it by exporting one `Workspace` declaration:

```ts
import { Workspace } from "tsflows-rules"

export const config = Workspace({ cacheDirectory: ".flows", gitignored: true })
```

`cacheDirectory` names a single workspace-relative directory. An empty value,
an absolute path, and any `..` segment are refused. `gitignored` defaults to
false; when it is true every command first ensures the root `.gitignore`
carries an entry for the directory, creating the file when it is absent. The
`--cache-dir` flag overrides the declaration on every command, and the
declaration overrides `.flows`.

The directory is host state. Discovery never lists a path inside it, declared
globs never expand into it, and its name never reaches a cache key or a content
digest.

Manager stores stay at `.flows/store/<manager>` and are not controlled by
`cacheDirectory`; discovery and globs always exclude that fixed store as host
state too. Those paths are declared `TreeArtifact` boundaries and therefore
key material, so configurable store placement is future work.

## Relation to rules_js

rules_js translates a lockfile into integrity-keyed package fetches, then
builds a pnpm-layout symlink forest for each Bazel sandbox. `tsflows` uses the
same fetch/link boundary. Its first version keys fetch on the complete
lockfile, and it lets the selected package manager build the linked tree.
Per-package fetch actions and lifecycle-script actions remain future work.

## Install flow

Run the engine from the project root. The Flow payload starts empty because
filesystem paths must not enter a shareable fetch key.

```ts
import { Install, PackageManager } from "@smthrs/tsflows-next"
import { Effect } from "effect"

const program = Install.Install.execute({}).pipe(
  Effect.provide(Install.layer),
  Effect.provide(PackageManager.layerNpm({
    platform: { os: "linux", arch: "x64", libc: "glibc" }
  })),
  Effect.provide(flowRuntimeLayer),
  Effect.provide(nodeHostLayer)
)
```

Round one measures the manager version, lockfile, `.npmrc`, and platform. It
hands that value to round two with `Flow.to`. Round two fetches, then links.
This handoff lets a pure plan select one manager-specific Action and one exact
lockfile boundary. Planning never reads the filesystem.

The requested dogfood checkout at `/Users/williamcory/flows/flows` currently
contains `pnpm-lock.yaml` and declares `pnpm@11.21.0`. It has no
`package-lock.json`. The task forbids running pnpm against that checkout, so
this scaffold does not execute install there. Planning is safe:

```ts
import { Graph } from "@smthrs/flow-next"
import { Install } from "@smthrs/tsflows-next"

const firstRound = Graph.build(Install.Install, {})
```

Use the npm layer against an npm workspace with `package-lock.json`. Use the
pnpm layer only where pnpm execution is permitted. `WIRING.md` lists the host
and runtime layers required for execution.

## Remote cache

Declare the shared HTTP cache in the root `BUILD.ts` file. The declaration is
inert and contains only the endpoint and an environment-variable name:

```ts
import { RemoteCache } from "tsflows-rules"

export const remoteCache = RemoteCache.make({
  endpoint: "https://tsflows.smithers.sh"
})
```

`endpoint` must use HTTPS. `tokenEnv` defaults to
`TSFLOWS_CACHE_TOKEN`; it can name a different environment variable, but the
bearer token itself must only be supplied through that environment variable.
Never put a token in `BUILD.ts`.

```sh
export TSFLOWS_CACHE_TOKEN='<token>'
tsflows ci //...
```

`TSFLOWS_CACHE_URL` overrides the declared endpoint for the process. A local
hit avoids HTTP, a remote hit hydrates the local cache, and puts write both.
Any remote failure warns once and degrades to local-only. A `409` publication
conflict warns without failing the run.

For a self-hosted cache, use [`terraform/`](terraform/) and put TLS in front of
its loopback HTTP service before declaring the resulting HTTPS endpoint.

The service protocol is:

- `/ac/{stepKeyDigest}` for cache entries.
- `/cas/{contentDigest}` for artifacts used by flows engine cache layers.
- `/cas/findMissing` for batched artifact probes.

The hosted service is deployed from [`infra/`](infra/). The self-hosted stack
starts Postgres and the HTTP service with:

```sh
cd terraform/examples/docker
terraform init
terraform apply \
  -var 'postgres_password=<password>' \
  -var 'auth_token=<token>'
```

Run `terraform destroy` to remove the containers and named cache volume.
