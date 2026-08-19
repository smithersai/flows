/**
 * Stable failures reported at the harness translation boundary.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/**
 * Stable harness failure codes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const HarnessErrorCode = Schema.Literals([
  "assembly_failed",
  "render_failed",
  "projection_failed",
  "model_failed",
  "elaboration_failed",
  "engine_failed",
  "invalid_step",
  "read_only_cap",
  "lazy_tool_prompt_metadata",
  "aborted",
  "suspended",
  "adapter_spawn_failed",
  "adapter_quota_exhausted",
  "adapter_session_lost",
  "adapter_config_invalid",
  "adapter_auth_failed",
  "adapter_protocol_error",
  "adapter_binary_missing",
  "adapter_unsupported",
  "adapter_structured_output_failed",
  "unknown"
])

/**
 * Stable harness failure codes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type HarnessErrorCode = typeof HarnessErrorCode.Type

/**
 * A failure while translating a recorded agent turn.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class HarnessError extends Schema.TaggedError<HarnessError>()("/harness/HarnessError", {
  code: HarnessErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}
