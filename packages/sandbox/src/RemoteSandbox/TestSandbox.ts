/**
 * Constructs deterministic remote sandbox providers for tests.
 *
 * @since 0.1.0
 */
import type { ShellResult } from "@smthrs/host/Shell"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { Provider } from "./Provider.ts"
import type { ProviderError } from "./ProviderError.ts"
import type { TestSandboxProvider } from "./TestSandboxProvider.ts"
import type { TestSandboxState } from "./TestSandboxState.ts"
import type { TestScript } from "./TestScript.ts"

/**
 * Constructs a deterministic scripted provider.
 *
 * @private
 * @since 0.1.0
 */
const makeTestSandbox = (options: {
  readonly session?: string | undefined
  readonly scripts?: Readonly<Record<string, TestScript>> | undefined
  readonly openFailure?: ProviderError | undefined
} = {}): TestSandboxProvider => {
  const state: TestSandboxState = {
    openedSessions: [],
    commands: [],
    cancellations: 0
  }

  const script = (command: string): TestScript =>
    options.scripts?.[command] ?? {
      result: { stdout: "", stderr: `command not found: ${command}\n`, exitCode: 127 }
    }

  const exec = Effect.fn("RemoteSandbox.TestSandbox.exec")((command: string) => {
    state.commands.push(command)
    const current = script(command)
    if (current.failure !== undefined) return Effect.fail(current.failure)
    if (current.pending === true) {
      return Effect.never as Effect.Effect<ShellResult, ProviderError>
    }
    return Effect.succeed(
      current.result ?? {
        stdout: "",
        stderr: "",
        exitCode: 0
      }
    )
  })

  const provider: TestSandboxProvider = {
    session: options.session ?? "test-session",
    open: (session) =>
      options.openFailure === undefined
        ? Effect.acquireRelease(
          Effect.sync(() => {
            state.openedSessions.push(session)
          }),
          () =>
            Effect.sync(() => {
              state.cancellations += 1
            })
        )
        : Effect.fail(options.openFailure),
    exec,
    execStream: (command) => {
      state.commands.push(command)
      const current = script(command)
      return current.failure !== undefined
        ? Stream.fail(current.failure)
        : current.pending === true
        ? Stream.never
        : Stream.fromArray(
          current.chunks ??
            [{
              kind: "stdout",
              chunk: new TextEncoder().encode(current.result?.stdout ?? "")
            }]
        )
    },
    state
  }
  return Provider.of(provider) as TestSandboxProvider
}

/**
 * Deterministic scripted provider constructor for adapter and cancellation
 * tests.
 *
 * @category testing
 * @since 0.1.0
 */
export const TestSandbox = {
  make: makeTestSandbox
} as const
