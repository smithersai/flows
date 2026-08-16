# @smthrs/cli

Node command-line projection of the flows control plane. It turns `@smthrs/control` operations into the `flows` executable and supplies the Node HTTP, WebSocket, and output layers used by the CLI host.

```sh
npm install @smthrs/cli
```

## Public API

The root entry point exports the following namespaces; each is also available from `@smthrs/cli/<Module>`.

| Module          | Public exports                                                                                                                                                | Description                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Application`   | `Config`, `layer`                                                                                                                                             | Selects the local or authenticated RPC-backed Control layer from transport-neutral configuration. |
| `CliError`      | `UsageError`, `UnsupportedError`, `CliError`, `exitCode`                                                                                                      | Defines typed CLI failures and their stable process exit codes.                                   |
| `Command`       | `cli`                                                                                                                                                         | Exposes the Effect CLI command tree.                                                              |
| `NodeControl`   | `Environment`, `ServerOptions`, `makeConfig`, `config`, `layerControl`, `layerOutput`, `layer`, `layerServer`, `layerServerBearerAuth`, `layerServerNoopAuth` | Assembles Node configuration, Control, output, and loopback-default RPC server layers.            |
| `Output`        | `Format`, `Rendered`, `Service`, `Output`, `make`, `layer`, `exitCode`                                                                                        | Renders deterministic human or JSON output through an injectable service.                         |
| `Verb`          | `Verb`, `verbs`, `find`                                                                                                                                       | Provides reserved system-flow verb metadata and lookup.                                           |
| `bin` / `flows` | side-effect entry point                                                                                                                                       | Runs `Command.cli`; the package also installs it as the `flows` executable.                       |

```ts
import { Command, NodeControl } from "@smthrs/cli"
import { Effect } from "effect"
import { Command as Cli } from "effect/unstable/cli"

const config = NodeControl.makeConfig([
  "--remote",
  "http://127.0.0.1:3000",
  "--credential",
  "alpha-secret"
])

const main = Cli.run(Command.cli, { version: "0.0.0" }).pipe(
  Effect.provide(NodeControl.layer(config))
)
```

`@smthrs/cli/package.json` is exported for package metadata. `internal/*` and nested `*/index` subpaths are not public.

Control servers bind `127.0.0.1` by default. See the [control-plane trust posture](../../docs/guides/control-plane-trust.md) before opting into a non-loopback bind.
