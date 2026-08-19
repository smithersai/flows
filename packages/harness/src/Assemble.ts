/**
 * Pure construction of model context from declared and recorded values.
 *
 * Governing designs: `docs/specs/Concepts/System Prompt.md` and
 * `docs/specs/Concepts/Context Window.md`. Advisory memory sources follow
 * `docs/specs/Concepts/Memory.md`.
 *
 * @since 0.1.0
 */
import type { JournalEvent } from "@smthrs/journal"
import { ModelRequest } from "@smthrs/model"
import { Disclosure } from "@smthrs/registry"
import type { Descriptor } from "@smthrs/registry"
import * as ContextWindow from "./ContextWindow.ts"
import * as SystemPrompt from "./internal/systemPrompt.ts"
import * as Transcript from "./Transcript.ts"
import * as Visibility from "./Visibility.ts"

/**
 * A declared text input and its upstream-computed content digest.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface DeclaredText {
  readonly text: string
  readonly digest: string
}

/**
 * Recorded values and declarations used to construct one context window.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Input {
  readonly journal: ReadonlyArray<JournalEvent.Entry>
  readonly system: DeclaredText
  readonly instructions: ReadonlyArray<DeclaredText>
  readonly sources?: ReadonlyArray<DeclaredText> | undefined
  readonly prompt: DeclaredText
  readonly modelId: string
  readonly params: ModelRequest.GenerationParams
  readonly flowInput: unknown
  readonly activeToolNames: ReadonlyArray<string>
  readonly toolDefinitions: ReadonlyArray<ModelRequest.ToolDefinition>
  readonly registry: ReadonlyArray<Descriptor.FlowDescriptor>
  readonly seat?: Visibility.Seat | string | Visibility.Ruleset | undefined
  readonly envelope?: DeclaredText | undefined
  readonly environment?: DeclaredText | undefined
  readonly selfDocumentation?: DeclaredText | undefined
}

const normalized = (value: string): string => value.trim().toLowerCase()

const flowVisible = (input: Input): boolean => {
  const declared = input.toolDefinitions.some((definition) => normalized(definition.name) === "flow")
  const active = input.activeToolNames.some((name) => normalized(name) === "flow")
  return declared && active
}

const visibleActiveTools = (
  names: ReadonlyArray<string>,
  descriptors: ReadonlyArray<Descriptor.FlowDescriptor>,
  hasFlow: boolean
): ReadonlyArray<string> => {
  const visibleNames = new Set(descriptors.map((descriptor) => normalized(descriptor.name)))
  return names.filter((name) => {
    const value = normalized(name)
    return value === "flow" ? hasFlow : visibleNames.has(value)
  })
}

const assembleWindow = (input: Input): ContextWindow.ContextWindow => {
  const transcript = Transcript.projectState(input.journal)
  const params = Object.fromEntries(Object.entries(input.params).filter(([, value]) => value !== undefined))
  const registry = input.seat === undefined ? input.registry : Visibility.filter(input.registry, input.seat)
  const toolDefinitions = input.seat === undefined
    ? input.toolDefinitions
    : input.toolDefinitions.filter((definition) =>
      normalized(definition.name) === "flow" || Visibility.allows(definition.name, input.seat!)
    )
  const hasFlow = flowVisible({ ...input, toolDefinitions })
  const activeTools = input.seat === undefined
    ? input.activeToolNames
    : visibleActiveTools(input.activeToolNames, registry, hasFlow)
  const sections = SystemPrompt.make({
    envelope: input.envelope ?? input.system,
    registry: Disclosure.toXml(registry),
    flowVisible: hasFlow,
    environment: input.environment,
    instructions: [...input.instructions, ...(input.sources ?? []).filter((source) => source.text.length > 0)],
    prompt: input.prompt,
    flowInput: input.flowInput,
    params,
    selfDocumentation: input.selfDocumentation
  })
  const sectionSegment = (
    section: SystemPrompt.Section,
    kind: ContextWindow.SegmentKind
  ): ContextWindow.SegmentInput => ({
    kind,
    zone: "prefix",
    declaredDigest: section.digest,
    content: [ModelRequest.SystemPart.make({ text: section.text })]
  })
  const segments: Array<ContextWindow.SegmentInput> = [
    sectionSegment(sections[0]!, "system"),
    sectionSegment(sections[1]!, "system"),
    sectionSegment(sections[2]!, "system"),
    sectionSegment(sections[3]!, "registry"),
    sectionSegment(sections[4]!, "system"),
    sectionSegment(sections[5]!, "system"),
    sectionSegment(sections[6]!, "instructions"),
    {
      kind: "tools",
      zone: "prefix",
      content: toolDefinitions
    },
    ...transcript.messages.map((item) => ({
      kind: item.kind,
      zone: "tail" as const,
      content: [item.message]
    }))
  ]
  return ContextWindow.make({
    modelId: input.modelId,
    segments,
    activeTools: [...activeTools],
    replaced: transcript.replaced
  })
}

/**
 * Assembles the provider-independent context window from durable values only.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const assemble = (input: Input): ContextWindow.ContextWindow => {
  return assembleWindow(input)
}
