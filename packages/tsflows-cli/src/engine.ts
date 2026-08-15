/**
 * Runtime adapter between the CLI and the install package.
 *
 * Every assumption about the install package's exports stays in this file, so
 * a surface change there reconciles in one place. The executor composes the
 * layers exported here beside each target's own interpreter registration.
 *
 * @since 0.1.0
 */
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine-next"
import { Action, Graph, Interpreter } from "@smthrs/flow-next"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Install, PackageManager } from "@smthrs/tsflows-next"

/**
 * Structured result returned by the install command.
 *
 * @category models
 * @since 0.1.0
 */
export interface InstallResult {
  readonly workspace: string
  readonly manager: "pnpm"
  readonly plan: ReadonlyArray<{
    readonly id: string
    readonly kind: string
    readonly dependencies: ReadonlyArray<string>
  }>
  readonly result: Install.LinkManifest
}

/**
 * The pnpm package-manager layer for this host.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerPackageManager = (projectRoot: string) =>
  PackageManager.layerPnpm({
    projectRoot,
    environment: process.env,
    platform: {
      os: process.platform,
      arch: process.arch,
      libc: null
    }
  })

/**
 * The install action implementations plus the registered install flow.
 *
 * Registering the flow is what lets its round-one handoff resolve: the engine
 * looks the round-two flow up by tag among registered declarations. The
 * executor merges this beside a target's own interpreter registration so an
 * install target reached from any dependency graph can execute.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerInstall = Layer.mergeAll(
  Install.layer,
  Interpreter.layer(Install.Install)
)

/**
 * Plans and executes the install package's Install Flow under pnpm.
 *
 * The package-manager service carries the absolute workspace root, so this
 * operation never mutates the process-wide current directory and independent
 * callers can safely run against different workspaces at the same time.
 *
 * @category execution
 * @since 0.1.0
 */
export const runInstall = async (
  workspaceRoot: string,
  options: { readonly signal?: AbortSignal | undefined } = {}
): Promise<InstallResult> => {
  const workspace = await Fs.realpath(NodePath.resolve(workspaceRoot))
  const runtime = layerInstall.pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(layerPackageManager(workspace)),
    Layer.provideMerge(NodeServices.layer)
  )
  const graph = Graph.build(Install.Install, {})
  const executionId = `tsflows-install-${createHash("sha256").update(workspace).digest("hex").slice(0, 16)}`
  const result = await Effect.runPromise(
    Install.Install.execute({}, { executionId }).pipe(Effect.provide(runtime)),
    { signal: options.signal }
  )
  return {
    workspace,
    manager: "pnpm",
    plan: Graph.nodes(graph).map((node) => ({
      id: node.id,
      kind: node.kind,
      dependencies: node.dependencies
    })),
    result
  }
}
