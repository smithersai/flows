/**
 * The exec boundary's workspace confinement.
 *
 * Every path this action hands a child process is confined to the workspace,
 * symbolic links included. The cache directory is one of those paths: it is
 * substituted into argv immediately before the spawn, so a workspace whose
 * `.flows` is a link to somewhere else would otherwise hand a tool a directory
 * outside the workspace to write into.
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"

let root: string
let outside: string

const payload = (argv: ReadonlyArray<string>, cwd = "."): Exec.Payload => ({
  cwd,
  argv: argv as [string, ...Array<string>],
  env: {},
  secrets: [],
  expectedExitCodes: [0],
  timeoutMs: Exec.defaultTimeoutMs
})

const run = (
  options: Exec.RunOptions,
  value: Exec.Payload
): Promise<Exit.Exit<Exec.Result, Exec.ExecError>> => Effect.runPromiseExit(Exec.run(options, value))

/** Marks one payload as running against the whole workspace, as every rule does today. */
const unprojected = (value: Exec.Payload): Exec.Payload => ({
  ...value,
  projection: { mode: "workspace", inputs: [] }
})

/** Marks one payload as running in a scratch root holding only its declared inputs. */
const projected = (value: Exec.Payload, inputs: ReadonlyArray<string> = []): Exec.Payload => ({
  ...value,
  projection: { mode: "projected", inputs }
})

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-exec-")))
  outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(outside, { recursive: true, force: true })
})

describe("run", () => {
  it("inherits CI so spawned tools stay non-interactive on hosted runners", async () => {
    const previous = process.env.CI
    process.env.CI = "true"
    try {
      // Explicitly unprojected: this case reads the file back out of the host
      // workspace, which is only where it lands when the run is not projected.
      const exit = await run(
        { workspaceRoot: root },
        unprojected(payload([
          "node",
          "-e",
          `require('node:fs').writeFileSync(process.argv[1], process.env.CI ?? "unset")`,
          "ci-probe.txt"
        ]))
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(await Fs.readFile(NodePath.join(root, "ci-probe.txt"), "utf8")).toBe("true")
    } finally {
      if (previous === undefined) delete process.env.CI
      else process.env.CI = previous
    }
  })

  it("substitutes the cache directory token for an ordinary directory", async () => {
    // Explicitly unprojected, for the same reason: the substituted path is
    // read back out of the host workspace.
    const exit = await run(
      { workspaceRoot: root, cacheDirectory: ".flows" },
      unprojected(payload([
        "node",
        "-e",
        `require('node:fs').writeFileSync(process.argv[1], 'ok')`,
        `${Exec.cacheDirectoryToken}.txt`
      ]))
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, ".flows.txt"), "utf8")).toBe("ok")
  })

  /**
   * The gap this closes: substitution ran before anything validated the
   * directory it substituted. `normalizeCacheDirectory` settles the lexical
   * question only, so a `.flows` that is a link out of the workspace was
   * handed straight to the child.
   */
  it("refuses to substitute a cache directory that is a link out of the workspace", async () => {
    await Fs.symlink(outside, NodePath.join(root, ".flows"))

    const exit = await run(
      { workspaceRoot: root, cacheDirectory: ".flows" },
      payload(["node", "-e", "0", Exec.cacheDirectoryToken])
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(await Fs.readdir(outside)).toEqual([])
  })

  it("refuses a working directory that leaves the workspace", async () => {
    await Fs.symlink(outside, NodePath.join(root, "linked"))
    const exit = await run({ workspaceRoot: root }, payload(["node", "-e", "0"], "linked"))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("reports the refusal with the unsubstituted argv", async () => {
    // The diagnostic names the declaration, not the host path the run refused
    // to resolve: a rejected substitution must not leak the location it would
    // have produced.
    await Fs.symlink(outside, NodePath.join(root, ".flows"))
    const exit = await run(
      { workspaceRoot: root, cacheDirectory: ".flows" },
      payload(["node", "-e", "0", Exec.cacheDirectoryToken])
    )

    if (!Exit.isFailure(exit)) throw new Error("expected a failure")
    const rendered = JSON.stringify(exit.cause)
    expect(rendered).toContain("leaves the workspace")
    expect(rendered).toContain("smthrs:cache-directory")
    expect(rendered).not.toContain(outside)
  })

  it("rejects accessor-backed payload data without invoking it", async () => {
    let calls = 0
    const value = payload(["node", "-e", "0"])
    Object.defineProperty(value.argv, "1", {
      enumerable: true,
      get: () => {
        calls += 1
        return "-e"
      }
    })

    expect(Exit.isFailure(await run({ workspaceRoot: root }, value))).toBe(true)
    expect(calls).toBe(0)
  })

  it("rejects a Proxy payload without invoking its traps", async () => {
    let calls = 0
    const value = new Proxy(payload(["node", "-e", "0"]), {
      ownKeys: (target) => {
        calls += 1
        return Reflect.ownKeys(target)
      }
    })

    expect(Exit.isFailure(await run({ workspaceRoot: root }, value))).toBe(true)
    expect(calls).toBe(0)
  })
})

/**
 * Input-projected execution.
 *
 * Projection is a determinism boundary, not a security boundary: it decides
 * what a cooperating tool finds when it opens a declared path. These cases pin
 * the two halves of that contract — an undeclared read fails, and a declared
 * read does not — plus the two properties the rest of the system depends on:
 * the workspace is left alone unless an output was declared, and loopback
 * stays reachable so the secret proxy keeps working.
 */
describe("projected run", () => {
  const write = (path: string, text: string): Exec.Payload =>
    payload([
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(process.argv[1], process.argv[2])`,
      path,
      text
    ])

  const read = (path: string): Exec.Payload =>
    payload([
      process.execPath,
      "-e",
      `process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))`,
      path
    ])

  it("keeps an undeclared write out of the workspace", async () => {
    const exit = await run({ workspaceRoot: root }, projected(write("stray.txt", "scratch only")))

    expect(Exit.isSuccess(exit)).toBe(true)
    await expect(Fs.stat(NodePath.join(root, "stray.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("copies a declared output back into the workspace", async () => {
    // The parent of a declared output exists in the scratch root before the
    // tool starts, so a rule does not have to learn a second convention.
    const exit = await run(
      { workspaceRoot: root, declaredOutputs: { cwd: ".", paths: ["dist/bundle.js"] } },
      projected(write("dist/bundle.js", "built"))
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, "dist", "bundle.js"), "utf8")).toBe("built")
  })

  it("copies back every file under a declared output directory", async () => {
    const exit = await run(
      { workspaceRoot: root, declaredOutputs: { cwd: ".", paths: ["out"] } },
      projected(payload([
        process.execPath,
        "-e",
        "const fs = require('node:fs');fs.mkdirSync('out/nested', {recursive: true});" +
          "fs.writeFileSync('out/one.txt', 'one');fs.writeFileSync('out/nested/two.txt', 'two')"
      ]))
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, "out", "one.txt"), "utf8")).toBe("one")
    expect(await Fs.readFile(NodePath.join(root, "out", "nested", "two.txt"), "utf8")).toBe("two")
  })

  it("fails an undeclared read that succeeds without projection", async () => {
    await Fs.writeFile(NodePath.join(root, "undeclared.txt"), "present", "utf8")

    const ordinary = await run({ workspaceRoot: root }, read("undeclared.txt"))
    const confined = await run({ workspaceRoot: root }, projected(read("undeclared.txt")))

    expect(Exit.isSuccess(ordinary)).toBe(true)
    expect(Exit.isFailure(confined)).toBe(true)
    if (!Exit.isFailure(confined)) throw new Error("expected a failure")
    expect(JSON.stringify(confined.cause)).toContain("ENOENT")
  })

  it("reads a file the payload declared", async () => {
    await Fs.writeFile(NodePath.join(root, "declared.txt"), "present", "utf8")

    const exit = await run({ workspaceRoot: root }, projected(read("declared.txt"), ["declared.txt"]))

    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(exit.value.stdout).toBe("present")
  })

  it("reads a file the target declared as an input", async () => {
    await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "src", "index.ts"), "export const a = 1\n", "utf8")

    const exit = await run(
      { workspaceRoot: root, declaredInputs: ["src/index.ts"] },
      projected(read("src/index.ts"))
    )

    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(exit.value.stdout).toBe("export const a = 1\n")
  })

  it("removes the scratch root when the run settles", async () => {
    const exit = await run({ workspaceRoot: root }, projected(write("stray.txt", "x")))

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await Fs.readdir(NodePath.join(root, ".flows", "scratch"))).toEqual([])
  })

  /**
   * The secret model mints a placeholder and runs a substituting proxy on
   * 127.0.0.1. A projected run that could not reach loopback would break every
   * declared secret silently: the child would keep the placeholder and the
   * request would either fail opaquely or ship a token-shaped string.
   */
  it("keeps the loopback secret proxy reachable", async () => {
    const previous = process.env["SMITHERS_PROJECTED_SECRET"]
    process.env["SMITHERS_PROJECTED_SECRET"] = "value"
    try {
      const value: Exec.Payload = {
        ...projected(payload([
          process.execPath,
          "-e",
          "const url = new URL(process.env.HTTP_PROXY);" +
            "const socket = require('node:net').connect(Number(url.port), url.hostname, () => {" +
            "process.stdout.write(`${url.hostname} ${process.env.SMITHERS_PROJECTED_SECRET.slice(0, 8)}`);" +
            "socket.destroy();});" +
            "socket.on('error', (error) => {process.stdout.write(`unreachable ${error.message}`);" +
            "process.exitCode = 1})"
        ])),
        secrets: [{ _tag: "Secret", env: "SMITHERS_PROJECTED_SECRET" }]
      }

      const exit = await run({ workspaceRoot: root }, value)

      if (!Exit.isSuccess(exit)) throw new Error(`expected success: ${JSON.stringify(exit.cause)}`)
      expect(exit.value.stdout.startsWith("127.0.0.1 ")).toBe(true)
      // The child holds the placeholder, never the credential.
      expect(exit.value.stdout).not.toContain("value")
    } finally {
      if (previous === undefined) delete process.env["SMITHERS_PROJECTED_SECRET"]
      else process.env["SMITHERS_PROJECTED_SECRET"] = previous
    }
  })
})

/** The workspace policy decides in both directions; the payload only asks. */
describe("sandbox policy", () => {
  const stray = payload([
    process.execPath,
    "-e",
    `require('node:fs').writeFileSync('policy.txt', 'x')`
  ])

  it("refuses a payload that asks for projection when the policy is off", async () => {
    const exit = await run(
      { workspaceRoot: root, sandbox: { projection: "off", environment: [] } },
      projected(stray)
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, "policy.txt"), "utf8")).toBe("x")
  })

  it("projects a run that did not ask when the policy forces it", async () => {
    const exit = await run(
      { workspaceRoot: root, sandbox: { projection: "forced", environment: [] } },
      stray
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    await expect(Fs.stat(NodePath.join(root, "policy.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("leaves every run unprojected by default", async () => {
    const exit = await run({ workspaceRoot: root }, stray)

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, "policy.txt"), "utf8")).toBe("x")
  })
})
