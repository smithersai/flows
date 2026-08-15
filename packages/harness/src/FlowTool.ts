/**
 * The provider-visible entry point for invoking flows from an agent turn.
 *
 * @since 0.1.0
 */
import { ModelRequest } from "@smthrs/model"

/**
 * The single tool exposed directly to a model. Flow discovery belongs in the
 * registry prompt segment; it deliberately is not encoded as a schema enum.
 *
 * @category tools
 * @since 0.1.0
 */
export const definition = ModelRequest.ToolDefinition.make({
  name: "flow",
  description: "Run a named flow, or ask a caller-provided creator flow to create one.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "flow", "input"],
            properties: {
              type: { const: "run" },
              flow: { type: "string", description: "The registered flow name." },
              input: { description: "JSON input for the flow." }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "creatorFlow", "input"],
            properties: {
              type: { const: "create" },
              creatorFlow: { type: "string", description: "The caller-provided creator flow name." },
              input: { description: "JSON input for the creator flow." }
            }
          }
        ]
      }
    }
  },
  loader: true
})
