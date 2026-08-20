import { NodeFileSystem, NodeServices } from "@effect/platform-node"
import { Cause, Effect, Exit, Layer } from "effect"
import * as Path from "effect/Path"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Glob from "../src/Glob.ts"
import * as Grep from "../src/Grep.ts"
import * as NativeSearch from "../src/NativeSearch.ts"
import * as PortableSearch from "../src/PortableSearch.ts"

const root = mkdtempSync(join(tmpdir(), "flows-search-conformance-"))
const file = (relative: string, content: string): void => {
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

beforeAll(() => {
  file("src/a.ts", "intro\nNeedle one\ncontext after\nneedle two\nend")
  file("src/nested/b.ts", "needle b\nmore")
  file("src/nested/excluded.ts", "needle excluded")
  file("src/z.js", "needle javascript")
  file("src/.secret.ts", "needle secret")
  file("src/.git/objects/object.ts", "needle git")
  file("src/node_modules/pkg/index.ts", "needle dependency")
  file("src/.gitignore", "nested/b.ts\n")
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const peers = [
  ["portable", PortableSearch.layer.pipe(Layer.provide(NodeServices.layer))],
  ["native", NativeSearch.layer.pipe(Layer.provide(NodeServices.layer))]
] as const
const portableHost = Layer.merge(NodeFileSystem.layer, Path.layer)

const failure = <A>(exit: Exit.Exit<A, unknown>): { readonly code: unknown; readonly message: unknown } | undefined => {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons.find(Cause.isFailReason)
  if (reason === undefined || typeof reason.error !== "object" || reason.error === null) return undefined
  const record = reason.error as { readonly code?: unknown; readonly message?: unknown }
  return { code: record.code, message: record.message }
}

for (const [peer, implementation] of peers) {
  describe(`Search conformance (${peer})`, () => {
    const grep = (input: typeof Grep.Input.Type) => Effect.runPromise(Effect.provide(Grep.run(input), implementation))
    const glob = (input: typeof Glob.Input.Type) => Effect.runPromise(Effect.provide(Glob.run(input), implementation))

    it("matches with smart case, ordered include/exclude globs, context, and per-file max-count", async () => {
      const result = await grep({
        pattern: "needle",
        root: join(root, "src"),
        smartCase: true,
        globs: ["*.ts", "!excluded.ts"],
        context: 1,
        maxCount: 1
      })
      expect(result).toEqual({
        matches: [
          { file: join(root, "src/a.ts"), line: 1, text: "intro", kind: "context" },
          { file: join(root, "src/a.ts"), line: 2, text: "Needle one", kind: "match" },
          { file: join(root, "src/a.ts"), line: 3, text: "context after", kind: "context" },
          { file: join(root, "src/nested/b.ts"), line: 1, text: "needle b", kind: "match" },
          { file: join(root, "src/nested/b.ts"), line: 2, text: "more", kind: "context" }
        ],
        files: [],
        filesSearched: 2,
        skippedBinary: 0,
        truncated: false
      })
    })

    it("returns sorted files for --files-with-matches and applies -i", async () => {
      const result = await grep({
        pattern: "NEEDLE",
        root: join(root, "src"),
        ignoreCase: true,
        globs: ["*.ts", "!excluded.ts"],
        filesWithMatches: true
      })
      expect(result.files).toEqual([join(root, "src/a.ts"), join(root, "src/nested/b.ts")])
      expect(result.matches).toEqual([])
    })

    it("discloses global truncation and notice semantics", async () => {
      const result = await grep({ pattern: "needle", root: join(root, "src"), globs: ["*.ts"], limit: 1 })
      expect(result).toMatchObject({ truncated: true })
      expect(result.matches).toHaveLength(1)
      expect(result.notice).toBe("Showing 1 of 3 lines; output was truncated.")
    })

    it("keeps hidden search opt-in and fixed skip roots explicit", async () => {
      const hidden = await grep({
        pattern: "needle",
        root: join(root, "src"),
        globs: ["*.ts"],
        hidden: true,
        filesWithMatches: true
      })
      const explicit = await grep({
        pattern: "needle",
        root: join(root, "src/.git"),
        globs: ["*.ts"],
        filesWithMatches: true
      })
      expect(hidden.files).toContain(join(root, "src/.secret.ts"))
      expect(hidden.files).not.toContain(join(root, "src/.git/objects/object.ts"))
      expect(explicit.files).toEqual([join(root, "src/.git/objects/object.ts")])
    })

    it("implements rg --files globs with ordering, braces, hidden, and skip rules", async () => {
      const regular = await glob({ pattern: "**/*.{ts,js}", root: join(root, "src") })
      const hidden = await glob({ pattern: "**/*.ts", root: join(root, "src"), hidden: true })
      const explicit = await glob({ pattern: "**/*.ts", root: join(root, "src/node_modules") })
      expect(regular.paths).toEqual([
        join(root, "src/a.ts"),
        join(root, "src/nested/b.ts"),
        join(root, "src/nested/excluded.ts"),
        join(root, "src/z.js")
      ])
      expect(hidden.paths).toContain(join(root, "src/.secret.ts"))
      expect(hidden.paths).not.toContain(join(root, "src/.git/objects/object.ts"))
      expect(explicit.paths).toEqual([join(root, "src/node_modules/pkg/index.ts")])
    })

    it("rejects every option outside the declared subset with typed errors", async () => {
      const unsupported = await Effect.runPromise(Effect.exit(Effect.provide(
        Grep.run({ pattern: "(?=needle)", root }),
        implementation
      )))
      const ignoreFiles = await Effect.runPromise(Effect.exit(Effect.provide(
        Grep.run({ pattern: "needle", root, noIgnore: false }),
        implementation
      )))
      expect(failure(unsupported)).toEqual({
        code: "invalid_pattern",
        message: "Unsupported ripgrep pattern \"(?=needle)\": special groups and lookaround are not supported"
      })
      expect(failure(ignoreFiles)?.code).toBe("invalid_input")
    })
  })
}

it("the in-process peer answers without an rg process service", async () => {
  const result = await Effect.runPromise(Effect.provide(
    Grep.run({ pattern: "needle", root: join(root, "src"), fixedStrings: true, globs: ["*.ts"] }),
    PortableSearch.layer.pipe(Layer.provide(portableHost))
  ))
  expect(result.matches.length).toBeGreaterThan(0)
})

it("both peers reject unsupported regex syntax identically", async () => {
  const exits = await Promise.all(
    peers.map(([, implementation]) =>
      Effect.runPromise(Effect.exit(Effect.provide(Grep.run({ pattern: "(a)\\1", root }), implementation)))
    )
  )
  const portable = exits[0]
  const native = exits[1]
  expect(portable).toBeDefined()
  expect(native).toBeDefined()
  if (portable === undefined || native === undefined) return
  expect(failure(portable)).toEqual(failure(native))
})
