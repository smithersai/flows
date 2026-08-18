import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HostServices from "@smthrs/kernel/HostServices"
import * as TestHost from "@smthrs/kernel/test/TestHost"
import * as Workspace from "@smthrs/kernel/Workspace"
import type { PlatformError } from "effect"
import * as Layer from "effect/Layer"

/**
 * Provides deterministic host services behind the permission-aware kernel.
 */
export const layer = (options?: {
  readonly files?: Readonly<Record<string, string>>
  readonly commands?: Readonly<
    Record<string, {
      readonly stdout?: string
      readonly stderr?: string
      readonly exitCode?: number
    }>
  >
  readonly seed?: number
}): Layer.Layer<HostServices.HostService, PlatformError.PlatformError> =>
  HostServices.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        TestHost.layer(options),
        GrantStore.layerNoop,
        Workspace.layer("/")
      )
    )
  )
