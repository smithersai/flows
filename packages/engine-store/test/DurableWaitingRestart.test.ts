import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const fixture = fileURLToPath(new URL("./fixtures/durable-wait-child.ts", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url))

interface ChildResult {
  readonly stdout: string
  readonly stderr: string
}

const runChild = (
  mode: string,
  filename: string,
  executionId: string,
  value?: string
): Promise<ChildResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fixture, mode, filename, executionId, ...(value === undefined ? [] : [value])],
      { cwd: repositoryRoot }
    )
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`child ${mode} exited with ${code ?? signal}\n${stderr}\n${stdout}`))
      }
    })
  })

const startChild = (
  mode: string,
  filename: string,
  executionId: string
): ChildProcessWithoutNullStreams =>
  spawn(process.execPath, [fixture, mode, filename, executionId], {
    cwd: repositoryRoot
  })

const firstJsonLine = (
  child: ChildProcessWithoutNullStreams
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => {
      reject(new Error(`child did not produce a JSON line\n${stderr}\n${stdout}`))
    }, 10_000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      const newline = stdout.indexOf("\n")
      if (newline < 0) return
      clearTimeout(timeout)
      resolve(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>)
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", (cause) => {
      clearTimeout(timeout)
      reject(cause)
    })
    child.once("exit", (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`child exited before its marker with ${code ?? signal}\n${stderr}\n${stdout}`))
    })
  })

const killHard = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  child.kill("SIGKILL")
  await once(child, "exit")
}

describe("durable waiting across process loss", () => {
  it("picks up a pending deferred wait after a hard process kill", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flows-durable-wait-"))
    const filename = join(directory, "wait.sqlite")
    const executionId = "hard-kill-wait"
    const first = startChild("wait-start", filename, executionId)
    try {
      expect(await firstJsonLine(first)).toEqual({ status: "suspended" })
      await killHard(first)

      const completion = await runChild(
        "wait-complete-unregistered",
        filename,
        executionId
      )
      expect(JSON.parse(completion.stdout.trim())).toEqual({
        status: "completion-recorded"
      })

      const restarted = await runChild("wait-restart", filename, executionId)
      const result = JSON.parse(restarted.stdout.trim()) as {
        readonly status: string
        readonly state: { readonly result?: unknown }
      }
      expect(result.status).toBe("completed")
      expect(result.state.result).toBeDefined()
    } finally {
      if (first.exitCode === null && first.signalCode === null) {
        await killHard(first)
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it("re-arms a future timer after restart and fires at its stored deadline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flows-durable-timer-"))
    const filename = join(directory, "timer.sqlite")
    const executionId = "future-timer"
    const first = startChild("timer-start", filename, executionId)
    try {
      expect(await firstJsonLine(first)).toEqual({ status: "suspended" })
      await killHard(first)

      const restarted = await runChild("timer-restart", filename, executionId)
      const lines = restarted.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(lines[0]).toEqual({
        status: "restarted",
        completedAtMs: null
      })
      expect(lines[1]?.status).toBe("completed")
    } finally {
      if (first.exitCode === null && first.signalCode === null) {
        await killHard(first)
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it("allows only one deferred completion winner across two processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flows-durable-race-"))
    const filename = join(directory, "race.sqlite")
    const executionId = "process-race"
    try {
      await runChild("state-init", filename, executionId)
      const results = await Promise.all([
        runChild("state-complete", filename, executionId, "left"),
        runChild("state-complete", filename, executionId, "right")
      ])
      const outcomes = results.map((result) =>
        JSON.parse(result.stdout.trim()) as {
          readonly tag: string
          readonly row: unknown
        }
      )
      expect(outcomes.map((outcome) => outcome.tag).sort()).toEqual([
        "Completed",
        "Existing"
      ])
      expect(outcomes[0]?.row).toEqual(outcomes[1]?.row)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)
})
