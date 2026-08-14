import * as FileSet from "@smthrs/plan-next/FileSet"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

const glob: FileSet.Glob = { _tag: "Glob", include: ["src/**/*.ts"], exclude: ["src/**/skip.ts"] }
const tree: FileSet.TreeArtifact = { _tag: "TreeArtifact", path: "dist" }

describe("FileSet", () => {
  it("validates workspace-relative patterns", () => {
    expect(Schema.is(FileSet.Pattern)("src/**/*.ts")).toBe(true)
    expect(Schema.is(FileSet.Pattern)("/absolute/**")).toBe(false)
    expect(Schema.is(FileSet.Pattern)("src/../secret")).toBe(false)
  })

  it("constructs and expands named groups deterministically", () => {
    const group = FileSet.makeFilegroup("sources", ["a.ts", glob, tree])
    expect(FileSet.expand(["first", group])).toEqual(["first", "a.ts", glob, tree])
    expect(FileSet.expandReads(["first", { _tag: "Filegroup", name: "reads", entries: ["a.ts", glob] }]))
      .toEqual(["first", "a.ts", glob])
    expect(Schema.is(FileSet.Filegroup)(group)).toBe(true)
    expect(Schema.is(FileSet.ReadFilegroup)({ _tag: "Filegroup", name: "r", entries: [tree] })).toBe(false)
  })

  it("recognizes declarations without shape-sniffing strings", () => {
    expect(FileSet.isGlob(glob)).toBe(true)
    expect(FileSet.isGlob(tree)).toBe(false)
    expect(FileSet.isGlob(null)).toBe(false)
    expect(FileSet.isTreeArtifact(tree)).toBe(true)
    expect(FileSet.isTreeArtifact(glob)).toBe(false)
    expect(FileSet.isTreeArtifact("dist")).toBe(false)
  })

  it("implements segment-local star, recursive doublestar, and exclusions", () => {
    expect(FileSet.matchesPattern("src/*.ts", "src/a.ts")).toBe(true)
    expect(FileSet.matchesPattern("src/*.ts", "src/deep/a.ts")).toBe(false)
    expect(FileSet.matchesPattern("src/**/a.ts", "src/a.ts")).toBe(true)
    expect(FileSet.matchesPattern("src/**/a.ts", "src/deep/more/a.ts")).toBe(true)
    expect(FileSet.matchesPattern("src/**", "src/deep/a.ts")).toBe(true)
    expect(FileSet.matchesPattern("src\\*.ts", "src/a.ts")).toBe(true)
    expect(FileSet.matchesPattern("a+[x].ts", "a+[x].ts")).toBe(true)
    expect(FileSet.matchesGlob(glob, "src/a.ts")).toBe(true)
    expect(FileSet.matchesGlob(glob, "src/deep/skip.ts")).toBe(false)
    expect(FileSet.matchesGlob({ _tag: "Glob", include: ["*.ts"] }, "a.ts")).toBe(true)
  })

  it("uses the conservative overlap matrix", () => {
    const all: FileSet.Glob = { _tag: "Glob", include: ["**/*.ts"] }
    expect(FileSet.overlaps("a", "a")).toBe(true)
    expect(FileSet.overlaps("a", "b")).toBe(false)
    expect(FileSet.overlaps("src/a.ts", glob)).toBe(true)
    expect(FileSet.overlaps(glob, "src/a.ts")).toBe(true)
    expect(FileSet.overlaps(glob, all)).toBe(true)
    expect(FileSet.overlaps(tree, "dist/a.js")).toBe(true)
    expect(FileSet.overlaps("dist/a.js", tree)).toBe(true)
    expect(FileSet.overlaps(tree, { _tag: "TreeArtifact", path: "dist/nested" })).toBe(true)
    expect(FileSet.overlaps(tree, { _tag: "TreeArtifact", path: "other" })).toBe(false)
    expect(FileSet.overlaps(tree, glob)).toBe(true)
    expect(FileSet.overlaps(glob, tree)).toBe(true)
  })
})
