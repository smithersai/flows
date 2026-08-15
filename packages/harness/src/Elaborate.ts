/**
 * Pure translation of recorded model tool calls into plan children.
 *
 * @since 0.1.0
 */
import * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import { type Option, Schema } from "effect"
import { definition as flowTool } from "./FlowTool.ts"
import * as Plan from "./Plan.ts"

/**
 * A flow exposed as a model-callable tool.
 *
 * @category models
 * @since 0.1.0
 */
export interface FlowDeclaration {
  /** The name recorded on the child plan node. */
  readonly flowName: string
  /** The schema through which model input is decoded and defaulted. */
  readonly input: Schema.ConstraintDecoder<unknown, never>
  /** Canonical capability envelope discovered by the registry. */
  readonly capabilities: ReadonlyArray<string>
  /** Canonical effect declaration discovered by the registry. */
  readonly effects: Descriptor.EffectDeclaration
  /** Canonical placement annotation discovered by the registry. */
  readonly placement: Option.Option<Descriptor.Placement>
}

/**
 * The caller-provided target for `flow` create actions.
 *
 * @category models
 * @since 0.1.0
 */
export interface FlowCreatorDeclaration {
  /** The flow that receives a decoded flow-create action. */
  readonly create: FlowDeclaration
}

/**
 * The declarations available while elaborating one recorded assistant message.
 *
 * @category models
 * @since 0.1.0
 */
export interface Catalog {
  /** Model tool names mapped to their flow declarations. */
  readonly tools: Readonly<Record<string, FlowDeclaration>>
  /** Caller-provided creator flow names mapped to their declarations. */
  readonly creatorFlows?: Readonly<Record<string, FlowDeclaration>> | undefined
  /** The host-selected creator flow for the permanent flow loader tool. */
  readonly flow?: FlowCreatorDeclaration | undefined
}

/**
 * A fully resolved turn elaboration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Elaboration {
  /** The children to splice, if any valid calls were elaborated. */
  readonly batch: Plan.Batch | undefined
  /** Ordered tool-result values for calls that could not become children. */
  readonly errorResults: ReadonlyArray<ModelRequest.ToolResultPart>
  /** Tool-call identifiers in their original provider order. */
  readonly orderedCallIds: ReadonlyArray<string>
}

interface FlowRunArguments {
  readonly type: "run"
  readonly flow: string
  readonly input: unknown
}

interface FlowCreateArguments {
  readonly type: "create"
  readonly creatorFlow: string
  readonly input: unknown
}

type FlowArguments = FlowRunArguments | FlowCreateArguments

const toolCalls = (message: ModelRequest.AssistantMessage): ReadonlyArray<ModelRequest.ToolCallPart> =>
  message.content.filter((part): part is ModelRequest.ToolCallPart => part.type === "tool-call")

const errorResult = (toolCallId: string, content: string): ModelRequest.ToolResultPart =>
  ModelRequest.ToolResultPart.make({ toolCallId, content })

const parse = (arguments_: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true, value: JSON.parse(arguments_) }
  } catch {
    return { ok: false }
  }
}

const decode = (
  declaration: FlowDeclaration,
  input: unknown
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  const result = Schema.decodeUnknownResult(declaration.input)(input)
  return result._tag === "Success" ? { ok: true, value: result.success } : { ok: false }
}

const child = (declaration: FlowDeclaration, callId: string, args: unknown): Plan.Child =>
  new Plan.Child({
    flowName: declaration.flowName,
    callId,
    args,
    capabilities: declaration.capabilities,
    effects: declaration.effects,
    placement: declaration.placement
  })

const flowArguments = (value: unknown): FlowArguments | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("action" in value)) {
    return undefined
  }
  const action = value.action
  if (typeof action !== "object" || action === null || Array.isArray(action) || !("type" in action)) {
    return undefined
  }
  if (action.type === "run") {
    return "flow" in action && typeof action.flow === "string" && "input" in action
      ? { type: action.type, flow: action.flow, input: action.input }
      : undefined
  }
  if (action.type !== "create") {
    return undefined
  }
  return "creatorFlow" in action && typeof action.creatorFlow === "string" && "input" in action
    ? { type: action.type, creatorFlow: action.creatorFlow, input: action.input }
    : undefined
}

const elaborateCall = (
  call: ModelRequest.ToolCallPart,
  catalog: Catalog
): Plan.Child | ModelRequest.ToolResultPart => {
  const parsed = parse(call.arguments)
  if (!parsed.ok) {
    return errorResult(call.id, `Tool ${call.name} received malformed JSON arguments; re-issue the call.`)
  }

  if (call.name === flowTool.name) {
    const action = flowArguments(parsed.value)
    if (action === undefined) {
      return errorResult(call.id, "Flow tool received an unsupported action; re-issue the call.")
    }
    if (action.type === "run") {
      const declaration = catalog.tools[action.flow]
      if (declaration === undefined) {
        return errorResult(call.id, `Unknown flow ${action.flow}; re-issue the call.`)
      }
      const decoded = decode(declaration, action.input)
      return decoded.ok
        ? child(declaration, call.id, decoded.value)
        : errorResult(call.id, `Flow ${action.flow} received invalid input; re-issue the call.`)
    }
    const declaration = catalog.creatorFlows?.[action.creatorFlow] ?? catalog.flow?.create
    if (declaration === undefined) {
      return errorResult(call.id, "Flow creation is not supported in this run; re-issue the call.")
    }
    const decoded = decode(declaration, action.input)
    return decoded.ok
      ? child(declaration, call.id, decoded.value)
      : errorResult(call.id, "Flow creation received invalid input; re-issue the call.")
  }

  const declaration = catalog.tools[call.name]
  if (declaration === undefined) {
    return errorResult(call.id, `Unknown tool ${call.name}; re-issue the call.`)
  }
  const decoded = decode(declaration, parsed.value)
  return decoded.ok
    ? child(declaration, call.id, decoded.value)
    : errorResult(call.id, `Tool ${call.name} received invalid input; re-issue the call.`)
}

/**
 * Elaborates a settled assistant message without executing any flow or
 * computing any child key.
 *
 * @category operations
 * @since 0.1.0
 */
export const elaborate = (message: ModelRequest.AssistantMessage, catalog: Catalog): Elaboration => {
  const calls = toolCalls(message)
  const orderedCallIds = calls.map((call) => call.id)
  if (message.stopReason === "length") {
    return {
      batch: undefined,
      errorResults: calls.map((call) =>
        errorResult(call.id, "The response was truncated; re-issue this tool call in a complete response.")
      ),
      orderedCallIds
    }
  }

  const children: Array<Plan.Child> = []
  const errors: Array<ModelRequest.ToolResultPart> = []
  for (const call of calls) {
    const result = elaborateCall(call, catalog)
    if (result instanceof Plan.Child) {
      children.push(result)
    } else {
      errors.push(result)
    }
  }
  return {
    batch: children.length === 0
      ? undefined
      : new Plan.Batch({
        children
      }),
    errorResults: errors,
    orderedCallIds
  }
}
