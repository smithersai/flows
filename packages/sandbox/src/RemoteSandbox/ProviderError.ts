/**
 * Defines failures reported by remote sandbox providers.
 *
 * @since 0.1.0
 */
import { ShellErrorCode } from "@smthrs/host/HostError"
import * as Schema from "effect/Schema"

/**
 * A provider failure before it is normalized onto the Host error surface.
 *
 * The code intentionally reuses the closed `ShellErrorCode` schema. Provider
 * packages may add SDK details to `cause`, but cannot create new Host-visible
 * failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export class ProviderError extends Schema.TaggedErrorClass<ProviderError>()(
  "flows/host/RemoteSandbox/ProviderError",
  {
    code: ShellErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}
