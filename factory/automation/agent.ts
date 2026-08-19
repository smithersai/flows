/**
 * The agent seam.
 *
 * Every automation entry that needs judgment calls one function, `ask`. The
 * engine behind it is a value, so the entries never name a vendor: swapping
 * `claude -p` for anything else is a change here and nowhere else, and a test
 * swaps in `stubEngine` without a network or a binary.
 *
 * The seam is deliberately thin. Prefer a plain `gh` call wherever no judgment
 * is needed; an agent that only formats a comment is a slower, less
 * predictable shell script.
 */
import { spawnSync } from "node:child_process"

/** One request to the agent engine. */
export interface AgentRequest {
  /** The prompt. It travels over stdin, never argv. */
  readonly prompt: string
  /** The model to run. Defaults to {@link defaultModel}. */
  readonly model?: string
  /** Wall-clock ceiling in milliseconds. Defaults to {@link defaultTimeoutMs}. */
  readonly timeoutMs?: number
}

/** One answer from the agent engine. */
export interface AgentResult {
  readonly text: string
}

/** A swappable agent engine. */
export interface AgentEngine {
  readonly name: string
  readonly run: (request: AgentRequest) => AgentResult
}

/** The model every automation entry runs on unless it says otherwise. */
export const defaultModel = "claude-opus-5"

/** The wall-clock ceiling for one agent call. */
export const defaultTimeoutMs = 15 * 60 * 1000

/** The largest agent answer this seam accepts. */
export const maximumOutputBytes = 4 * 1024 * 1024

/**
 * Reads the answer text out of the `claude -p --output-format json` envelope.
 *
 * The envelope shape is checked rather than assumed. A CLI upgrade that
 * changes it must fail here, loudly, instead of feeding an object's
 * `[object Object]` into an issue comment.
 */
export const claudeText = (stdout: string): string => {
  const parsed: unknown = JSON.parse(stdout)
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>
    if (record.is_error === true) {
      throw new Error(`the claude CLI reported an error: ${String(record.result ?? "no detail")}`)
    }
    if (typeof record.result === "string") return record.result
  }
  throw new Error(`unexpected claude CLI output: ${stdout.slice(0, 400)}`)
}

/**
 * The headless `claude -p` engine.
 *
 * The flag set mirrors the one `LlmLint` already uses for its reviews: no
 * session persistence, no user settings, no MCP, no slash commands. An
 * automation run must be a pure function of its prompt and the checkout, not
 * of whatever configuration the runner happened to inherit.
 */
export const claudeEngine: AgentEngine = {
  name: "claude",
  run: (request) => {
    const result = spawnSync(
      "claude",
      [
        "-p",
        "--output-format",
        "json",
        "--model",
        request.model ?? defaultModel,
        "--no-session-persistence",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--mcp-config",
        "{}",
        "--setting-sources",
        "",
        "--no-chrome"
      ],
      {
        input: request.prompt,
        encoding: "utf8",
        maxBuffer: maximumOutputBytes,
        timeout: request.timeoutMs ?? defaultTimeoutMs
      }
    )
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      throw new Error(`claude exited with ${String(result.status)}: ${(result.stderr ?? "").slice(0, 400)}`)
    }
    return { text: claudeText(result.stdout) }
  }
}

/**
 * An engine that answers from a fixed script, for tests.
 *
 * It records every prompt it received so a test can assert on what the entry
 * asked, which is usually the interesting half.
 */
export const stubEngine = (replies: ReadonlyArray<string>): AgentEngine & {
  readonly prompts: Array<string>
} => {
  const prompts: Array<string> = []
  let index = 0
  return {
    name: "stub",
    prompts,
    run: (request) => {
      prompts.push(request.prompt)
      const reply = replies[index]
      index += 1
      if (reply === undefined) throw new Error(`the stub engine ran out of replies after ${String(index - 1)}`)
      return { text: reply }
    }
  }
}

let engine: AgentEngine = claudeEngine

/**
 * Replaces the engine for the rest of the process. Tests use it; entries do
 * not.
 */
export const setEngine = (next: AgentEngine): void => {
  engine = next
}

/** The engine currently installed. */
export const currentEngine = (): AgentEngine => engine

/**
 * Asks the installed engine one question.
 *
 * There is no retry and no fallback. An automation run that could not reach a
 * model should fail and be re-run, not quietly produce a worse answer under a
 * different one.
 */
export const ask = (request: AgentRequest): string => engine.run(request).text

/**
 * Asks for JSON and parses it.
 *
 * Models fence their JSON often enough that stripping one fence is worth the
 * four lines. Anything else is a failure: a lenient parser here would turn a
 * refusal into a malformed action on someone's issue.
 */
export const askJson = <A>(request: AgentRequest): A => {
  const text = ask(request).trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text)
  return JSON.parse(fenced === null ? text : fenced[1]!) as A
}
