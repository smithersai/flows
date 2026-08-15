/**
 * Node transport composition for the Control service.
 *
 * @since 0.1.0
 */
import { NodeCrypto, NodeHttpClient, NodeHttpServer, NodeServices, NodeSocket } from "@effect/platform-node"
import { ControlRpcs, ControlServer, SqlControlRuntime } from "@smthrs/control"
import * as DurableWriter from "@smthrs/database-next/DurableWriter"
import * as NodeDatabase from "@smthrs/database-next/node/NodeDatabase"
import { Migrations, SqlJournal } from "@smthrs/journal-next"
import * as KernelFileSystem from "@smthrs/kernel-next/FileSystem"
import * as GrantStore from "@smthrs/kernel-next/GrantStore"
import * as Workspace from "@smthrs/kernel-next/Workspace"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { Migrations as RunStoreMigrations, RunStore } from "@smthrs/run-store-next"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { mkdirSync } from "node:fs"
import { createServer } from "node:http"
import type { ListenOptions } from "node:net"
import { dirname, join } from "node:path"
import * as Application from "./Application.ts"
import * as Output from "./Output.ts"

/**
 * The environment subset consulted while resolving Node application
 * configuration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Environment {
  readonly FLOWS_REMOTE?: string | undefined
}

/**
 * Node HTTP listen options accepted by the control server.
 *
 * @category models
 * @since 0.1.0
 */
export type ServerOptions = ListenOptions & {
  readonly disablePreemptiveShutdown?: boolean | undefined
}

const remoteFromArguments = (args: ReadonlyArray<string>): string | undefined => {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "--remote") return args[index + 1]
    if (argument?.startsWith("--remote=")) return argument.slice("--remote=".length)
  }
  return undefined
}

/**
 * Resolves application configuration from command arguments with an
 * environment fallback.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeConfig = (
  args: ReadonlyArray<string>,
  environment: Environment = process.env
): Application.Config => ({
  remote: remoteFromArguments(args) ?? environment.FLOWS_REMOTE
})

/**
 * Resolves configuration for the current Node process.
 *
 * @category configuration
 * @since 0.1.0
 */
export const config: Effect.Effect<Application.Config> = Effect.sync(() => makeConfig(process.argv.slice(2)))

const websocketUrl = (remote: string): string => {
  const url = new URL(remote)
  const basePath = url.pathname.replace(/\/+$/, "").replace(/\/rpc$/, "")
  url.pathname = `${basePath}/rpc/ws`
  url.search = ""
  url.hash = ""
  return url.toString()
}

/**
 * The flow sources a local CLI discovers: the project `flows/` directory, whose
 * per-directory layout is the convention in
 * `docs/specs/Specs/Flow Directory.md`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const projectSources = (root: string): ReadonlyArray<Descriptor.Source> => [
  { source: "project", root: join(root, "flows"), naming: "path" }
]

/**
 * Provides the Node-backed flow registry the local CLI discovers flows with.
 *
 * `Registry.layerNoop()` was the previous local composition, so the CLI found
 * no flows at all. Discovery runs under an allow-all grant store because the
 * local CLI is the operator's own process; a hosted composition supplies a real
 * `GrantStore`. A source root that does not exist scans empty, so this is not a
 * startup failure — an unreadable one is, and dies rather than silently
 * discovering nothing.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerRegistry = (root: string = process.cwd()): Layer.Layer<Registry.Registry> => {
  const platform = Layer.orDie(KernelFileSystem.layer).pipe(
    Layer.provide([Workspace.layer(root), GrantStore.layerNoop]),
    Layer.provideMerge(NodeServices.layer)
  )
  const discovery = Discovery.layer.pipe(Layer.provide(platform))
  return Registry.layer({ sources: projectSources(root) }).pipe(
    Layer.provide([discovery, platform]),
    // A project with no `flows/` directory simply has no flows. Every other
    // discovery failure — an unreadable root, a malformed entry — is a startup
    // defect rather than a silent empty catalog.
    Layer.catch((error) =>
      error.code === "root_missing"
        ? Registry.layerFromDescriptors([]).pipe(Layer.provide(platform))
        : Layer.effect(Registry.Registry)(Effect.die(error))
    )
  )
}

/**
 * Where a local CLI keeps its control-plane database.
 *
 * @category constructors
 * @since 0.1.0
 */
export const databasePath = (root: string): string => join(root, ".flows", "control.db")

/**
 * Provides the durable local engine: `SqlControlRuntime` and the production
 * SQL journal, both over one SQLite file under the project root.
 *
 * The previous local composition was `ControlRuntime.layerMemory()` over
 * `TestJournal` — an in-memory database — so no plan, approval, run, or journal
 * entry survived the process. Sharing one connection between the runtime and
 * the journal is deliberate: the fenced run transitions and the events that
 * describe them then commit against the same database.
 *
 * @category layers
 * @since 0.1.0
 */
export const engineDurable = (root: string = process.cwd()): Application.Engine => {
  const file = databasePath(root)
  // Suspended so a `--remote` invocation, which never builds this layer, does
  // not leave an empty `.flows/` behind. SQLite opens a file but will not
  // create the directory holding it, and a missing one is the first-run case,
  // not an error.
  const database = Layer.provideMerge(
    Layer.merge(Migrations.layer, RunStoreMigrations.layer),
    Layer.provideMerge(
      DurableWriter.layer(),
      Layer.suspend(() => {
        mkdirSync(dirname(file), { recursive: true })
        return NodeDatabase.layer({ filename: file })
      })
    )
  ).pipe(Layer.orDie)
  // A control plane that cannot open its own database has nothing to serve, so
  // a failed open, migration, or journal start is a startup defect rather than
  // a typed control-plane error every command would have to carry.
  const stores = Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer).pipe(
    Layer.provideMerge(database),
    Layer.orDie
  )
  return {
    runtime: SqlControlRuntime.layer().pipe(Layer.provide([stores, NodeCrypto.layer]), Layer.orDie),
    journal: stores
  }
}

/**
 * Provides the application-selected Control implementation with Node HTTP and
 * WebSocket client transports.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerControl = (applicationConfig: Application.Config) => {
  const remote = applicationConfig.remote ?? "http://127.0.0.1"
  return Application.layer(applicationConfig, layerRegistry(), engineDurable()).pipe(
    Layer.provide([
      NodeHttpClient.layerUndici,
      NodeSocket.layerWebSocket(websocketUrl(remote)),
      RpcSerialization.layerNdjson
    ])
  )
}

const output = Output.make()

/**
 * Provides deterministic rendering and transfers rendered statuses to the
 * Node process exit code.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerOutput = Layer.succeed(
  Output.Output,
  Output.Output.of({
    render: Effect.fn("Output.render")((value, format) =>
      output.render(value, format).pipe(
        Effect.tap((rendered) =>
          Effect.sync(() => {
            process.exitCode = rendered.exitCode
          })
        )
      )
    )
  })
)

/**
 * Provides the complete Node command-handler environment.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (applicationConfig: Application.Config) =>
  Layer.mergeAll(layerControl(applicationConfig), layerOutput, NodeServices.layer)

/**
 * Hosts the abstract Control HTTP/WebSocket router on a scoped Node HTTP
 * server. The returned layer retains the concrete HttpServer service so
 * callers can inspect an ephemeral address.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerServer = (
  auth: Layer.Layer<ControlRpcs.ControlAuth>,
  options: ServerOptions = { port: 3000 }
) =>
  HttpRouter.serve(
    ControlServer.layerHttp.pipe(
      Layer.provide(auth),
      Layer.provide(RpcSerialization.layerNdjson)
    ),
    {
      disableListenLog: true,
      disableLogger: true
    }
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, options))
  )

/**
 * Hosts Control with permissive authentication for trusted local and test use.
 * Production hosts must call `layerServer` with an explicit authentication
 * layer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerServerNoopAuth = (options: ServerOptions = { port: 3000 }) =>
  layerServer(ControlRpcs.layerNoopAuth(), options)
