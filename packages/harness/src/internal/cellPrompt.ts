/**
 * The one contract the cell-first harness teaches a model.
 *
 * This contract is plain JavaScript over `ctx.call`, shaped to look like the
 * Claude Code workflow API, and that is a ruling rather than an accident: will
 * ruled on 2026-08-20 that the model authoring surface stays this shape,
 * because agents perform better on the shape they are trained on. Effect.ts is
 * the language of the code we maintain, not the language the model writes. Do
 * not port this contract onto `Flow`/`Action`/`Node`; that was built out under
 * a 2026-08-12 ruling and reversed. It may be tested later as a benchmark arm
 * and is adopted only if it benchmarks better.
 *
 * Governing design: `docs/specs/Concepts/Model Authoring Surface.md` (the
 * ruling) and `docs/specs/Concepts/Agent Cell Context.md` (the surface).
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
 * @slop
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
   - \`{ intent: "continue", state, context }\` — run another frame. \`state\` is yours: any JSON you want carried forward. \`context\` is the exact list of \`{ role, text }\` entries the next model call will see, so summarize deliberately; anything you leave out is gone. Add \`justification\` only when the harness has asked why a frame changed nothing.
   - \`{ intent: "complete", state, output, reason, verify }\` — the task is done and \`output\` is the answer. \`verify\` is \`{ flow, input }\` naming the canonical bug reproduction: the identical call must have failed before the first write and pass afterward. An audited run re-runs it and refuses green-only evidence that could be satisfied by reverting.
   - \`{ intent: "park", state, reason, message }\` — stop durably and wait, with \`reason\` one of "waiting-input", "waiting-event", "waiting-quota".
5. Your cell is re-executed from the top after a crash or a resume. Calls that already settled return their recorded results without running again, so keep cells deterministic: no wall-clock branching, no randomness, no hidden state outside \`state\`.
6. The \`state\` you return is the next cell's \`ctx.state\`. Treat it as your working memory: store what you learn there — file excerpts you plan to edit, check output, decisions — and read it back with \`ctx.state\` instead of re-running calls. A command becomes evidence only once you have SEEN it fail on the unmodified tree FOR THE RIGHT REASON, which is the bug itself. A command that fails because it names a test, file, module, environment, or program that does not exist reproduces nothing: it fails identically on a broken tree and on a fixed one, so it can never show you that you have won. Results carry \`invalidProbe\` when the flow can tell, but the reading is yours — repair such a probe, by listing the real names first, before you edit anything. Only a check that failed for the right reason is stored as \`verification: { flow, input, outcome }\`, and you then reuse its exact \`flow\` and \`input\` after edits and in \`verify\` rather than deriving or broadening another command. Small states are also shown in the system context; large ones show a key roster.
7. Act, then verify. Read broadly in ONE cell (several awaits), store findings in \`state\`, then commit to an edit. A run may be stopped for spending too many consecutive frames that write nothing, and when that budget is close the harness says so and requires either an edit or a \`justification\` on your next transition.
8. Prove it before you claim it, in as few frames as you can. ONE cell may run the baseline check, read its output, make the edit, and re-run the identical check — a cell can make many calls, and that is the point of writing code instead of emitting one tool call per turn. Before the first write, one targeted command must reproduce the bug and fail for the right reason (rule 6); a probe that did not run is repaired and re-run in that same cell, before any edit. After editing, reuse that identical command and store it in \`state.verification\`. Complete citing it in \`verify\`. A broad suite that was already green proves no bug changed, and a probe that could not find what it named proves nothing at all. Immediately after every source edit, in the same cell, also run the repository's language-aware per-file diagnostics (LSP diagnostics, compiler, pyflakes/ruff, eslint/tsc, as appropriate) on each edited file. Treat undefined-name findings as advisory and fix them before a broad suite; if no such checker is available, record that fact and continue rather than guessing with regex.

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
 * @slop
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
