import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Effect, Exit, Layer, Option, Path } from "effect"
import { describe, expect, it } from "vitest"
import * as Bash from "../src/Bash.ts"
import { MAX_SHELL_OUTPUT_BYTES } from "../src/internal/Text.ts"
import { layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

describe("Bash", () => {
  it("returns non-zero exit codes as successful results", async () => {
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "unhermetic",
        command: "failing-command"
      }),
      layer({
        commands: {
          "failing-command": { stdout: "partial output", stderr: "failed", exitCode: 23 }
        }
      })
    ))

    expect(result).toMatchObject({
      exitCode: 23,
      stdout: "partial output",
      stderr: "failed",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0
    })
  })

  it("caps stdout and stderr independently and retains each multibyte tail", async () => {
    const stdout = `${"🙂".repeat(7_501)}TAIL`
    const stderr = `${"é".repeat(15_002)}END`
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "unhermetic",
        command: "large-output"
      }),
      layer({
        commands: {
          "large-output": { stdout, stderr, exitCode: 0 }
        }
      })
    ))

    const encoder = new TextEncoder()
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    expect(result.stdout.endsWith("TAIL")).toBe(true)
    expect(result.stderr.endsWith("END")).toBe(true)
    expect(encoder.encode(result.stdout)).toHaveLength(MAX_SHELL_OUTPUT_BYTES)
    expect(encoder.encode(result.stderr).byteLength).toBeLessThanOrEqual(MAX_SHELL_OUTPUT_BYTES)
    expect(result.stdoutDroppedBytes).toBe(8)
    expect(result.stderrDroppedBytes).toBe(8)
    expect(result.stdoutDroppedBytes).toBe(encoder.encode(stdout).byteLength - encoder.encode(result.stdout).byteLength)
    expect(result.stderrDroppedBytes).toBe(encoder.encode(stderr).byteLength - encoder.encode(result.stderr).byteLength)
  })

  it("maps shell timeouts to the typed timeout error", async () => {
    // A process that never exits, so the handler's own deadline is the only
    // thing that can end the run.
    const stalled = ChildProcessSpawner.makeNoop({ spawn: () => Effect.never })
    const exit = await execute(
      Effect.exit(Bash.run({
        mode: "unhermetic",
        command: "timeout-command",
        timeoutMs: 1
      })).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(stalled),
          Path.layer
        ))
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure) && failure.value.code).toBe("timeout")
    }
  })

  it("runs hermetic commands whose path references are declared", async () => {
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "hermetic",
        command: "cat ./input.txt > ./output.txt",
        cwd: "/work",
        reads: ["/work", "/work/input.txt"],
        writes: ["/work/output.txt"]
      }),
      layer({
        // The spawner resolves `cwd` against the filesystem, so the working
        // directory has to exist for the command to start.
        files: { "/work/input.txt": "seed" },
        commands: {
          "cat ./input.txt > ./output.txt": { stdout: "done", exitCode: 0 }
        }
      })
    ))

    expect(result).toMatchObject({ exitCode: 0, stdout: "done" })
  })

  it("checks command references when cwd is the explicit default", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "cat /outside/default.txt",
        cwd: ".",
        reads: [],
        writes: []
      })),
      layer()
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          code: "outside_declared_reads",
          path: "/outside/default.txt"
        })
      }
    }
  })

  it("checks command references when cwd is the absolute resolved base", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "cat /outside/absolute.txt",
        cwd: process.cwd(),
        reads: [],
        writes: []
      })),
      layer()
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          code: "outside_declared_reads",
          path: "/outside/absolute.txt"
        })
      }
    }
  })

  it("refuses an undeclared cwd outside the resolved base", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "true",
        cwd: "/elsewhere",
        reads: [],
        writes: []
      })),
      layer()
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          code: "outside_declared_reads",
          path: "/elsewhere"
        })
      }
    }
  })

  it("keeps omitted cwd unchanged", async () => {
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "hermetic",
        command: "true",
        reads: [],
        writes: []
      }),
      layer({ commands: { true: { stdout: "done", exitCode: 0 } } })
    ))

    expect(result).toMatchObject({ exitCode: 0, stdout: "done" })
  })

  it("fails before spawn when a hermetic command reads an undeclared path", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "cat /outside/secret.txt",
        reads: ["/work/**"],
        writes: []
      })),
      layer({
        commands: {
          "cat /outside/secret.txt": { stdout: "must not run", exitCode: 0 }
        }
      })
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          code: "outside_declared_reads",
          path: "/outside/secret.txt"
        })
      }
    }
  })

  it("fails before spawn when a hermetic command writes an undeclared path", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "touch /outside/result.txt",
        reads: [],
        writes: []
      })),
      layer({
        commands: {
          "touch /outside/result.txt": { stdout: "must not run", exitCode: 0 }
        }
      })
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          code: "outside_declared_writes",
          path: "/outside/result.txt"
        })
      }
    }
  })

  it("makes the hermetic and unhermetic tiers explicit", () => {
    expect(Bash.effects).toMatchObject({
      tier: "irreversible",
      mode: "expected",
      reads: [],
      writes: []
    })
    expect(Bash.effectsFor({
      mode: "hermetic",
      command: "true",
      reads: ["/work/input"],
      writes: ["/work/output"]
    })).toMatchObject({
      tier: "compensable",
      mode: "hermetic",
      reads: ["/work/input"],
      writes: ["/work/output"]
    })
    expect(Bash.effectsFor({
      mode: "unhermetic",
      command: "true"
    })).toMatchObject({
      tier: "irreversible",
      mode: "expected",
      reads: [],
      writes: []
    })
  })

  it("separates a probe that never ran from a check that failed", async () => {
    // The django wave-3 result, at the boundary the model reads: exit 1, and
    // nothing whatsoever about the code under test.
    const broken = await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", command: "python -m pytest tests/admin_views" }),
      layer({
        commands: {
          "python -m pytest tests/admin_views": {
            stderr:
              "AttributeError: type object 'AdminViewBasicTest' has no attribute 'test_catch_all_view_append_slash'",
            exitCode: 1
          }
        }
      })
    ))
    expect(broken.exitCode).toBe(1)
    expect(broken.invalidProbe).toMatchObject({ reason: "unknown-test" })
    expect(broken.invalidProbe?.evidence).toContain("test_catch_all_view_append_slash")

    // The same exit code, from a check that actually ran.
    const ran = await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", command: "python -m pytest tests/admin_views" }),
      layer({
        commands: {
          "python -m pytest tests/admin_views": { stdout: "1 failed, 412 passed", exitCode: 1 }
        }
      })
    ))
    expect(ran.exitCode).toBe(1)
    expect(ran.invalidProbe).toBeUndefined()
  })

  it("omits the invalid-probe key entirely from an ordinary result", async () => {
    const result = await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", command: "true" }),
      layer({ commands: { true: { stdout: "", exitCode: 0 } } })
    ))

    expect(Object.hasOwn(result, "invalidProbe")).toBe(false)
  })

  it("classifies against the truncated text the caller receives", async () => {
    // Truncation keeps the tail, which is where a runner prints its refusal, so
    // the evidence line is always quotable from the returned output.
    const stderr = `${"padding\n".repeat(6_000)}ERROR: file or directory not found: tests/absent.py`
    const result = await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", command: "pytest tests/absent.py" }),
      layer({ commands: { "pytest tests/absent.py": { stderr, exitCode: 4 } } })
    ))

    expect(result.stderrTruncated).toBe(true)
    expect(result.invalidProbe?.reason).toBe("unknown-path")
    expect(result.stderr).toContain(result.invalidProbe?.evidence ?? "unreachable")
  })
})
