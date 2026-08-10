/**
 * Constructs deterministic remote sandbox providers for tests.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { Provider } from "./Provider.ts"
import type { ProviderError } from "./ProviderError.ts"
import type { TestSandboxProvider } from "./TestSandboxProvider.ts"
import type { TestSandboxState } from "./TestSandboxState.ts"
import type { TestScript } from "./TestScript.ts"

const encoder = new TextEncoder()

const scriptedOutput = (text: string | undefined): Stream.Stream<Uint8Array, ProviderError> =>
  text === undefined || text === "" ? Stream.empty : Stream.fromArray([encoder.encode(text)])

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
    options.scripts?.[command] ?? { stderr: `command not found: ${command}\n`, exitCode: 127 }

  const provider: TestSandboxProvider = {
    state,
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
    spawn: Effect.fnUntraced(function*(command: string) {
      state.commands.push(command)
      const current = script(command)
      if (current.failure !== undefined) return yield* Effect.fail(current.failure)
      return current.pending === true
        ? { stdout: Stream.never, stderr: Stream.never, exitCode: Effect.never }
        : {
          stdout: scriptedOutput(current.stdout),
          stderr: scriptedOutput(current.stderr),
          exitCode: Effect.succeed(current.exitCode ?? 0)
        }
    })
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
