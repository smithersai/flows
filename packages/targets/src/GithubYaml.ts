/**
 * The YAML rendering primitives every generated GitHub Actions workflow shares.
 *
 * Quoting a workflow value is security-relevant, not cosmetic. A plain scalar
 * that YAML resolves to a boolean, a number, `null`, or a timestamp is a
 * workflow that no longer carries the value the declaration named: a runner
 * `false` is a `runs-on` GitHub rejects, a branch `null` is an empty entry, and
 * an environment key `NO` reaches the runner as the key `false`. There must be
 * exactly one definition of that judgement, so {@link GithubCiGen} and
 * {@link GithubAutomation} both render through this module rather than each
 * carrying a copy.
 *
 * @since 0.1.0
 */

/**
 * Control characters a rendered value may not carry. Tab and newline are
 * legitimate inside a script and are handled by the block-scalar form; the
 * rest are not. A carriage return is the one that bites: it survives into the
 * generated script, the shell then runs `pnpm install --frozen-lockfile\r` and
 * fails, and an install check would have accepted the step because it trims
 * the line before comparing.
 *
 * @category constants
 * @since 0.1.0
 */
export const controlCharacter = /[\u0000-\u0008\u000B-\u001F\u007F]/

/**
 * Whether a value carries a control character no workflow may render.
 *
 * @category guards
 * @since 0.1.0
 */
export const hasControlCharacter = (value: string): boolean => controlCharacter.test(value)

/**
 * Characters a plain (unquoted) YAML scalar may carry here. `'` is included
 * because a single quote is only an indicator as the FIRST character, which the
 * leading `[A-Za-z0-9]` already excludes; flow indicators (`[`, `]`, `{`, `}`,
 * `,`), `#`, and everything else force quoting.
 */
const plainScalar = /^[A-Za-z0-9][A-Za-z0-9 ._/@:+'-]*$/

/**
 * Plain scalars a YAML parser resolves to something that is not a string.
 *
 * Every attribute rendered through {@link scalar} is declared a `string`, so a
 * value that resolves to a boolean, null, a number, or a timestamp is a value
 * the workflow no longer carries. The YAML 1.2 core schema resolves the
 * booleans, `null`, and the numbers; GitHub's parser also accepts YAML 1.1
 * spellings (`yes`, `off`, `~`, octal, sexagesimal, timestamps), so those are
 * quoted too. The list is deliberately wider than any one parser: quoting a
 * string that did not need it is invisible, resolving one that did is a
 * silently different workflow.
 */
const yamlBoolean = /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/
const yamlNull = /^(?:~|null|Null|NULL)$/
const yamlNumber =
  /^[-+]?(?:0b[01_]+|0o[0-7_]+|0x[0-9a-fA-F_]+|0[0-7_]+|[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?|(?:[0-9][0-9_]*)?\.[0-9_]*(?:[eE][-+]?[0-9]+)?|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?)$/
const yamlInfinity = /^[-+]?\.(?:inf|Inf|INF|nan|NaN|NAN)$/
const yamlTimestamp = /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt ].*)?$/

/**
 * Whether a plain scalar would resolve to something other than a string.
 *
 * @category guards
 * @since 0.1.0
 */
export const resolvesToNonString = (value: string): boolean =>
  yamlBoolean.test(value) || yamlNull.test(value) || yamlNumber.test(value) ||
  yamlInfinity.test(value) || yamlTimestamp.test(value)

/**
 * Quotes a scalar unless YAML reads it back as exactly the declared string.
 *
 * `JSON.stringify` emits a YAML double-quoted scalar, whose escape set agrees
 * with JSON's for every character that can appear here, so the quoted form
 * always reads back byte-identical.
 *
 * @category rendering
 * @since 0.1.0
 */
export const scalar = (value: string): string => {
  if (controlCharacter.test(value)) {
    throw new Error(`${JSON.stringify(value)} contains a control character`)
  }
  return plainScalar.test(value) &&
      !value.includes(": ") && !value.endsWith(":") && !/\s$/.test(value) &&
      !resolvesToNonString(value)
    ? value
    : JSON.stringify(value)
}

/**
 * A `runs-on` flow sequence of plain runner labels, `[self-hosted, linux]`.
 * Quoting the whole sequence would turn a label set into a single nonexistent
 * label, so the sequence is re-rendered label by label and everything else is
 * quoted as one scalar.
 */
const runnerSequence = /^\[\s*([A-Za-z0-9_.-]+(?:\s*,\s*[A-Za-z0-9_.-]+)*)\s*\]$/

/**
 * Renders a runner, keeping a label set a sequence.
 *
 * Each label is judged on its own terms: a reserved label inside the sequence
 * (`[self-hosted, null]`) resolves to null and silently drops out of the label
 * set, so it is quoted while its neighbours stay plain.
 *
 * A value that OPENS a YAML flow collection without being a label set is
 * refused rather than quoted. Quoting `[self-hosted, my label]` or
 * `{group: g, labels: [x]}` would turn a collection into one label string that
 * no runner carries, which is a job that never picks up.
 *
 * @category rendering
 * @since 0.1.0
 */
export const runner = (value: string): string => {
  const match = value.match(runnerSequence)
  if (match !== null) return `[${match[1]!.split(",").map((label) => scalar(label.trim())).join(", ")}]`
  if (value.startsWith("[") || value.startsWith("{")) {
    throw new Error(
      `${
        JSON.stringify(value)
      } is not a runner label set; use one label, or [label, label] with labels of [A-Za-z0-9_.-]`
    )
  }
  return scalar(value)
}

/**
 * Renders a `with:` or `env:` map.
 *
 * The KEY goes through {@link scalar} too. A key is declared a string just as a
 * value is, and YAML resolves a plain `NO:`, `ON:`, or `Y:` to a boolean, so an
 * environment variable named `NO` would reach the runner as the key `false`.
 *
 * @category rendering
 * @since 0.1.0
 */
export const mapping = (
  entries: Readonly<Record<string, string>>,
  indent: string
): ReadonlyArray<string> => Object.entries(entries).map(([key, value]) => `${indent}${scalar(key)}: ${scalar(value)}`)

/**
 * The shape {@link renderStep} renders.
 *
 * It is a structural interface rather than a schema so each catalog rule can
 * pass the step type its own attrs schema decoded.
 *
 * @category models
 * @since 0.1.0
 */
export interface StepShape {
  readonly name?: string | undefined
  readonly uses?: string | undefined
  readonly run?: string | undefined
  readonly with?: Readonly<Record<string, string>> | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
}

/**
 * Renders one workflow step at the given indentation.
 *
 * A multiline script becomes a `run: |` block scalar. A blank script line is
 * emitted blank, not as indentation alone, so a generated file carries no
 * trailing whitespace.
 *
 * @category rendering
 * @since 0.1.0
 */
export const renderStep = (step: StepShape, indent: string): ReadonlyArray<string> => {
  const lines: Array<string> = []
  const fields: Array<string> = []
  if (step.name !== undefined) fields.push(`name: ${scalar(step.name)}`)
  if (step.uses !== undefined) fields.push(`uses: ${scalar(step.uses)}`)
  if (step.run !== undefined) {
    fields.push(step.run.includes("\n") ? "run: |" : `run: ${scalar(step.run)}`)
  }
  if (fields.length === 0) {
    throw new Error("a workflow step must declare uses or run")
  }
  lines.push(`${indent}- ${fields[0]}`)
  const inner = `${indent}  `
  const body = (): void => {
    for (const line of step.run!.split("\n")) lines.push(line === "" ? "" : `${inner}  ${line}`)
  }
  for (const field of fields.slice(1)) {
    lines.push(`${inner}${field}`)
    if (field === "run: |") body()
  }
  if (fields[0] === "run: |") body()
  if (step.with !== undefined && Object.keys(step.with).length > 0) {
    lines.push(`${inner}with:`, ...mapping(step.with, `${inner}  `))
  }
  if (step.env !== undefined && Object.keys(step.env).length > 0) {
    lines.push(`${inner}env:`, ...mapping(step.env, `${inner}  `))
  }
  return lines
}
