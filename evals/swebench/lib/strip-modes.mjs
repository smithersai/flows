/**
 * Drops file sections whose only change is the permission bit.
 *
 *   node lib/strip-modes.mjs <patch>
 *
 * Extracting the image's /testbed to the host loses the executable bit, and the
 * colocated jj snapshot records the changed modes into git's index, so a diff
 * against the base commit is otherwise 1600 mode-only sections around a handful
 * of real edits. A SWE-bench patch is content; mode is noise.
 */
import { readFileSync, writeFileSync } from "node:fs"

const path = process.argv[2]
const text = readFileSync(path, "utf8")
const sections = text.split(/(?=^diff --git )/m).filter((section) => section.trim().length > 0)
const kept = sections.filter((section) => {
  const body = section.split("\n").slice(1)
  return body.some((line) => !/^(old mode |new mode |index |similarity |rename |diff --git |$)/.test(line))
})
writeFileSync(path, kept.join(""))
console.log(`${path}: ${sections.length} sections -> ${kept.length}`)
