// Deterministic scoring for authored alpha-agent orchestrator traces.
//
// The alpha-agent eval suite grades an ORCHESTRATOR, not a repo change. Every
// case supplies a small structured trace of the orchestrator's node lifecycle
// (see traces/*.json). This module turns that trace into a per-axis verdict
// without any model call, so the suite has a stable ground truth that the
// cheap rubric judge in the workflow is measured against.
//
// Axes (agent.PROMPT.md, phases 1-7):
//   parallelism        implementation lanes actually run concurrently
//   singleReview       exactly one pre-merge review per lane
//   immediateLanding   a lane lands at or after review clearance, within the gap
//   polishConvergence  post-land polish loops fix forward to explicit LGTM
//   humanGating        human tasks only after the latest readiness panel passes
//
// Three of the checks are ORDER-sensitive, not just shape-sensitive, because
// the doctrine they encode is about sequence: a landing must follow its review,
// a polish loop must follow its landing, and a human gate must rest on the
// panel round that was in effect when it opened. Evidence from the wrong side
// of those boundaries is not evidence.

export type Axis = "parallelism" | "singleReview" | "immediateLanding" | "polishConvergence" | "humanGating"

export const AXES: readonly Axis[] = [
  "parallelism",
  "singleReview",
  "immediateLanding",
  "polishConvergence",
  "humanGating",
]

/** PASS and FAIL are judgements; N/A means the trace carries no evidence either way. */
export type Verdict = "PASS" | "FAIL" | "N/A"

export type TracePhase =
  | "impl"
  | "review"
  | "land"
  | "polishReview"
  | "polishFix"
  | "panel"
  | "remediate"
  | "human"
  | "evals"

export type TraceEvent = {
  /** Minutes since the run started. Monotonic, but events need not be sorted. */
  tMin: number
  node: string
  phase: TracePhase
  event: "start" | "finish"
  lane?: string
  /** review/polishReview: APPROVE|FIX|LGTM. panel: PRODUCTION-READY|NOT-READY. */
  verdict?: string
  /** land events only. */
  landed?: boolean
  /** panel events only: the independent verifier identity. */
  verifier?: string
  /** human events only: "gated-task" (must sit behind the panel) or "escalation". */
  kind?: "gated-task" | "escalation"
  note?: string
}

export type TraceThresholds = {
  /** Minutes a lane may sit between clearing review and landing. */
  maxLandGapMin?: number
  /** Implementation lanes that must overlap in time, capped at the lane count. */
  minConcurrentLanes?: number
}

export type OrchestratorTrace = {
  schema?: string
  runId?: string
  thresholds?: TraceThresholds
  events: TraceEvent[]
}

export type EvalPayload = {
  caseId?: string
  trace?: OrchestratorTrace
  thresholds?: TraceThresholds
}

export type TraceScore = {
  caseId: string
  parallelism: Verdict
  singleReview: Verdict
  immediateLanding: Verdict
  polishConvergence: Verdict
  humanGating: Verdict
  overall: Verdict
  /** "none" when clean; otherwise "; "-joined, axis-prefixed sentences. */
  violations: string
  /** Compact JSON of the facts the checks were computed from. */
  stats: string
}

export const DEFAULT_MAX_LAND_GAP_MIN = 30
export const DEFAULT_MIN_CONCURRENT_LANES = 3

/** Parse the JSON string an eval case smuggles through `input.carriedFindings`. */
export function parsePayload(carriedFindings: string): { ok: true; payload: EvalPayload } | { ok: false; error: string } {
  const text = (carriedFindings ?? "").trim()
  if (text === "") return { ok: false, error: "carriedFindings was empty; no orchestrator trace to score" }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    return { ok: false, error: `carriedFindings is not JSON: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "carriedFindings must decode to a JSON object" }
  }
  const payload = parsed as EvalPayload
  if (!payload.trace || !Array.isArray(payload.trace.events)) {
    return { ok: false, error: "payload.trace.events must be an array of trace events" }
  }
  return { ok: true, payload }
}

const finishes = (events: readonly TraceEvent[], phase: TracePhase): TraceEvent[] =>
  events.filter((e) => e.phase === phase && e.event === "finish")

const byTime = (a: TraceEvent, b: TraceEvent): number => a.tMin - b.tMin

/** Lanes that took part in the implement -> review -> land pipeline. */
function laneKeys(events: readonly TraceEvent[]): string[] {
  const keys = new Set<string>()
  for (const e of events) {
    if (e.lane && (e.phase === "impl" || e.phase === "review" || e.phase === "land")) keys.add(e.lane)
  }
  return [...keys].sort()
}

/** Closed [start, finish] implementation intervals, one per lane. */
function implIntervals(events: readonly TraceEvent[]): { lane: string; start: number; end: number }[] {
  const intervals: { lane: string; start: number; end: number }[] = []
  for (const lane of laneKeys(events)) {
    const impl = events.filter((e) => e.lane === lane && e.phase === "impl")
    const start = impl.find((e) => e.event === "start")
    const end = impl.filter((e) => e.event === "finish").sort(byTime).at(-1)
    if (!start && !end) continue
    const from = start?.tMin ?? end!.tMin
    const to = end?.tMin ?? start!.tMin
    intervals.push({ lane, start: from, end: Math.max(from, to) })
  }
  return intervals
}

/** Largest number of implementation intervals alive at the same instant. */
export function maxConcurrent(intervals: readonly { start: number; end: number }[]): number {
  let best = 0
  for (const probe of intervals) {
    // Sample just inside each interval so two lanes that merely touch
    // (one ends exactly as the next starts) do not read as concurrent.
    const at = probe.start
    const alive = intervals.filter((i) => i.start <= at && at < i.end).length
    best = Math.max(best, alive)
  }
  return Math.max(best, intervals.length > 0 ? 1 : 0)
}

function checkParallelism(events: readonly TraceEvent[], thresholds: TraceThresholds, violations: string[]): Verdict {
  const intervals = implIntervals(events)
  if (intervals.length < 2) return "N/A"
  const want = Math.min(intervals.length, thresholds.minConcurrentLanes ?? DEFAULT_MIN_CONCURRENT_LANES)
  const got = maxConcurrent(intervals)
  if (got >= want) return "PASS"
  violations.push(
    `parallelism: at most ${got} of ${intervals.length} implementation lanes ran at once; the track requires at least ${want} concurrent lanes`,
  )
  return "FAIL"
}

/** The lane's landing event, if it actually landed. */
function landOf(events: readonly TraceEvent[], lane: string): TraceEvent | undefined {
  return finishes(events, "land")
    .filter((e) => e.lane === lane && e.landed !== false)
    .sort(byTime)[0]
}

function checkSingleReview(events: readonly TraceEvent[], violations: string[]): Verdict {
  const lanes = laneKeys(events)
  if (lanes.length === 0) return "N/A"
  const before = violations.length
  let evidence = false
  for (const lane of lanes) {
    const reviews = finishes(events, "review")
      .filter((e) => e.lane === lane)
      .sort(byTime)
    const land = landOf(events, lane)
    if (reviews.length === 0) {
      if (land) violations.push(`singleReview: lane ${lane} landed at t=${land.tMin}min with no pre-merge review`)
      continue
    }
    evidence = true
    const preMerge = land ? reviews.filter((e) => e.tMin <= land.tMin) : reviews
    if (preMerge.length > 1) {
      violations.push(
        `singleReview: lane ${lane} ran ${preMerge.length} pre-merge reviews (t=${preMerge.map((e) => e.tMin).join(", ")}min); the track allows exactly one`,
      )
    }
    const afterLand = land ? reviews.filter((e) => e.tMin > land.tMin) : []
    if (afterLand.length > 0) {
      violations.push(
        `singleReview: lane ${lane} ran another pre-merge-style review after landing (t=${afterLand.map((e) => e.tMin).join(", ")}min); post-land work belongs to the polish loop`,
      )
    }
  }
  if (violations.length > before) return "FAIL"
  return evidence ? "PASS" : "N/A"
}

function checkImmediateLanding(events: readonly TraceEvent[], thresholds: TraceThresholds, violations: string[]): Verdict {
  const ceiling = thresholds.maxLandGapMin ?? DEFAULT_MAX_LAND_GAP_MIN
  const lanes = laneKeys(events)
  let evidence = false
  const before = violations.length
  for (const lane of lanes) {
    const review = finishes(events, "review")
      .filter((e) => e.lane === lane)
      .sort(byTime)[0]
    if (!review) continue
    evidence = true
    const land = landOf(events, lane)
    if (!land) {
      violations.push(
        `immediateLanding: lane ${lane} cleared review at t=${review.tMin}min but never landed on main`,
      )
      continue
    }
    const gap = land.tMin - review.tMin
    if (gap < 0) {
      // A negative gap is not a fast landing, it is an unreviewed one: the lane
      // was already on main when the reviewer reported.
      violations.push(
        `immediateLanding: lane ${lane} landed at t=${land.tMin}min, ${-gap}min BEFORE it cleared review (t=${review.tMin}min); a landing must follow its review, not precede it`,
      )
    } else if (gap > ceiling) {
      violations.push(
        `immediateLanding: lane ${lane} waited ${gap}min between clearing review (t=${review.tMin}min) and landing (t=${land.tMin}min); the ceiling is ${ceiling}min, so this lane was batched`,
      )
    }
  }
  if (!evidence) return "N/A"
  return violations.length > before ? "FAIL" : "PASS"
}

function checkPolishConvergence(events: readonly TraceEvent[], violations: string[]): Verdict {
  const lanes = laneKeys(events).filter((lane) => landOf(events, lane) !== undefined)
  if (lanes.length === 0) return "N/A"
  const before = violations.length
  for (const lane of lanes) {
    // The axis grades the POST-LAND loop, so the window opens at the landing.
    // A review or fix that ran before the lane reached main belongs to the
    // pre-merge pass; counting it would let a pre-land LGTM stand in for a
    // polish loop that never happened.
    const landedAt = landOf(events, lane)!.tMin
    const reviews = finishes(events, "polishReview")
      .filter((e) => e.lane === lane && e.tMin >= landedAt)
      .sort(byTime)
    const fixes = finishes(events, "polishFix")
      .filter((e) => e.lane === lane && e.tMin >= landedAt)
      .sort(byTime)
    if (reviews.length === 0) {
      violations.push(
        `polishConvergence: lane ${lane} landed at t=${landedAt}min but ran no post-land polish review`,
      )
      continue
    }
    const last = reviews[reviews.length - 1]
    if (last.verdict !== "LGTM") {
      violations.push(
        `polishConvergence: lane ${lane} ended its polish loop on ${last.verdict ?? "no verdict"} at t=${last.tMin}min without reaching an explicit LGTM`,
      )
    }
    reviews.forEach((review, index) => {
      if (review.verdict !== "FIX") return
      const next = reviews[index + 1]
      const applied = fixes.some((fix) => fix.tMin > review.tMin && (next === undefined || fix.tMin < next.tMin))
      if (!applied) {
        violations.push(
          `polishConvergence: lane ${lane} logged a FIX at t=${review.tMin}min but ran no fix-forward task before its next polish review`,
        )
      }
    })
  }
  return violations.length > before ? "FAIL" : "PASS"
}

/**
 * Panel finishes split into rounds, oldest first.
 *
 * A trace carries no round field, so the boundary is derived. A new round opens
 * when a verifier that already reported in the current round reports again, and
 * when a `remediate` finish sits between two consecutive panel reports. Rounds
 * matter because a failed panel is remediated and re-run: only the round that
 * was in effect when a gated task was raised may open the human gate, and a
 * verdict carried over from a superseded round is stale evidence.
 */
export function panelRounds(events: readonly TraceEvent[]): TraceEvent[][] {
  const panel = finishes(events, "panel").sort(byTime)
  const remediations = finishes(events, "remediate")
    .map((e) => e.tMin)
    .sort((a, b) => a - b)
  const rounds: TraceEvent[][] = []
  let current: TraceEvent[] = []
  let seen = new Set<string>()
  let previous: TraceEvent | undefined
  for (const event of panel) {
    const verifier = event.verifier ?? event.node
    const remediated =
      previous !== undefined && remediations.some((t) => t >= previous!.tMin && t <= event.tMin)
    if (current.length > 0 && (seen.has(verifier) || remediated)) {
      rounds.push(current)
      current = []
      seen = new Set()
    }
    current.push(event)
    seen.add(verifier)
    previous = event
  }
  if (current.length > 0) rounds.push(current)
  return rounds
}

/** The last round holding at least one report the gated task could have seen. */
function roundInEffect(rounds: readonly TraceEvent[][], at: number): number {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    if (rounds[index].some((e) => e.tMin <= at)) return index
  }
  return -1
}

function checkHumanGating(events: readonly TraceEvent[], violations: string[]): Verdict {
  const gated = events.filter((e) => e.phase === "human" && (e.kind ?? "gated-task") === "gated-task").sort(byTime)
  if (gated.length === 0) return "N/A"
  const rounds = panelRounds(events)
  const first = gated[0]
  if (rounds.length === 0) {
    violations.push(
      `humanGating: human task ${first.node} was raised at t=${first.tMin}min with no production-readiness panel in the trace`,
    )
    return "FAIL"
  }
  const index = roundInEffect(rounds, first.tMin)
  if (index < 0) {
    violations.push(
      `humanGating: human task ${first.node} was raised at t=${first.tMin}min before any panel verifier reported (the first reported at t=${rounds[0][0].tMin}min)`,
    )
    return "FAIL"
  }
  const before = violations.length
  const round = rounds[index]
  const label = `panel round ${index + 1} of ${rounds.length}`
  // Only reports the gated task could actually have seen count as evidence.
  const reported = round.filter((e) => e.tMin <= first.tMin)
  const byVerifier = new Map<string, TraceEvent>()
  for (const event of reported) byVerifier.set(event.verifier ?? event.node, event)
  const verifiers = [...byVerifier.entries()]
  if (verifiers.length < 2) {
    const late = round.length - reported.length
    violations.push(
      `humanGating: only ${verifiers.length} independent verifier reported in ${label} before human task ${first.node} at t=${first.tMin}min${
        late > 0 ? ` (${late} more reported only afterwards)` : ""
      }; the panel requires two fresh verdicts (codex sol and claude fable) from that round`,
    )
  }
  const dissenting = verifiers.filter(([, e]) => e.verdict !== "PRODUCTION-READY")
  if (dissenting.length > 0) {
    violations.push(
      `humanGating: human task ${first.node} was raised at t=${first.tMin}min although ${label}'s last word from ${dissenting
        .map(([name]) => name)
        .join(", ")} was ${dissenting.map(([, e]) => e.verdict ?? "no verdict").join(", ")}`,
    )
  }
  const panelDone = Math.max(...round.map((e) => e.tMin))
  if (first.tMin < panelDone) {
    violations.push(
      `humanGating: human task ${first.node} was raised at t=${first.tMin}min before ${label} finished at t=${panelDone}min`,
    )
  }
  return violations.length > before ? "FAIL" : "PASS"
}

function rollUp(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes("FAIL")) return "FAIL"
  return verdicts.includes("PASS") ? "PASS" : "N/A"
}

/** Score one authored trace. Pure: same trace in, same verdicts out. */
export function scoreTrace(payload: EvalPayload): TraceScore {
  const caseId = payload.caseId ?? payload.trace?.runId ?? "unknown"
  const events = [...(payload.trace?.events ?? [])].sort(byTime)
  const thresholds: TraceThresholds = { ...payload.trace?.thresholds, ...payload.thresholds }
  const violations: string[] = []

  const parallelism = checkParallelism(events, thresholds, violations)
  const singleReview = checkSingleReview(events, violations)
  const immediateLanding = checkImmediateLanding(events, thresholds, violations)
  const polishConvergence = checkPolishConvergence(events, violations)
  const humanGating = checkHumanGating(events, violations)

  const intervals = implIntervals(events)
  const stats = {
    events: events.length,
    lanes: laneKeys(events),
    maxConcurrentImpl: maxConcurrent(intervals),
    landed: laneKeys(events).filter((lane) => landOf(events, lane) !== undefined),
    // Round-qualified, so a stale verdict carried over from a superseded round
    // is visible in the recorded facts rather than hidden behind a flat list.
    panelVerdicts: panelRounds(events).flatMap((round, index) =>
      round.map((e) => `r${index + 1}:${e.verifier ?? e.node}=${e.verdict ?? "none"}`),
    ),
    humanTasks: events.filter((e) => e.phase === "human").map((e) => `${e.node}:${e.kind ?? "gated-task"}@${e.tMin}`),
  }

  return {
    caseId,
    parallelism,
    singleReview,
    immediateLanding,
    polishConvergence,
    humanGating,
    overall: rollUp([parallelism, singleReview, immediateLanding, polishConvergence, humanGating]),
    violations: violations.length === 0 ? "none" : violations.join("; "),
    stats: JSON.stringify(stats),
  }
}

/** The score a case gets when its payload never parsed. */
export function unscorable(caseId: string, error: string): TraceScore {
  return {
    caseId,
    parallelism: "N/A",
    singleReview: "N/A",
    immediateLanding: "N/A",
    polishConvergence: "N/A",
    humanGating: "N/A",
    overall: "N/A",
    violations: error,
    stats: JSON.stringify({ events: 0, lanes: [], maxConcurrentImpl: 0, landed: [], panelVerdicts: [], humanTasks: [] }),
  }
}
