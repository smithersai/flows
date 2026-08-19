/**
 * Dogfood harness: runs factory background tasks as flows on the flows
 * library itself.
 *
 * Two atoms: `AgentTask` spawns a headless `claude -p` agent, `ShellTask`
 * runs a shell command. Both stream their output to a log file so progress
 * is tailable, and both report failure as a value (`exitCode`) instead of
 * failing the flow, so one bad task never aborts a wave.
 *
 * Imports reach the workspace packages by relative path because the
 * workspace root does not depend on `@smthrs/flow`; pnpm's per-package
 * node_modules resolve their internal deps to the same realpaths, so module
 * identity stays consistent.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { FlowEngine } from "../../packages/engine/src/index.ts"
import { Action, Flow, Interpreter } from "../../packages/flow/src/index.ts"

export const FLOWS_ROOT = path.resolve(import.meta.dirname, "../..")
export const REPO_ROOT = path.resolve(FLOWS_ROOT, "..")
export const REPORTS_DIR = path.join(FLOWS_ROOT, "factory/reports")

export const TaskResult = Schema.Struct({
  id: Schema.String,
  exitCode: Schema.Number,
  logPath: Schema.String,
  tail: Schema.String
})

export type TaskResult = typeof TaskResult.Type

interface SpawnSpec {
  readonly id: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly timeoutMs: number
  readonly logDir: string
}

const runProcess = (spec: SpawnSpec): Promise<TaskResult> =>
  new Promise((resolve) => {
    fs.mkdirSync(spec.logDir, { recursive: true })
    const logPath = path.join(spec.logDir, `${spec.id}.log`)
    const log = fs.createWriteStream(logPath, { flags: "a" })
    log.write(`# ${new Date().toISOString()} ${spec.command} ${spec.args.join(" ")}\n`)
    const env = { ...process.env }
    // A stale ANTHROPIC_API_KEY export overrides subscription OAuth for the
    // claude CLI; the spawned agents must authenticate with the subscription.
    delete env["ANTHROPIC_API_KEY"]
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    })
    let tail = ""
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-4000)
    }
    child.stdout.on("data", (chunk: Buffer) => {
      log.write(chunk)
      keep(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      log.write(chunk)
      keep(chunk)
    })
    const timer = setTimeout(() => {
      log.write(`\n# TIMEOUT after ${spec.timeoutMs}ms\n`)
      child.kill("SIGKILL")
    }, spec.timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      log.end()
      resolve({ id: spec.id, exitCode: -1, logPath, tail: String(error) })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      log.end()
      resolve({ id: spec.id, exitCode: code ?? -1, logPath, tail })
    })
  })

/**
 * A headless coding-agent step: one `claude -p` invocation.
 */
export const AgentTask = Action.make("factory/AgentTask", {
  payload: {
    id: Schema.String,
    prompt: Schema.String,
    cwd: Schema.String,
    model: Schema.String,
    timeoutMs: Schema.Number,
    logDir: Schema.String
  },
  success: TaskResult
})

export const agentTaskLayer = AgentTask.toLayer((payload) =>
  Effect.promise(() =>
    runProcess({
      id: payload.id,
      command: "claude",
      args: [
        "-p",
        payload.prompt,
        "--dangerously-skip-permissions",
        "--model",
        payload.model
      ],
      cwd: payload.cwd,
      timeoutMs: payload.timeoutMs,
      logDir: payload.logDir
    })
  )
)

/**
 * A shell step: one `sh -c` invocation.
 */
export const ShellTask = Action.make("factory/ShellTask", {
  payload: {
    id: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    timeoutMs: Schema.Number,
    logDir: Schema.String
  },
  success: TaskResult
})

export const shellTaskLayer = ShellTask.toLayer((payload) =>
  Effect.promise(() =>
    runProcess({
      id: payload.id,
      command: "sh",
      args: ["-c", payload.command],
      cwd: payload.cwd,
      timeoutMs: payload.timeoutMs,
      logDir: payload.logDir
    })
  )
)

/**
 * Executes one flow on the in-memory engine with both task implementations
 * attached.
 */
export const runFlow = <F extends Flow.Flow.AnyWithProps>(
  flow: F,
  payload: Record<string, unknown>,
  executionId: string
): Promise<unknown> => {
  const layer = Layer.mergeAll(
    agentTaskLayer,
    shellTaskLayer,
    Interpreter.layer(flow as never)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )
  return Effect.runPromise(
    (flow as never as {
      execute: (
        payload: unknown,
        options: { readonly executionId: string }
      ) => Effect.Effect<unknown, unknown, never>
    })
      .execute(payload, { executionId })
      .pipe(Effect.orDie, Effect.provide(layer)) as Effect.Effect<unknown>
  )
}

/** Splits a list into waves of at most `size`. */
export const chunk = <T>(items: ReadonlyArray<T>, size: number): Array<Array<T>> => {
  const waves: Array<Array<T>> = []
  for (let index = 0; index < items.length; index += size) {
    waves.push(items.slice(index, index + size) as Array<T>)
  }
  return waves
}

/** Lists the workspace package directory names. */
export const listPackages = (): Array<string> =>
  fs
    .readdirSync(path.join(FLOWS_ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
