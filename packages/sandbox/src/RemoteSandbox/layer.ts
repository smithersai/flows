/**
 * Adapts a remote sandbox provider to Effect's `ChildProcessSpawner`.
 *
 * Provider packages adapt their SDK sessions to `Provider`; this module owns
 * the conversion to Effect's `ChildProcessSpawner` contract and its
 * `PlatformError` surface, so a remote sandbox is the same service a local
 * process spawner is. Opening a provider is scoped, so interruption closes the
 * layer scope and runs the provider's cancellation finalizer. No `AbortSignal`
 * crosses this seam.
 *
 * @since 0.1.0
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import type { Provider, RemoteProcess } from "./Provider.ts"
import type { ProviderError, ProviderErrorCode } from "./ProviderError.ts"

const MODULE = "RemoteSandbox"

/** Provider codes map onto the normalized reasons `PlatformError` already has. */
const REASON: Record<ProviderErrorCode, PlatformError.SystemErrorTag> = {
  aborted: "Unknown",
  timeout: "TimedOut",
  unavailable: "NotFound",
  spawn_error: "Unknown",
  unknown: "Unknown"
}

const platformError = (method: string, command: string | undefined) =>
(
  error: ProviderError
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: REASON[error.code],
    module: MODULE,
    method,
    description: command === undefined ? error.message : `\`${command}\`: ${error.message}`,
    cause: error.cause
  })

const noStdin = (command: string): PlatformError.PlatformError =>
  PlatformError.badArgument({
    module: MODULE,
    method: "spawn",
    description: `remote sandboxes do not pipe stdin to \`${command}\``
  })

const noKill = (command: string): PlatformError.PlatformError =>
  PlatformError.badArgument({
    module: MODULE,
    method: "kill",
    description: `remote sandboxes end \`${command}\` by closing its scope, not by signal`
  })

let nextPid = 1

const handleOf = (command: string, process: RemoteProcess): ChildProcessHandle => {
  let running = true
  const stdout = Stream.mapError(process.stdout, platformError("stdout", command))
  const stderr = Stream.mapError(process.stderr, platformError("stderr", command))
  return makeHandle({
    pid: ProcessId(nextPid++),
    exitCode: process.exitCode.pipe(
      Effect.mapError(platformError("exitCode", command)),
      Effect.map((code) => {
        running = false
        return ExitCode(code)
      })
    ),
    isRunning: Effect.sync(() => running),
    kill: () => Effect.fail(noKill(command)),
    stdin: Sink.fail(noStdin(command)),
    stdout,
    stderr,
    all: Stream.merge(stdout, stderr),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void)
  })
}

/**
 * Adapts a configured provider to Effect's `ChildProcessSpawner`.
 *
 * Provider acquisition is tied to the layer scope. Interrupting an execution
 * or stream consumer closes that scope and therefore runs the finalizer
 * installed by `Provider.open`.
 *
 * The command reaches the provider as the same rendered line
 * `@smthrs/kernel/ChildProcessSpawner` writes as the `proc:spawn` capability
 * resource, so a grant and the thing it authorizes read the same.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (provider: Provider): Layer.Layer<ChildProcessSpawner> =>
  Layer.effect(
    ChildProcessSpawner,
    provider.open(provider.session).pipe(
      Effect.match({
        onFailure: (error) =>
          makeSpawner((command: ChildProcess.Command) =>
            Effect.fail(platformError("open", CommandLine.render(command))(error))
          ),
        onSuccess: () =>
          makeSpawner(
            Effect.fnUntraced(function*(command: ChildProcess.Command) {
              const rendered = CommandLine.render(command)
              const started = yield* provider.spawn(rendered, {
                cwd: CommandLine.cwd(command),
                env: CommandLine.env(command)
              }).pipe(Effect.mapError(platformError("spawn", rendered)))
              return handleOf(rendered, started)
            })
          )
      })
    )
  )
