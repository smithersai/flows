/**
 * The one contract the cell-first harness teaches a model.
 *
 * Governing design: `docs/specs/Concepts/Agent Cell Context.md`.
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import { Option } from "effect"
import type * as Cell from "../Cell.ts"

/**
 * One rendered prompt section, with the digest that identifies its
 * content.
 *
 * @since 0.1.0
 * @private
 */
export interface Section {
  readonly id: "cell-contract" | "cell-catalog"
  readonly text: string
  readonly digest: string
}

const contract = `You advance this task one cell at a time.

Every reply MUST contain exactly one fenced block tagged \`cell\`, and nothing in it but JavaScript:

\`\`\`cell
const files = await ctx.call("fs/list", { path: "." })
return {
  intent: "continue",
  state: { seen: files.length },
  context: [{ role: "user", text: "Listed " + files.length + " entries." }]
}
\`\`\`

The block is the body of an async function. Rules:

1. \`ctx\` is your only binding. \`ctx.call(name, input)\` runs a flow and resolves with its result; \`ctx.flows\` is the catalog of flows you may call; \`ctx.state\` is the durable state your previous cell returned, as a frozen value. There is nothing else — no imports, no exports, no require, no fetch, no filesystem, no process, no Date, no Math.random. Referencing anything else throws.
2. Everything effectful is a flow. Reading a file, running a command, remembering something, asking a question, delegating to a subagent: all of them are \`ctx.call\`.
3. Calls are ordinary awaits, so derive later inputs from earlier results inside one cell instead of spending a frame per call. A failed flow call throws a catchable FlowCallError — wrap a call you are not sure of in try/catch and handle the failure in the same cell, because an uncaught throw ends the frame and costs you a model turn. Long calls are fine: a test suite that runs for minutes only spends the flow's own budget, never your cell's.
4. Return a transition. Exactly one of:
   - \`{ intent: "continue", state, context }\` — run another frame. \`state\` is yours: any JSON you want carried forward. \`context\` is the exact list of \`{ role, text }\` entries the next model call will see, so summarize deliberately; anything you leave out is gone.
   - \`{ intent: "complete", state, output, reason }\` — the task is done and \`output\` is the answer.
   - \`{ intent: "park", state, reason, message }\` — stop durably and wait, with \`reason\` one of "waiting-input", "waiting-event", "waiting-quota".
5. Your cell is re-executed from the top after a crash or a resume. Calls that already settled return their recorded results without running again, so keep cells deterministic: no wall-clock branching, no randomness, no hidden state outside \`state\`.
6. The \`state\` you return is the next cell's \`ctx.state\`. Treat it as your working memory: store what you learn there — file excerpts you plan to edit, test output, decisions — and read it back with \`ctx.state\` instead of re-running calls. Small states are also shown in the system context; large ones show a key roster.
7. Make progress every frame. Read broadly in ONE cell (several awaits), store findings in \`state\`, then commit to edits and verify by running the project's tests. Do not complete until a real command has shown your change works.

If a cell throws or returns something that is not a transition, you are told exactly what happened and get another frame to fix it.`

const digest = (id: Section["id"], text: string): string => Digest.digest(CanonicalJson.stringify({ id, text }))

const catalogText = (flows: Readonly<Record<string, Cell.FlowProjection>>): string => {
  const names = Object.keys(flows).sort()
  if (names.length === 0) {
    return "No flows are callable in this run. Complete or park; ctx.call has nothing to reach."
  }
  const lines = names.map((name) => {
    const projection = flows[name]!
    const capabilities = projection.capabilities.length === 0
      ? ""
      : ` capabilities=${[...projection.capabilities].sort().join(",")}`
    const heading = `- ${name} (${projection.tier})${capabilities}: ${projection.description}`
    // The input schema is the difference between choosing a call and guessing
    // one. A rejected input costs a whole frame, so a catalog that names a
    // flow without saying what it takes spends the run's frame budget on
    // trial and error.
    return Option.isNone(projection.input)
      ? heading
      : `${heading}\n  input: ${JSON.stringify(projection.input.value)}`
  })
  return `Flows callable with ctx.call in this frame:\n${lines.join("\n")}`
}

/**
 * Builds the two cell-contract teaching sections for one frame.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  flows: Readonly<Record<string, Cell.FlowProjection>>
): ReadonlyArray<Section> => {
  const catalog = catalogText(flows)
  return [
    { id: "cell-contract", text: contract, digest: digest("cell-contract", contract) },
    { id: "cell-catalog", text: catalog, digest: digest("cell-catalog", catalog) }
  ]
}
