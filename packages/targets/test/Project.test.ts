import * as Effect from "effect/Effect"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  collect,
  collectOutputs,
  defaultIo,
  type Io,
  maximumProjectedFiles,
  maximumProjectedPathBytes,
  maximumProjectedPathDepth,
  project,
  projectInputs,
  ProjectionError,
  resolveProjectedPath
} from "../src/Project.ts"
import * as SafeFs from "../src/SafeFs.ts"

let workspace: string
let scratch: string
const extra: Array<string> = []

const scratchDirectory = async (label: string): Promise<string> => {
  const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), `smthrs-project-${label}-`))
  extra.push(directory)
  return directory
}

const write = async (root: string, path: string, contents: string | Uint8Array): Promise<void> => {
  const absolute = NodePath.join(root, path)
  await Fs.mkdir(NodePath.dirname(absolute), { recursive: true })
  await Fs.writeFile(absolute, contents)
}

const read = (root: string, path: string): Promise<string> => Fs.readFile(NodePath.join(root, path), "utf8")

const sha256 = (contents: string): string => createHash("sha256").update(contents).digest("hex")

const present = async (path: string): Promise<boolean> => {
  try {
    await Fs.lstat(path)
    return true
  } catch {
    return false
  }
}

const failure = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
  throw new Error("expected the projection to fail")
}

beforeEach(async () => {
  workspace = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-project-workspace-"))
  scratch = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-project-scratch-"))
})

afterEach(async () => {
  await Fs.rm(workspace, { recursive: true, force: true })
  await Fs.rm(scratch, { recursive: true, force: true })
  for (const directory of extra.splice(0)) await Fs.rm(directory, { recursive: true, force: true })
})

describe("resolveProjectedPath", () => {
  it("normalizes a workspace-relative path", () => {
    expect(resolveProjectedPath("src/index.ts")).toBe("src/index.ts")
    expect(resolveProjectedPath("./src/index.ts")).toBe("src/index.ts")
    expect(resolveProjectedPath("//src/index.ts")).toBe("src/index.ts")
    expect(resolveProjectedPath("src/./nested/../index.ts")).toBe("src/index.ts")
  })

  it("refuses a path that leaves the workspace", () => {
    expect(() => resolveProjectedPath("../outside.txt")).toThrow(/escapes the workspace/)
    expect(() => resolveProjectedPath("src/../../outside.txt")).toThrow(/escapes the workspace/)
    expect(() => resolveProjectedPath("/etc/passwd")).toThrow(/escapes the workspace/)
  })

  it("refuses a path that is not a portable workspace path", () => {
    expect(() => resolveProjectedPath("src\\index.ts")).toThrow(/portable workspace path/)
    expect(() => resolveProjectedPath("src/\0.ts")).toThrow(/portable workspace path/)
    expect(() => resolveProjectedPath("C:/src/index.ts")).toThrow(/portable workspace path/)
  })

  it("refuses a path inside a reserved directory", () => {
    expect(() => resolveProjectedPath(".git/config")).toThrow(/reserved directory \.git/)
    expect(() => resolveProjectedPath(".flows/store/entry.json")).toThrow(/reserved directory \.flows/)
  })

  it("refuses a path that names a directory rather than a file", () => {
    expect(() => resolveProjectedPath(".")).toThrow(/names its own directory/)
    expect(() => resolveProjectedPath("")).toThrow(/names its own directory/)
  })

  it("bounds the length and the depth of a path", () => {
    const long = `${"a".repeat(maximumProjectedPathBytes)}.ts`
    const deep = `${Array.from({ length: maximumProjectedPathDepth }, () => "d").join("/")}/index.ts`

    expect(() => resolveProjectedPath(long)).toThrow(/exceeds 16384 UTF-8 bytes/)
    expect(() => resolveProjectedPath(deep)).toThrow(/exceeds 256 components/)
  })
})

describe("project", () => {
  it("materializes exactly the declared files under the scratch root", async () => {
    await write(workspace, "src/index.ts", "export const a = 1\n")
    await write(workspace, "src/other.ts", "export const b = 2\n")
    await write(workspace, "package.json", "{}\n")

    const projection = await project(workspace, scratch, ["src/index.ts", "package.json"])

    expect(await read(scratch, "src/index.ts")).toBe("export const a = 1\n")
    expect(await read(scratch, "package.json")).toBe("{}\n")
    expect(projection.files).toEqual([
      { path: "package.json", bytes: 3, digest: sha256("{}\n") },
      { path: "src/index.ts", bytes: 19, digest: sha256("export const a = 1\n") }
    ])
    expect(projection.absent).toEqual([])
    expect(projection.from).toBe(await Fs.realpath(workspace))
    expect(projection.to).toBe(await Fs.realpath(scratch))
  })

  it("leaves an undeclared sibling out of the scratch root", async () => {
    await write(workspace, "src/index.ts", "declared\n")
    await write(workspace, "src/secret.ts", "undeclared\n")

    await project(workspace, scratch, ["src/index.ts"])

    expect(await present(NodePath.join(scratch, "src/index.ts"))).toBe(true)
    expect(await present(NodePath.join(scratch, "src/secret.ts"))).toBe(false)
  })

  it("reports a declared file that names nothing as absent", async () => {
    await write(workspace, "src/index.ts", "present\n")

    const projection = await project(workspace, scratch, ["src/index.ts", "src/missing.ts"])

    expect(projection.absent).toEqual(["src/missing.ts"])
    expect(projection.files.map((file) => file.path)).toEqual(["src/index.ts"])
  })

  it("copies a file larger than one read buffer without corrupting it", async () => {
    const contents = "0123456789abcdef".repeat(40_000)
    await write(workspace, "big.bin", contents)

    const projection = await project(workspace, scratch, ["big.bin"])

    expect(await read(scratch, "big.bin")).toBe(contents)
    expect(projection.files[0]).toEqual({
      path: "big.bin",
      bytes: contents.length,
      digest: sha256(contents)
    })
  })

  it("copies an empty file", async () => {
    await write(workspace, "empty.txt", "")

    const projection = await project(workspace, scratch, ["empty.txt"])

    expect(projection.files[0]).toEqual({ path: "empty.txt", bytes: 0, digest: sha256("") })
  })

  it("declares each path once, whatever spelling it arrived under", async () => {
    await write(workspace, "src/index.ts", "once\n")

    const projection = await project(workspace, scratch, ["src/index.ts", "./src/index.ts", "//src/index.ts"])

    expect(projection.files.map((file) => file.path)).toEqual(["src/index.ts"])
  })

  it("copies as a private file and carries the executable bit", async () => {
    await write(workspace, "tool.sh", "#!/bin/sh\n")
    await write(workspace, "data.txt", "plain\n")
    await Fs.chmod(NodePath.join(workspace, "tool.sh"), 0o755)
    await Fs.chmod(NodePath.join(workspace, "data.txt"), 0o644)

    await project(workspace, scratch, ["tool.sh", "data.txt"])

    const tool = await Fs.stat(NodePath.join(scratch, "tool.sh"))
    const data = await Fs.stat(NodePath.join(scratch, "data.txt"))
    expect(tool.mode & 0o777).toBe(0o700)
    expect(data.mode & 0o777).toBe(0o600)
  })

  it("leaves no temporary behind", async () => {
    await write(workspace, "src/index.ts", "clean\n")

    await project(workspace, scratch, ["src/index.ts"])

    expect(await Fs.readdir(NodePath.join(scratch, "src"))).toEqual(["index.ts"])
  })

  it("refuses a declared input that is a symbolic link", async () => {
    await write(workspace, "target.ts", "real\n")
    await Fs.symlink("target.ts", NodePath.join(workspace, "link.ts"))

    const message = await failure(project(workspace, scratch, ["link.ts"]))

    expect(message).toMatch(/declared input is a symbolic link/)
    expect(await present(NodePath.join(scratch, "link.ts"))).toBe(false)
  })

  it("refuses a declared input reached through a symbolic link that leaves the workspace", async () => {
    const outside = await scratchDirectory("outside")
    await write(outside, "secret.txt", "outside\n")
    await Fs.symlink(outside, NodePath.join(workspace, "escape"))

    const message = await failure(project(workspace, scratch, ["escape/secret.txt"]))

    expect(message).toMatch(/declared input resolves outside the workspace/)
  })

  it("refuses a declared input that is a directory", async () => {
    await write(workspace, "src/index.ts", "nested\n")

    const message = await failure(project(workspace, scratch, ["src"]))

    expect(message).toMatch(/declared input is not a regular file/)
  })

  it("refuses a destination that already exists", async () => {
    await write(workspace, "src/index.ts", "first\n")
    await write(scratch, "src/index.ts", "already here\n")

    const message = await failure(project(workspace, scratch, ["src/index.ts"]))

    expect(message).toMatch(/declared input is already present at its destination/)
    expect(await read(scratch, "src/index.ts")).toBe("already here\n")
  })

  it("refuses a source root that is also the destination root", async () => {
    await write(workspace, "src/index.ts", "same\n")

    const message = await failure(project(workspace, workspace, ["src/index.ts"]))

    expect(message).toMatch(/must be different directories/)
  })

  it("refuses a scratch root that is not a directory", async () => {
    await write(workspace, "src/index.ts", "content\n")
    const file = NodePath.join(await scratchDirectory("file"), "not-a-directory")
    await Fs.writeFile(file, "")

    const message = await failure(project(workspace, file, ["src/index.ts"]))

    expect(message).toMatch(/projection root is not a real directory/)
  })

  it("refuses a scratch parent that is a symbolic link", async () => {
    await write(workspace, "src/index.ts", "content\n")
    await Fs.mkdir(NodePath.join(scratch, "real"))
    await Fs.symlink(NodePath.join(scratch, "real"), NodePath.join(scratch, "src"))

    const message = await failure(project(workspace, scratch, ["src/index.ts"]))

    expect(message).toMatch(/projection parent is a symbolic link/)
  })

  it("refuses a scratch parent that is a file", async () => {
    await write(workspace, "src/index.ts", "content\n")
    await write(scratch, "src", "occupied\n")

    const message = await failure(project(workspace, scratch, ["src/index.ts"]))

    expect(message).toMatch(/projection parent is not a directory/)
  })

  it("refuses more paths than one projection may carry", async () => {
    const paths = Array.from({ length: maximumProjectedFiles + 1 }, (_, index) => `f${index}.ts`)

    const message = await failure(project(workspace, scratch, paths))

    expect(message).toMatch(/carries at most 500000 files/)
  })

  it("stops when the caller cancels", async () => {
    await write(workspace, "src/index.ts", "content\n")
    const controller = new AbortController()
    controller.abort()

    await expect(project(workspace, scratch, ["src/index.ts"], { signal: controller.signal })).rejects.toThrow()
  })

  it("does not interfere with a concurrent projection into another scratch root", async () => {
    const other = await scratchDirectory("other")
    await write(workspace, "src/index.ts", "shared\n")
    await write(workspace, "src/only-first.ts", "first\n")
    await write(workspace, "src/only-second.ts", "second\n")

    const [first, second] = await Promise.all([
      project(workspace, scratch, ["src/index.ts", "src/only-first.ts"]),
      project(workspace, other, ["src/index.ts", "src/only-second.ts"])
    ])

    expect(first.files.map((file) => file.path)).toEqual(["src/index.ts", "src/only-first.ts"])
    expect(second.files.map((file) => file.path)).toEqual(["src/index.ts", "src/only-second.ts"])
    expect(await read(scratch, "src/index.ts")).toBe("shared\n")
    expect(await read(other, "src/index.ts")).toBe("shared\n")
    expect(await present(NodePath.join(scratch, "src/only-second.ts"))).toBe(false)
    expect(await present(NodePath.join(other, "src/only-first.ts"))).toBe(false)
  })
})

describe("project, against a filesystem that changes underneath it", () => {
  it("detects a file that grows while it is being copied", async () => {
    await write(workspace, "src/index.ts", "before\n")
    const io: Io = {
      ...defaultIo,
      open: async (path) => {
        const handle = await defaultIo.open(path)
        return {
          ...handle,
          read: async (into) => {
            const bytesRead = await handle.read(into)
            if (bytesRead === 0) await Fs.appendFile(path, "appended while it was read\n")
            return bytesRead
          }
        }
      }
    }

    const message = await failure(project(workspace, scratch, ["src/index.ts"], { io }))

    expect(message).toMatch(/declared input changed while it was being copied/)
    expect(await Fs.readdir(NodePath.join(scratch, "src"))).toEqual([])
  })

  it("detects a file replaced between the moment it is admitted and the moment it is opened", async () => {
    await write(workspace, "src/index.ts", "before\n")
    const io: Io = {
      ...defaultIo,
      open: async (path) => {
        await Fs.rm(path)
        await Fs.writeFile(path, "an entirely different file\n")
        return defaultIo.open(path)
      }
    }

    const message = await failure(project(workspace, scratch, ["src/index.ts"], { io }))

    expect(message).toMatch(/declared input (was replaced|changed) while it was being opened/)
  })

  it("reports a read that returns an impossible length", async () => {
    await write(workspace, "src/index.ts", "content\n")
    const io: Io = {
      ...defaultIo,
      open: async (path) => {
        const handle = await defaultIo.open(path)
        return { ...handle, read: async () => -1 }
      }
    }

    const message = await failure(project(workspace, scratch, ["src/index.ts"], { io }))

    expect(message).toMatch(/returned an invalid read length: -1/)
  })

  it("gives up when no temporary name can be created", async () => {
    await write(workspace, "src/index.ts", "content\n")
    const io: Io = {
      ...defaultIo,
      create: () => Promise.reject(Object.assign(new Error("exists"), { code: "EEXIST" }))
    }

    const message = await failure(project(workspace, scratch, ["src/index.ts"], { io }))

    expect(message).toMatch(/could not create a unique projection temporary/)
  })

  it("reports a failure to close the source", async () => {
    await write(workspace, "src/index.ts", "content\n")
    const io: Io = {
      ...defaultIo,
      open: async (path) => {
        const handle = await defaultIo.open(path)
        return {
          ...handle,
          close: async () => {
            await handle.close()
            throw new Error("close failed")
          }
        }
      }
    }

    const message = await failure(project(workspace, scratch, ["src/index.ts"], { io }))

    expect(message).toMatch(/declared input could not be closed: .*close failed/)
  })

  it("reports a temporary that did not receive the whole file", async () => {
    await write(workspace, "src/index.ts", "content\n")
    const io: Io = {
      ...defaultIo,
      create: async (path, mode) => {
        const file = await defaultIo.create(path, mode)
        return { ...file, write: async () => {} }
      }
    }

    const message = await failure(project(workspace, scratch, ["src/index.ts"], { io }))

    expect(message).toMatch(/projection temporary did not receive the complete file/)
  })

  it("reports a temporary that is not the private file it was opened as", async () => {
    await write(workspace, "src/index.ts", "content\n")
    const io: Io = {
      ...defaultIo,
      create: async (path, mode) => {
        const file = await defaultIo.create(path, mode)
        await Fs.link(path, `${path}.second`)
        return file
      }
    }

    const message = await failure(project(workspace, scratch, ["src/index.ts"], { io }))

    expect(message).toMatch(/projection temporary did not remain a private file/)
  })

  it("reports a parent directory replaced while the file was being published", async () => {
    await write(workspace, "src/index.ts", "content\n")
    let renames = 0
    const io: Io = {
      ...defaultIo,
      rename: async (from, to) => {
        renames += 1
        if (renames === 1) {
          const parent = NodePath.dirname(to)
          await Fs.rm(from, { force: true })
          await Fs.rm(parent, { recursive: true, force: true })
          await Fs.mkdir(parent)
        }
        await defaultIo.rename(from, to)
      }
    }

    const message = await failure(project(workspace, scratch, ["src/index.ts"], { io }))

    expect(message).toMatch(/projection parent changed while a file was being published|ENOENT/)
  })
})

describe("collect", () => {
  it("copies the declared outputs back into the workspace", async () => {
    await write(scratch, "dist/index.js", "built\n")
    await write(scratch, "dist/index.js.map", "map\n")
    await write(scratch, "dist/undeclared.js", "not an output\n")

    const collected = await collect(scratch, workspace, ["dist/index.js"])

    expect(await read(workspace, "dist/index.js")).toBe("built\n")
    expect(await present(NodePath.join(workspace, "dist/index.js.map"))).toBe(false)
    expect(collected.files).toEqual([{ path: "dist/index.js", bytes: 6, digest: sha256("built\n") }])
  })

  it("round-trips a projected tree", async () => {
    const back = await scratchDirectory("back")
    await write(workspace, "src/index.ts", "export const a = 1\n")
    await write(workspace, "src/nested/deep.ts", "export const b = 2\n")
    const declared = ["src/index.ts", "src/nested/deep.ts"]

    const projection = await project(workspace, scratch, declared)
    const collected = await collect(scratch, back, declared)

    expect(collected.files).toEqual(projection.files)
    expect(await read(back, "src/index.ts")).toBe("export const a = 1\n")
    expect(await read(back, "src/nested/deep.ts")).toBe("export const b = 2\n")
  })

  it("replaces an existing workspace file and keeps its mode", async () => {
    await write(workspace, "dist/index.js", "stale\n")
    await Fs.chmod(NodePath.join(workspace, "dist/index.js"), 0o640)
    await write(scratch, "dist/index.js", "fresh\n")

    await collect(scratch, workspace, ["dist/index.js"])

    expect(await read(workspace, "dist/index.js")).toBe("fresh\n")
    expect((await Fs.stat(NodePath.join(workspace, "dist/index.js"))).mode & 0o777).toBe(0o640)
  })

  it("creates a new workspace file with conventional permissions", async () => {
    await write(scratch, "dist/index.js", "fresh\n")

    await collect(scratch, workspace, ["dist/index.js"])

    const mode = (await Fs.stat(NodePath.join(workspace, "dist/index.js"))).mode & 0o777
    expect(mode & 0o600).toBe(0o600)
    expect(mode & 0o111).toBe(0)
  })

  it("reports a declared output the body never produced as absent", async () => {
    const collected = await collect(scratch, workspace, ["dist/index.js"])

    expect(collected.files).toEqual([])
    expect(collected.absent).toEqual(["dist/index.js"])
  })

  it("refuses a declared output that would replace a symbolic link", async () => {
    const outside = await scratchDirectory("outside")
    await write(outside, "victim.txt", "untouched\n")
    await write(scratch, "dist/index.js", "fresh\n")
    await Fs.mkdir(NodePath.join(workspace, "dist"))
    await Fs.symlink(NodePath.join(outside, "victim.txt"), NodePath.join(workspace, "dist/index.js"))

    const message = await failure(collect(scratch, workspace, ["dist/index.js"]))

    expect(message).toMatch(/declared output destination is a symbolic link/)
    expect(await read(outside, "victim.txt")).toBe("untouched\n")
  })

  it("refuses a declared output that would replace a directory", async () => {
    await write(scratch, "dist/index.js", "fresh\n")
    await Fs.mkdir(NodePath.join(workspace, "dist/index.js"), { recursive: true })

    const message = await failure(collect(scratch, workspace, ["dist/index.js"]))

    expect(message).toMatch(/declared output destination is not a regular file/)
  })
})

describe("the Effect surface", () => {
  it("projects and collects", async () => {
    const back = await scratchDirectory("back")
    await write(workspace, "src/index.ts", "effectful\n")

    const projection = await Effect.runPromise(projectInputs(workspace, scratch, ["src/index.ts"]))
    const collected = await Effect.runPromise(collectOutputs(scratch, back, ["src/index.ts"]))

    expect(projection.files.map((file) => file.path)).toEqual(["src/index.ts"])
    expect(collected.files).toEqual(projection.files)
    expect(await read(back, "src/index.ts")).toBe("effectful\n")
  })

  it("fails with a ProjectionError naming the root", async () => {
    const missing = NodePath.join(scratch, "missing")

    const projected = await Effect.runPromise(Effect.result(projectInputs(workspace, missing, ["src/index.ts"])))
    const collected = await Effect.runPromise(Effect.result(collectOutputs(scratch, missing, ["dist/index.js"])))

    expect(projected._tag).toBe("Failure")
    expect(collected._tag).toBe("Failure")
    for (const result of [projected, collected]) {
      const error = (result as { readonly failure: ProjectionError }).failure
      expect(error).toBeInstanceOf(ProjectionError)
      expect(error.root).toBe(missing)
      expect(error.message).toMatch(/ENOENT/)
    }
  })
})

describe("the projection primitive against SafeFs", () => {
  it("admits exactly what SafeFs admits, and copies through the path SafeFs resolved", async () => {
    await write(workspace, "src/index.ts", "shared discipline\n")
    const root = await SafeFs.canonicalRoot(workspace)
    const entry = await SafeFs.resolveFile(NodePath.join(root, "src/index.ts"), { root })

    const projection = await project(workspace, scratch, ["src/index.ts"])

    expect(entry).toBeDefined()
    expect(projection.files[0]!.digest).toBe(
      await SafeFs.digestFile(NodePath.join(root, "src/index.ts"), { root })
    )
  })
})

/**
 * The checks below fire on filesystem states a real host reaches only under a
 * race. The {@link Io} seam decides when each one happens, so the regression
 * is deterministic instead of timing-dependent — the reason the seam exists.
 */
describe("the checks a confined copy makes on its own descriptors", () => {
  const stats = (path: string): Promise<SafeFs.Stats> => Fs.lstat(path, { bigint: true })

  const overriding = (base: SafeFs.Stats, overrides: Readonly<Record<string, unknown>>): SafeFs.Stats =>
    Object.create(
      base,
      Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, { value }]))
    ) as SafeFs.Stats

  const rejecting = (code: string): Promise<never> =>
    Promise.reject(Object.assign(new Error(`simulated ${code}`), { code }))

  let workspaceReal: string
  let scratchReal: string

  beforeEach(async () => {
    await write(workspace, "src/index.ts", "content\n")
    workspaceReal = await Fs.realpath(workspace)
    scratchReal = await Fs.realpath(scratch)
  })

  it("works through a host that reports numbers rather than bigints", async () => {
    const io: Io = {
      ...defaultIo,
      lstat: (path) => Fs.lstat(path),
      open: async (path) => {
        const handle = await defaultIo.open(path)
        return { ...handle, stat: () => Fs.stat(path) }
      },
      create: async (path, mode) => {
        const file = await defaultIo.create(path, mode)
        return { ...file, stat: () => Fs.stat(path) }
      }
    }

    const projection = await project(workspace, scratch, ["src/index.ts"], { io })

    expect(projection.files).toEqual([{ path: "src/index.ts", bytes: 8, digest: sha256("content\n") }])
  })

  it("refuses a host that reports an impossible size or link count", async () => {
    const size: Io = {
      ...defaultIo,
      lstat: async (path) => overriding(await stats(path), { size: -1 })
    }
    const links: Io = {
      ...defaultIo,
      create: async (path, mode) => {
        const file = await defaultIo.create(path, mode)
        return { ...file, stat: async () => overriding(await file.stat(), { nlink: 1.5 }) }
      }
    }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io: size })))
      .toMatch(/invalid file size: -1/)
    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io: links })))
      .toMatch(/invalid link count: 1.5/)
  })

  it("refuses a read length that is not a length at all", async () => {
    const io: Io = {
      ...defaultIo,
      open: async (path) => {
        const handle = await defaultIo.open(path)
        return { ...handle, read: async () => "eight" as unknown as number }
      }
    }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io })))
      .toMatch(/returned an invalid read length: string/)
  })

  it("refuses a source that became a symbolic link between admission and open", async () => {
    const io: Io = { ...defaultIo, open: () => rejecting("ELOOP") }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io })))
      .toMatch(/declared input became a symbolic link while it was being opened/)
  })

  it("refuses a descriptor that is not a regular file", async () => {
    const io: Io = {
      ...defaultIo,
      open: async (path) => {
        const handle = await defaultIo.open(path)
        return { ...handle, stat: () => stats(NodePath.dirname(path)) }
      }
    }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io })))
      .toMatch(/declared input is not a regular file/)
  })

  it("refuses a descriptor whose size or timestamps moved", async () => {
    const io: Io = {
      ...defaultIo,
      open: async (path) => {
        const handle = await defaultIo.open(path)
        return { ...handle, stat: async () => overriding(await handle.stat(), { size: 1n }) }
      }
    }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io })))
      .toMatch(/declared input changed while it was being opened/)
  })

  it("refuses a descriptor that resolves outside the workspace", async () => {
    const outside = await scratchDirectory("outside")
    const io: Io = {
      ...defaultIo,
      realpath: async (path) =>
        path.endsWith(`src${NodePath.sep}index.ts`)
          ? NodePath.join(await defaultIo.realpath(outside), "index.ts")
          : defaultIo.realpath(path)
    }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io })))
      .toMatch(/declared input left its root while it was being opened/)
  })

  it("refuses a descriptor whose resolved name now points at another object", async () => {
    let resolvedLstats = 0
    const io: Io = {
      ...defaultIo,
      lstat: async (path) => {
        const current = await stats(path)
        if (!path.endsWith(`src${NodePath.sep}index.ts`)) return current
        resolvedLstats += 1
        return resolvedLstats > 1 ? overriding(current, { ino: BigInt(current.ino) + 1n }) : current
      }
    }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io })))
      .toMatch(/declared input was replaced while its open descriptor was being confined/)
  })

  it("reports a parent directory that could not be inspected", async () => {
    const io: Io = {
      ...defaultIo,
      lstat: (path) => path.startsWith(scratchReal) && path !== scratchReal ? rejecting("EACCES") : stats(path)
    }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io }))).toMatch(/simulated EACCES/)
  })

  it("reports a parent directory that could not be created", async () => {
    const io: Io = { ...defaultIo, mkdir: () => rejecting("EACCES") }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io }))).toMatch(/simulated EACCES/)
  })

  it("refuses a parent directory whose canonical location leaves the root", async () => {
    const outside = await scratchDirectory("outside")
    await Fs.mkdir(NodePath.join(scratchReal, "src"))
    const io: Io = {
      ...defaultIo,
      realpath: (path) =>
        path === NodePath.join(scratchReal, "src") ? defaultIo.realpath(outside) : defaultIo.realpath(path)
    }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io })))
      .toMatch(/projection parent leaves the root/)
  })

  it("refuses a parent directory replaced while it was being resolved", async () => {
    await Fs.mkdir(NodePath.join(scratchReal, "src"))
    let parentLstats = 0
    const io: Io = {
      ...defaultIo,
      lstat: async (path) => {
        const current = await stats(path)
        if (path !== NodePath.join(scratchReal, "src")) return current
        parentLstats += 1
        return parentLstats > 1 ? overriding(current, { ino: BigInt(current.ino) + 1n }) : current
      }
    }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io })))
      .toMatch(/projection parent changed while it was being resolved/)
  })

  it("refuses a parent directory that moved between preparation and publication", async () => {
    const real = await Fs.realpath(scratch)
    await Fs.mkdir(NodePath.join(real, "src"))
    await Fs.mkdir(NodePath.join(real, "src-moved"))
    let parentResolutions = 0
    const io: Io = {
      ...defaultIo,
      realpath: async (path) => {
        const resolved = await defaultIo.realpath(path)
        if (resolved !== NodePath.join(real, "src")) return resolved
        parentResolutions += 1
        return parentResolutions > 1 ? NodePath.join(real, "src-moved") : resolved
      }
    }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io })))
      .toMatch(/projection parent changed while a file was being published/)
  })

  it("reports a temporary that could not be created at all", async () => {
    const io: Io = { ...defaultIo, create: () => rejecting("EACCES") }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io }))).toMatch(/simulated EACCES/)
  })

  it("reports a temporary that could not be closed, and cleans it up", async () => {
    const io: Io = {
      ...defaultIo,
      create: async (path, mode) => {
        const file = await defaultIo.create(path, mode)
        return {
          ...file,
          close: async () => {
            await file.close()
            throw new Error("temporary close failed")
          }
        }
      }
    }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io }))).toMatch(/temporary close failed/)
    expect(await Fs.readdir(NodePath.join(scratch, "src"))).toEqual([])
  })

  it("reports a temporary that could not be removed after a failure", async () => {
    const io: Io = {
      ...defaultIo,
      create: async (path, mode) => {
        const file = await defaultIo.create(path, mode)
        return { ...file, write: async () => {} }
      },
      remove: () => rejecting("EBUSY")
    }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io })))
      .toMatch(/projection temporary did not receive the complete file/)
  })

  it("reports a destination that could not be inspected", async () => {
    const io: Io = {
      ...defaultIo,
      lstat: (path) =>
        path.endsWith(`src${NodePath.sep}index.ts`) && path.startsWith(scratchReal)
          ? rejecting("EACCES")
          : stats(path)
    }

    expect(await failure(project(workspace, scratch, ["src/index.ts"], { io }))).toMatch(/simulated EACCES/)
  })

  it("carries the executable bit back into the workspace", async () => {
    await write(scratch, "dist/tool", "#!/bin/sh\n")
    await Fs.chmod(NodePath.join(scratch, "dist/tool"), 0o755)

    await collect(scratch, workspace, ["dist/tool"])

    expect((await Fs.stat(NodePath.join(workspace, "dist/tool"))).mode & 0o111).not.toBe(0)
  })
})
