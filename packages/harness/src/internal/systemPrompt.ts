/**
 * The fixed teaching sections used by the built-in harness prompt.
 *
 * Governing design: `docs/specs/Concepts/System Prompt.md`.
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"

/**
 * The fixed set of sections the built-in prompt is assembled from, in
 * render order.
 *
 * @since 0.1.0
 * @private
 */
export type SectionId =
  | "identity"
  | "verbs"
  | "envelope"
  | "registry"
  | "environment"
  | "self-documentation"
  | "project-context"

/**
 * Text supplied by a declaration, carried with the digest that
 * identifies it.
 *
 * @since 0.1.0
 * @private
 */
export interface DeclaredText {
  readonly text: string
  readonly digest: string
}

/**
 * Everything the prompt sections are rendered from.
 *
 * @since 0.1.0
 * @private
 */
export interface Input {
  readonly envelope: DeclaredText
  readonly registry: string
  readonly flowVisible: boolean
  readonly environment?: DeclaredText | undefined
  readonly instructions: ReadonlyArray<DeclaredText>
  readonly prompt: DeclaredText
  readonly flowInput: unknown
  readonly params: unknown
  readonly selfDocumentation?: DeclaredText | undefined
}

/**
 * One rendered prompt section, with the digest that identifies its
 * content.
 *
 * @since 0.1.0
 * @private
 */
export interface Section {
  readonly id: SectionId
  readonly text: string
  readonly digest: string
}

const digest = (id: SectionId, text: string, declaration: unknown): string =>
  Digest.digest(CanonicalJson.stringify({ id, text, declaration }))

const section = (id: SectionId, text: string, declaration: unknown): Section => ({
  id,
  text,
  digest: digest(id, text, declaration)
})

/** Builds the seven ordered teaching sections for one recorded assembly.
 * @category constructors
 * @since 0.1.0
 */
export const make = (input: Input): ReadonlyArray<Section> => {
  const instructions = input.instructions.map((item) => item.text).join("\n")
  const environment = input.environment?.text
    ?? "No additional environment baseline was recorded for this turn."
  const selfDocumentation = input.selfDocumentation?.text
    ?? "Consult the documentation bundle paths supplied by the project when deeper authoring guidance is needed."
  const projectContext = [
    "Project context is root-first. Read the instructions.md chain from the project root toward the current flow before relying on a nested file.",
    instructions.length === 0 ? "" : `Recorded project instructions:\n${instructions}`,
    input.prompt.text.length === 0 ? "" : `Recorded flow prompt:\n${input.prompt.text}`,
    `Recorded flow input and generation parameters:\n${
      CanonicalJson.stringify({ input: input.flowInput, params: input.params })
    }`
  ].filter((value) => value.length > 0).join("\n\n")

  return [
    section(
      "identity",
      "You are a flows agent. Everything you do is a flow: reading a file, editing a file, running a command, or delegating to a subagent. There is one tool, flow, whose argument is a flow name and schema-shaped input. Unknown flow names and validation failures are tool results to retry; they are not harness crashes.",
      {}
    ),
    section(
      "verbs",
      "You have two verbs: invoke a flow, or author a flow. Authoring writes a file into the flow directory: markdown for prompt-shaped flows or a Flow.make file for graphs. Additive discovery makes the new flow available on the next turn. A subagent is a Flow.make with model and flows, where flows are the flows it may call. There is no separate tool concept.",
      {}
    ),
    section(
      "envelope",
      `This run's envelope is the authority boundary. It states what the run may read, write, and reach; do not spend turns discovering denials. Kernel denials refer back to this envelope.\n${
        input.envelope.text || "No additional envelope prose was recorded."
      }`,
      input.envelope.digest
    ),
    section(
      "registry",
      input.flowVisible ? input.registry : "",
      { visible: input.flowVisible, registry: input.registry }
    ),
    section(
      "environment",
      `Recorded environment baseline (cwd, date, platform):\n${environment}\nThis declaration is the recorded baseline for the turn; later harness versions may append explicit drift deltas.`,
      input.environment?.digest ?? "environment-unavailable"
    ),
    section(
      "self-documentation",
      input.flowVisible
        ? `Self-documentation is available by documentation-bundle path, not inline. Read it only when needed.\n${selfDocumentation}`
        : "",
      { visible: input.flowVisible, digest: input.selfDocumentation?.digest ?? "self-documentation-unavailable" }
    ),
    section("project-context", projectContext, {
      instructions: input.instructions.map((item) => item.digest),
      prompt: input.prompt.digest,
      flowInput: input.flowInput,
      params: input.params
    })
  ]
}
