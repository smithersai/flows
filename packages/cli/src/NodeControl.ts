/**
 * Node transport composition for the Control service.
 *
 * @since 0.1.0
 */
import { NodeCrypto, NodeHttpClient, NodeHttpServer, NodeServices, NodeSocket } from "@effect/platform-node"
import {
  ControlExecutor,
  ControlRpcs,
  ControlRuntime,
  ControlServer,
  SqlControlRuntime,
  SystemFlows
} from "@smthrs/control"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as FlowEngineLike from "@smthrs/engine-harness/FlowEngineLike"
import * as HarnessExecutor from "@smthrs/engine-harness/HarnessExecutor"
import * as StandardFlows from "@smthrs/engine-harness/StandardFlows"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import * as NodeFlowsRuntime from "@smthrs/flows/NodeRuntime"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import { Migrations, SqlJournal } from "@smthrs/journal"
import type * as Journal from "@smthrs/journal/Journal"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import type * as ModelError from "@smthrs/model/ModelError"
import * as OpenAICompatible from "@smthrs/model/OpenAICompatible"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import type { NotificationQueue } from "@smthrs/notifications"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { Migrations as RunStoreMigrations, RunStore } from "@smthrs/run-store"
import type { FileSystem, Path, Result } from "effect"
import { Effect, Layer, Redacted } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
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
  /** Explicit opt-in corresponding to the host CLI's `--listen` flag. */
  readonly listen?: boolean | undefined
}

const valueFromArguments = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === `--${flag}`) return args[index + 1]
    if (argument?.startsWith(`--${flag}=`)) return argument.slice(flag.length + 3)
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
  remote: valueFromArguments(args, "remote") ?? environment.FLOWS_REMOTE,
  credential: valueFromArguments(args, "credential")
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

const websocketLayer = (remote: string, credential: string | undefined) => {
  const url = websocketUrl(remote)
  if (credential === undefined) return NodeSocket.layerWebSocket(url)
  return Socket.layerWebSocket(url).pipe(
    Layer.provide(
      Layer.succeed(
        Socket.WebSocketConstructor,
        (address, protocols) =>
          new NodeSocket.NodeWS.WebSocket(address, protocols, {
            headers: { authorization: `Bearer ${credential}` }
          }) as unknown as globalThis.WebSocket
      )
    )
  )
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
  // `NodeServices` alone is not enough: the kernel's guarded `FileSystem`
  // refuses every operation unless the host provides descriptor-relative,
  // no-follow access, which is what `AtomicFileSystem` adds on Node.
  const platform = Layer.orDie(KernelFileSystem.layer).pipe(
    Layer.provide([Workspace.layer(root), GrantStore.layerNoop]),
    Layer.provideMerge(Layer.provideMerge(AtomicFileSystem.layer, NodeServices.layer))
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
 * Where the durable flow engine keeps executions, attempts, cache entries,
 * and wake state. The control plane has a separate connection and schema in
 * {@link databasePath}; keeping the files separate makes each composition's
 * migration ownership explicit.
 *
 * @category constructors
 * @since 0.1.0
 */
export const executionDatabasePath = (root: string): string => join(root, ".flows", "engine.db")

/**
 * `Application.Engine` plus the shared database seam the Node composition
 * hangs additional stores off — the memory store reuses the same connection
 * the runtime and journal commit against.
 *
 * @category models
 * @since 0.1.0
 */
export interface EngineDurable extends Application.Engine {
  readonly stores: Layer.Layer<DurableWriter.DurableWriter | SqlClient>
}

/** The reserved system catalog in the durable runtime's flow shape. */
const systemFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = SystemFlows.catalog.map((entry) => ({
  flowId: entry.flowId,
  description: `Reserved ${entry.verb} system flow`,
  deployClass: entry.deployClass,
  envelope: { capabilities: [], flows: [], budget: {} }
}))

/** Projects one discovered flow into the durable runtime's flow shape. */
const durableFlow = (descriptor: Descriptor.FlowDescriptor): ControlRuntime.MemoryFlow => ({
  flowId: descriptor.name,
  description: descriptor.description,
  deployClass: false,
  envelope: {
    capabilities: descriptor.capabilities,
    flows: descriptor.flows,
    budget: {}
  }
})

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
 * With a `registry`, the runtime knows every discovered flow as well as the
 * reserved system catalog, so `flows plan <flow>` plans a project flow
 * instead of failing `FlowNotFound`.
 *
 * @category layers
 * @since 0.1.0
 */
export const engineDurable = (
  root: string = process.cwd(),
  registry?: Layer.Layer<Registry.Registry> | undefined
): EngineDurable => {
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
  const runtime = registry === undefined
    ? SqlControlRuntime.layer().pipe(Layer.provide([stores, NodeCrypto.layer]), Layer.orDie)
    : Layer.effect(ControlRuntime.ControlRuntime)(
      Effect.gen(function*() {
        const registryService = yield* Registry.Registry
        const discovered = yield* registryService.list()
        return yield* SqlControlRuntime.make({ flows: [...systemFlows, ...discovered.map(durableFlow)] })
      })
    ).pipe(Layer.provide([stores, NodeCrypto.layer, registry]), Layer.orDie)
  return {
    runtime,
    journal: stores,
    stores
  }
}

const apiKeyVariable: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY"
}

/**
 * Resolves a `provider:modelId` seat into a live model route, with the API
 * key read from the given environment — usually `process.env`, passed in as a
 * value so nothing below this composition touches the process directly.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolveSeat = (
  environment: Readonly<Record<string, string | undefined>>,
  executor: RequestExecutor.RequestExecutor
): HarnessExecutor.Options["resolveSeat"] =>
(seat) =>
  Effect.gen(function*() {
    const separator = seat.indexOf(":")
    const provider = separator < 0 ? "anthropic" : seat.slice(0, separator)
    const modelId = separator < 0 ? seat : seat.slice(separator + 1)
    const variable = apiKeyVariable[provider]
    if (variable === undefined) {
      return yield* new HarnessExecutor.SeatUnresolved({
        seat,
        message: `No route is configured for the ${provider} provider`
      })
    }
    const key = environment[variable]
    if (key === undefined || key.length === 0) {
      return yield* new HarnessExecutor.SeatUnresolved({
        seat,
        message: `Set ${variable} to run the ${seat} seat`
      })
    }
    // The provider routes have distinct body types, so each branch is erased
    // into the seat shape on its own rather than through a union. OpenRouter
    // is the OpenAI Responses surface at a different origin, so its seats
    // spell the model as `openrouter:vendor/model` and route through the
    // compatible constructor.
    return yield* provider === "anthropic"
      ? seatOf(Route.anthropic({ apiKey: Redacted.make(key) }), executor, seat, modelId)
      : provider === "openrouter"
      ? seatOf(
        OpenAICompatible.make({ id: "openrouter", baseUrl: "https://openrouter.ai/api", apiKey: Redacted.make(key) }),
        executor,
        seat,
        modelId
      )
      : seatOf(Route.openai({ apiKey: Redacted.make(key) }), executor, seat, modelId)
  })

const seatOf = <Body, Frame, Event, State>(
  configured: Result.Result<Route.Route<Body, Frame, Event, State>, ModelError.ModelError>,
  executor: RequestExecutor.RequestExecutor,
  seat: string,
  modelId: string
): Effect.Effect<HarnessExecutor.Seat, HarnessExecutor.SeatUnresolved> =>
  Effect.gen(function*() {
    const routeConfig = yield* Effect.fromResult(configured).pipe(
      Effect.mapError((error) => new HarnessExecutor.SeatUnresolved({ seat, message: error.message }))
    )
    const model = yield* Route.toModel(routeConfig).pipe(
      Effect.provideService(RequestExecutor.RequestExecutor, executor)
    )
    return {
      model,
      route: FlowEngineLike.routeResolver(routeConfig),
      contextWindowTokens: HarnessExecutor.contextWindowTokensFor(modelId)
    }
  })

/**
 * The explicit sandbox budget every locally executed cell runs under. Never
 * unlimited: an unbounded QuickJS cell can hang the frame.
 */
const cellLimits: Sandbox.Limits = {
  memoryBytes: 256 * 1024 * 1024,
  steps: 50_000_000
}

/**
 * Provides the production run executor: the engine-harness composition root
 * over the durable control stores, the local flow registry, and the standard
 * host capabilities — filesystem and shell through the kernel's guarded
 * layers, durable memory over the control database, approval and steering
 * wired back into the control plane by the executor itself.
 *
 * The durable engine is built through `@smthrs/flows/NodeRuntime`, whose
 * final registration phase constructs `HarnessExecutor`. This is deliberate:
 * the executor cannot accept a launch until the engine database is migrated,
 * its stores and sweepers are live, and the agent flow body has been
 * registered. The resulting engine state is durable, and no launch can race
 * ahead of that durability-sensitive startup order.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerExecutor = (
  registry: Layer.Layer<Registry.Registry>,
  engine: EngineDurable,
  root: string = process.cwd(),
  environment: Readonly<Record<string, string | undefined>> = process.env
): Layer.Layer<
  ControlExecutor.ControlExecutor,
  never,
  ControlRuntime.ControlRuntime | Journal.Journal | NotificationQueue.NotificationQueue | Registry.Registry
> => {
  const grants = GrantStore.layerNoop
  // The same guarded platform the registry discovers under: kernel FileSystem
  // over descriptor-relative atomic access, with the Node service bundle
  // (Path, raw spawner, crypto) merged through.
  const host = Layer.provideMerge(AtomicFileSystem.layer, NodeServices.layer)
  const platform = Layer.orDie(KernelFileSystem.layer).pipe(
    Layer.provide([Workspace.layer(root), grants]),
    Layer.provideMerge(host)
  )
  const guarded = KernelChildProcessSpawner.layer.pipe(
    Layer.provide(grants),
    Layer.provideMerge(platform)
  )
  const memory = MemoryStore.layer.pipe(Layer.provide(engine.stores), Layer.orDie)
  const registration = Layer.effect(ControlExecutor.ControlExecutor)(
    Effect.gen(function*() {
      const modelExecutor = yield* RequestExecutor.RequestExecutor
      const filesystemServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      const shellServices = yield* Effect.context<
        KernelChildProcessSpawner.ChildProcessSpawner | Path.Path
      >()
      const memoryServices = yield* Effect.context<MemoryStore.MemoryStore | Recall.Recall>()
      return yield* HarnessExecutor.make({
        resolveSeat: resolveSeat(environment, modelExecutor),
        flows: [
          StandardFlows.filesystem(filesystemServices),
          StandardFlows.shell(shellServices),
          StandardFlows.memory(memoryServices)
        ],
        limits: cellLimits
      })
    })
  ).pipe(
    Layer.provide([
      guarded,
      memory,
      Recall.layerNoop,
      // The dispatcher must live as long as the executor. A model captures
      // this service and uses it after seat resolution has returned.
      RequestExecutor.layer.pipe(Layer.provide(NodeHttpClient.layerUndici))
    ])
  )
  return NodeFlowsRuntime.layer(
    {
      filename: executionDatabasePath(root),
      owner: { hostId: "flows-cli" },
      // The local CLI has one engine process at a time. A later supervised or
      // multi-process host must replace this with a real liveness answer.
      isAlive: () => Effect.succeed(false)
    },
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    registration
  ).pipe(
    Layer.provide([platform, NodeCrypto.layer, NodeJj.layer]),
    // Failure to open or migrate the local execution engine is a startup
    // defect, just like the control database above: no command can execute
    // honestly without this composition.
    Layer.orDie
  )
}

/**
 * Provides the application-selected Control implementation with Node HTTP and
 * WebSocket client transports. Local compositions get the production run
 * executor; remote ones talk to a server that owns its own.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerControl = (applicationConfig: Application.Config) => {
  const remote = applicationConfig.remote ?? "http://127.0.0.1"
  const registry = layerRegistry()
  const engine = engineDurable(process.cwd(), registry)
  const executor = applicationConfig.remote === undefined ? layerExecutor(registry, engine) : undefined
  return Application.layer(applicationConfig, registry, engine, executor).pipe(
    Layer.provide([
      NodeHttpClient.layerUndici,
      websocketLayer(remote, applicationConfig.credential),
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

const defaultServerOptions: ServerOptions = { host: "127.0.0.1", port: 3000 }

const isLoopbackHost = (host: string): boolean => host === "127.0.0.1" || host === "::1"

const listenOptions = (options: ServerOptions): ListenOptions => {
  const { listen, ...nodeOptions } = options
  const host = nodeOptions.host ?? "127.0.0.1"
  if (!isLoopbackHost(host) && listen !== true) {
    throw new Error(`Refusing non-loopback control bind ${host} without an explicit --listen opt-in`)
  }
  return { ...nodeOptions, host }
}

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
  options: ServerOptions = defaultServerOptions
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
    Layer.provideMerge(NodeHttpServer.layer(createServer, listenOptions(options)))
  )

/**
 * Hosts Control using the alpha's single shared bearer token.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerServerBearerAuth = (
  auth: ControlRpcs.BearerAuthOptions,
  options: ServerOptions = defaultServerOptions
) => layerServer(ControlRpcs.layerBearerAuth(auth), options)

/**
 * Hosts Control with permissive authentication for trusted local and test use.
 * Production hosts must call `layerServer` with an explicit authentication
 * layer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerServerNoopAuth = (options: ServerOptions = defaultServerOptions) => {
  const host = options.host ?? "127.0.0.1"
  if (!isLoopbackHost(host)) {
    throw new Error(`Refusing non-loopback control bind ${host} with permissive authentication`)
  }
  return layerServer(ControlRpcs.layerNoopAuth(), { ...options, listen: false })
}
