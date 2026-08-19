/**
 * Tolerant block matching for the exact-string editing flows.
 *
 * An agent quotes the region it wants to change from its own memory of the
 * file, and memory is whitespace-lossy: a missing blank line or a re-wrapped
 * indent made `edit` fail with "oldString does not occur", and the model —
 * told nothing about what the file actually holds there — re-read and guessed
 * again until the frame budget died. Two benchmark runs burned their entire
 * 100-frame budget exactly this way.
 *
 * Prior art is `reference/opencode`'s replacer cascade (`tool/edit.ts`):
 * exact match first, then line-trimmed, then whitespace-normalized, then
 * indentation-flexible. The cascade only ever *finds* the block; the
 * replacement text is always the caller's own bytes, so a fuzzy match never
 * invents content — it only relocates the caller's intent.
 *
 * @since 0.1.0
 */

/**
 * One located block: the exact source span the strategy matched.
 *
 * @category models
 * @since 0.1.0
 */
export interface Located {
  readonly start: number
  readonly end: number
}

const lines = (text: string): ReadonlyArray<string> => text.split("\n")

/** Cumulative offsets of each line start, for span reconstruction. */
const offsets = (content: ReadonlyArray<string>): ReadonlyArray<number> => {
  const starts: Array<number> = [0]
  for (let index = 0; index < content.length; index++) {
    starts.push(starts[index]! + content[index]!.length + 1)
  }
  return starts
}

const matchByLine = (
  content: string,
  needle: string,
  normalize: (line: string) => string
): ReadonlyArray<Located> => {
  const haystack = lines(content)
  const wanted = lines(needle).map(normalize)
  while (wanted.length > 0 && wanted[wanted.length - 1] === "") wanted.pop()
  if (wanted.length === 0) return []
  const starts = offsets(haystack)
  const found: Array<Located> = []
  for (let index = 0; index + wanted.length <= haystack.length; index++) {
    let matched = true
    for (let step = 0; step < wanted.length; step++) {
      if (normalize(haystack[index + step]!) !== wanted[step]) {
        matched = false
        break
      }
    }
    if (matched) {
      const last = index + wanted.length - 1
      found.push({ start: starts[index]!, end: starts[last]! + haystack[last]!.length })
    }
  }
  return found
}

const trimmedRight = (line: string): string => line.replace(/[ \t]+$/, "")

const collapsed = (line: string): string => line.replace(/[ \t]+/g, " ").trim()

/**
 * Locates every occurrence of `needle` in `content`, most exact strategy
 * first: byte-exact, then trailing-whitespace-insensitive per line, then
 * inner-whitespace-collapsed per line. The first strategy with any match
 * wins, so a byte-exact occurrence is never shadowed by a looser one.
 *
 * @category matching
 * @since 0.1.0
 */
export const locate = (content: string, needle: string): ReadonlyArray<Located> => {
  const exact: Array<Located> = []
  let cursor = content.indexOf(needle)
  while (cursor >= 0) {
    exact.push({ start: cursor, end: cursor + needle.length })
    cursor = content.indexOf(needle, cursor + 1)
  }
  if (exact.length > 0) return exact
  const trimmed = matchByLine(content, needle, trimmedRight)
  if (trimmed.length > 0) return trimmed
  return matchByLine(content, needle, collapsed)
}

/**
 * The actual file region nearest to a failed match, rendered for the error
 * message so the next attempt quotes reality instead of guessing again.
 *
 * Anchored on the needle's first non-blank line (collapsed comparison); when
 * even that line is absent the report says so, which is itself the answer —
 * the model is editing the wrong file.
 *
 * @category matching
 * @since 0.1.0
 */
export const nearestRegion = (content: string, needle: string, span = 7): string | undefined => {
  const anchor = lines(needle).map(collapsed).find((line) => line !== "")
  if (anchor === undefined) return undefined
  const haystack = lines(content)
  const index = haystack.findIndex((line) => collapsed(line) === anchor)
  if (index < 0) return undefined
  const from = Math.max(0, index - 1)
  const to = Math.min(haystack.length, index + span)
  return haystack.slice(from, to)
    .map((line, at) => `${String(from + at + 1).padStart(5)}\t${line}`)
    .join("\n")
}
