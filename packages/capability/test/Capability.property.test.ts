import { Option } from "effect"
import { FastCheck } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Capability from "../src/Capability.ts"

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  seed: Number(process.env.FC_SEED ?? 20260814),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

const capability = (action: Capability.Action, resource: string): Capability.Capability =>
  Capability.make(action, resource)

const pattern = (action: Capability.PatternAction, resource: string): Capability.CapabilityPattern =>
  new Capability.CapabilityPattern({ action, resource })

const exactActions = [
  "fs:read",
  "fs:write",
  "net:get",
  "net:post",
  "model:call",
  "proc:spawn",
  "jj:status",
  "jj:diff",
  "jj:snapshot",
  "jj:restore",
  "jj:workspace-add",
  "jj:workspace-forget"
] as const satisfies ReadonlyArray<Capability.Action>

const actionArb = FastCheck.constantFrom<Capability.Action>(...exactActions)

const digitArb = FastCheck.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9")

// Every character class matchesResource treats specially, except the glob
// metacharacters `*` and `?`: regex metacharacters, slashes (normalized),
// colons, spaces, and non-ASCII text.
const literalUnit = FastCheck.constantFrom(
  "a",
  "b",
  "Z",
  "0",
  "9",
  ".",
  "+",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  "-",
  "_",
  " ",
  ":",
  "/",
  "\\",
  "é",
  "☃"
)

// Glob-free pattern text: either drawn from the special-character alphabet or
// arbitrary binary text (lone surrogates included) with globs stripped.
const globFreePattern = FastCheck.oneof(
  FastCheck.string({ unit: literalUnit, minLength: 1, maxLength: 24 }),
  FastCheck.string({ unit: "binary", minLength: 1, maxLength: 24 }).map((text) => text.replaceAll(/[*?]/g, ""))
).filter((text) => text.length > 0)

describe("Capability properties", () => {
  it("a glob-free pattern matches exactly its own literal resource and nothing one character away", () => {
    FastCheck.assert(
      FastCheck.property(
        actionArb,
        globFreePattern,
        FastCheck.nat({ max: 1023 }),
        digitArb,
        (action, resource, rawIndex, digit) => {
          const selectedPattern = pattern(action, resource)
          expect(Capability.matches(selectedPattern, capability(action, resource))).toBe(true)

          const index = rawIndex % resource.length
          // Digits are case-stable, so the Windows-path `i` flag cannot make a
          // digit substitution compare equal to the original code unit.
          const replacement = resource[index] === digit ? (digit === "0" ? "1" : "0") : digit
          const mutated = resource.slice(0, index) + replacement + resource.slice(index + 1)
          expect(Capability.matches(selectedPattern, capability(action, mutated))).toBe(false)
        }
      ),
      params
    )
  })

  it("a fuzzed literal regex metacharacter matches only the literal, not an arbitrary substitute", () => {
    // Generalizes the fixed metacharacter table in Capability.test.ts to
    // arbitrary surrounding text drawn from the same hostile alphabet.
    const metacharacterArb = FastCheck.constantFrom(".", "+", "(", ")", "[", "]", "^", "$", "|", "{", "}")
    const fragment = FastCheck.string({ unit: literalUnit, maxLength: 12 })
    FastCheck.assert(
      FastCheck.property(
        actionArb,
        fragment,
        metacharacterArb,
        fragment,
        digitArb,
        (action, prefix, metacharacter, suffix, digit) => {
          const selectedPattern = pattern(action, `${prefix}${metacharacter}${suffix}`)
          expect(Capability.matches(selectedPattern, capability(action, `${prefix}${metacharacter}${suffix}`)))
            .toBe(true)
          expect(Capability.matches(selectedPattern, capability(action, `${prefix}${digit}${suffix}`))).toBe(false)
        }
      ),
      params
    )
  })

  // BUG: repeated-star grant patterns compile to catastrophically backtracking
  // regexes; matching modest non-matching resources already exceeds any honest
  // linear-time budget. Corroborates the 10k-character repeated-star non-match
  // pinned as it.fails via spawnSync in the example suite
  // ("completes a 10k-character non-match for a repeated-star grant pattern").
  it.fails("bounds wall time for adversarial repeated-star patterns against long non-matching resources", () => {
    // Caps keep the worst single evaluation around one second so the failing
    // run and its shrink attempts terminate; honest glob matching would take
    // microseconds at these sizes, so the 100 ms budget has ample slack.
    const resourceLengthCap: Record<number, number> = { 2: 256, 3: 256, 4: 192, 5: 128, 6: 64 }
    const adversarial = FastCheck.integer({ min: 2, max: 6 }).chain((stars) =>
      FastCheck.tuple(
        FastCheck.constant(stars),
        FastCheck.integer({ min: 8, max: resourceLengthCap[stars] ?? 64 })
      )
    )
    FastCheck.assert(
      FastCheck.property(adversarial, ([stars, length]) => {
        const selectedPattern = pattern("fs:read", `${"a*".repeat(stars)}b`)
        const resource = capability("fs:read", "a".repeat(length))
        const startedAt = performance.now()
        const matched = Capability.matches(selectedPattern, resource)
        const elapsedMs = performance.now() - startedAt
        expect(matched).toBe(false)
        expect(elapsedMs).toBeLessThan(100)
      }),
      { ...params, examples: [[[5, 128]]] }
    )
  })

  it("subsumption composes with matching: subsumes(a, b) and matches(b, c) imply matches(a, c)", () => {
    type SegmentKind = "literal" | "star" | "prefix-star" | "question" | "globstar"
    const fragmentUnit = FastCheck.constantFrom(
      "a",
      "Z",
      "0",
      ".",
      "+",
      "(",
      ")",
      "[",
      "]",
      "^",
      "$",
      "|",
      "{",
      "}",
      "-",
      "_"
    )
    const fragment = FastCheck.string({ unit: fragmentUnit, minLength: 1, maxLength: 4 })
    const expansion = FastCheck.oneof(
      FastCheck.constant(""),
      fragment,
      FastCheck.tuple(fragment, fragment).map(([left, right]) => `${left}/${right}`)
    )
    const segmentArb = FastCheck.tuple(
      FastCheck.constantFrom<SegmentKind>("literal", "star", "prefix-star", "question", "globstar"),
      fragment,
      expansion
    )
    type Segment = readonly [SegmentKind, string, string]
    const patternSegment = ([kind, text]: Segment): string =>
      kind === "literal"
        ? text
        : kind === "star"
        ? "*"
        : kind === "prefix-star"
        ? `${text}*`
        : kind === "question"
        ? "?"
        : "**"
    const resourceSegment = ([kind, text, expanded]: Segment): string =>
      kind === "literal"
        ? text
        : kind === "star"
        ? expanded
        : kind === "prefix-star"
        ? `${text}${expanded}`
        : kind === "question"
        ? text[0]!
        : expanded

    const patternActionArb = FastCheck.constantFrom<Capability.PatternAction>(
      ...exactActions,
      "fs:*",
      "net:*",
      "model:*",
      "proc:*",
      "jj:*",
      "*"
    )
    const familyOf = (action: Capability.PatternAction): Capability.PatternAction =>
      action === "*" ? "*" : `${action.slice(0, action.indexOf(":"))}:*` as Capability.PatternAction
    const concreteAction = (action: Capability.PatternAction, pick: number): Capability.Action => {
      if (action === "*") return exactActions[pick % exactActions.length]!
      if (
        action === "fs:*" || action === "net:*" || action === "model:*" || action === "proc:*" || action === "jj:*"
      ) {
        const family = exactActions.filter((exact) => exact.startsWith(action.slice(0, -1)))
        return family[pick % family.length]!
      }
      return action
    }

    let applicable = 0
    FastCheck.assert(
      FastCheck.property(
        FastCheck.array(segmentArb, { minLength: 1, maxLength: 4 }),
        patternActionArb,
        FastCheck.constantFrom("same", "widen-action", "globstar-tail"),
        FastCheck.boolean(),
        FastCheck.nat({ max: 8 }),
        FastCheck.nat({ max: 11 }),
        (segments, rightAction, variant, widenToStar, tailIndex, actionPick) => {
          const right = pattern(rightAction, segments.map(patternSegment).join("/"))
          const requested = capability(
            concreteAction(rightAction, actionPick),
            segments.map(resourceSegment).join("/")
          )
          const leftAction = variant === "same"
            ? rightAction
            : widenToStar
            ? "*"
            : familyOf(rightAction)
          const keep = tailIndex % (segments.length + 1)
          const leftResource = variant === "globstar-tail"
            ? keep === 0 ? "**" : `${segments.slice(0, keep).map(patternSegment).join("/")}/**`
            : right.resource
          const left = pattern(leftAction, leftResource)

          if (Capability.subsumes(left, right) && Capability.matches(right, requested)) {
            applicable += 1
            expect(Capability.matches(left, requested)).toBe(true)
          }
        }
      ),
      params
    )
    expect(applicable).toBeGreaterThan(0)
  })

  it("parse never throws on hostile strings and format(parse(s)) reproduces s exactly on success", () => {
    const hostile = FastCheck.oneof(
      FastCheck.string({ unit: "binary", maxLength: 48 }),
      FastCheck.tuple(actionArb, FastCheck.string({ unit: "binary", maxLength: 32 }))
        .map(([action, resource]) => `${action}:${resource}`),
      FastCheck.tuple(
        FastCheck.string({ unit: "binary", maxLength: 16 }),
        FastCheck.string({ unit: "binary", maxLength: 16 })
      )
        .map(([namespace, rest]) => `${namespace}:${rest}`)
    )
    FastCheck.assert(
      FastCheck.property(hostile, (input) => {
        const parsed = Capability.parse(input)
        if (Option.isSome(parsed)) {
          expect(Capability.format(parsed.value)).toBe(input)
          expect(Option.getOrNull(Capability.parse(Capability.format(parsed.value)))).toEqual(parsed.value)
        } else {
          // Rejection is the typed Option.none, never a throw.
          expect(Option.isNone(parsed)).toBe(true)
        }
      }),
      params
    )
  })
})
