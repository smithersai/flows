/**
 * Defines failures reported by remote sandbox providers.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * The closed set of failure kinds a provider may report.
 *
 * The codes are the sandbox's own. They used to borrow the `Shell` service's
 * closed code set; that service is gone — process execution is Effect's
 * `ChildProcessSpawner` — so the seam declares what a *remote session* can go
 * wrong with and `layer` normalizes those onto `PlatformError`. Provider
 * packages may add SDK details to `cause`, but cannot create new Host-visible
 * failure kinds.
 *
 * @category models
 * @since 0.1.0
 */
export const ProviderErrorCode = Schema.Literals([
  "aborted",
  "timeout",
  "unavailable",
  "spawn_error",
  "unknown"
])

/**
 * @category models
 * @since 0.1.0
 */
export type ProviderErrorCode = typeof ProviderErrorCode.Type

/**
 * A provider failure before it is normalized onto `PlatformError`.
 *
 * @category models
 * @since 0.1.0
 */
export class ProviderError extends Schema.TaggedErrorClass<ProviderError>()(
  "flows/host/RemoteSandbox/ProviderError",
  {
    code: ProviderErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}
