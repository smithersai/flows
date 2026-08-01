/**
 * Shared contract suite for complete Host bundles.
 *
 * This test-only source file is exported as `@smithers/host/test/contract`.
 * Keeping the suite on that explicit subpath lets sibling host packages reuse
 * it without adding Vitest to the production `@smithers/host` root barrel.
 *
 * @since 0.1.0
 */
import { Effect, Fiber, FileSystem, Layer, Path, Stream } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import type { JjErrorCode, PtyErrorCode, ShellErrorCode } from "../../src/HostError.ts"
import type { HttpTransport } from "../../src/HttpTransport.ts"
import * as HttpTransportService from "../../src/HttpTransport.ts"
import type { Jj } from "../../src/Jj.ts"
import * as JjService from "../../src/Jj.ts"
import type { Pty } from "../../src/Pty.ts"
import * as PtyService from "../../src/Pty.ts"
import type { Shell, ShellOptions } from "../../src/Shell.ts"
import * as ShellService from "../../src/Shell.ts"

/**
 * A capability that must fail with a stable typed code.
 *
 * @category models
 * @since 0.1.0
 */
export interface FailureCapability<Code extends string> {
  readonly expected: "failure"
  readonly code: Code
}

/**
 * Successful filesystem contract options.
 *
 * @category models
 * @since 0.1.0
 */
export interface FileSystemSuccess {
  readonly expected: "success"
  readonly scratchPath?: string | undefined
}

/**
 * Successful Path contract expectation.
 *
 * @category models
 * @since 0.1.0
 */
export interface PathSuccess {
  readonly expected: "success"
}

/**
 * Successful Shell contract options.
 *
 * Defaults are POSIX commands suitable for Node and Bun. In-process browser
 * doubles can provide their own scripted command names and expected output.
 *
 * @category models
 * @since 0.1.0
 */
export interface ShellSuccess {
  readonly expected: "success"
  readonly execCommand?: string | undefined
  readonly expectedStdout?: string | undefined
  readonly streamCommand?: string | undefined
  readonly expectedStreamText?: string | undefined
  readonly optionsCommand?: string | undefined
  readonly options?: ShellOptions | undefined
  readonly expectedOptionsStdout?: string | undefined
  readonly timeoutCommand?: string | undefined
  readonly interruptCommand?: string | undefined
}

/**
 * Successful Pty contract options.
 *
 * @category models
 * @since 0.1.0
 */
export interface PtySuccess {
  readonly expected: "success"
  readonly command?: string | undefined
  readonly expectedOutput?: string | undefined
}

/**
 * Successful Jj contract expectation.
 *
 * @category models
 * @since 0.1.0
 */
export interface JjSuccess {
  readonly expected: "success"
}

/**
 * Successful HTTP contract probe.
 *
 * A request is explicit so the shared suite never invents a live network call.
 *
 * @category models
 * @since 0.1.0
 */
export interface HttpTransportSuccess {
  readonly expected: "success"
  readonly request: HttpClientRequest.HttpClientRequest
  readonly assertResponse: (response: HttpClientResponse.HttpClientResponse) => void
}

/**
 * Complete capability expectations for the closed six-tag Host surface.
 * Unsupported capabilities are asserted with their code and are never skipped.
 *
 * @category models
 * @since 0.1.0
 */
export interface HostContractCapabilities {
  readonly fileSystem: FileSystemSuccess | FailureCapability<string>
  readonly path: PathSuccess | FailureCapability<string>
  readonly shell: ShellSuccess | FailureCapability<ShellErrorCode>
  readonly pty: PtySuccess | FailureCapability<PtyErrorCode>
  readonly jj: JjSuccess | FailureCapability<JjErrorCode>
  readonly httpTransport: HttpTransportSuccess | FailureCapability<string>
}

/**
 * The full layer output required by the contract.
 *
 * @category models
 * @since 0.1.0
 */
export type HostContractLayer = Layer.Layer<
  FileSystem.FileSystem | Path.Path | Shell | Pty | Jj | HttpTransport,
  unknown
>

/**
 * Normalizes the code a Host failure is identified by, across the three shapes
 * the closed surface produces: a `code` field (`ShellError`, `PtyError`,
 * `JjError`), a nested `reason._tag` (`PlatformError`, `HttpClientError`), and a
 * bare `_tag`. Anything else is uncoded.
 *
 * @category testing
 * @since 0.1.0
 */
export const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined
  if ("code" in error && typeof error.code === "string") return error.code
  if (
    "reason" in error &&
    typeof error.reason === "object" &&
    error.reason !== null &&
    "_tag" in error.reason &&
    typeof error.reason._tag === "string"
  ) {
    return error.reason._tag
  }
  if ("_tag" in error && typeof error._tag === "string") return error._tag
  return undefined
}

/**
 * Asserts that `effect` fails with `code`. Succeeding is itself a contract
 * violation: a capability declared unsupported must never quietly work.
 *
 * @category testing
 * @since 0.1.0
 */
export const assertFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  code: string
): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => {
        expect(errorCode(error)).toBe(code)
      },
      onSuccess: () => {
        throw new Error(`expected typed failure ${code}`)
      }
    })
  )

const provide = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: HostContractLayer
): Effect.Effect<A, E | unknown> => effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E | unknown>

const run = <A, E, R>(effect: Effect.Effect<A, E, R>, layer: HostContractLayer): Promise<A> =>
  Effect.runPromise(provide(effect, layer))

const unsupportedShell = (
  operation: "exec" | "stream" | "timeout" | "interruption",
  code: ShellErrorCode
) =>
  Effect.gen(function*() {
    const shell = yield* ShellService.Shell
    if (operation === "stream") {
      yield* assertFailure(shell.stream("host-contract-unsupported").pipe(Stream.runDrain), code)
      return
    }
    yield* assertFailure(
      shell.exec("host-contract-unsupported", operation === "timeout" ? { timeoutMs: 0 } : undefined),
      code
    )
  })

/**
 * Registers the shared Host contract with Vitest.
 *
 * Every invocation creates eleven cases: complete service presence,
 * FileSystem, Path, four Shell lifecycle cases, Pty cursor replay, Jj, and
 * HttpTransport.
 *
 * @category testing
 * @since 0.1.0
 */
export const runHostContract = (
  name: string,
  layer: HostContractLayer,
  caps: HostContractCapabilities
): void => {
  const fileSystemCap = caps.fileSystem
  const pathCap = caps.path
  const shellCap = caps.shell
  const ptyCap = caps.pty
  const jjCap = caps.jj
  const httpTransportCap = caps.httpTransport

  describe(`${name} Host contract`, () => {
    it("provides every tag in the closed Host service list", () =>
      run(
        Effect.gen(function*() {
          yield* FileSystem.FileSystem
          yield* Path.Path
          yield* ShellService.Shell
          yield* PtyService.Pty
          yield* JjService.Jj
          yield* HttpTransportService.HttpTransport
        }),
        layer
      ))

    it("declares FileSystem behavior", () =>
      run(
        fileSystemCap.expected === "failure"
          ? Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            yield* assertFailure(fs.readFile("/host-contract/unsupported"), fileSystemCap.code)
          })
          : Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const path = fileSystemCap.scratchPath ?? ".flows-host-contract"
            const bytes = new TextEncoder().encode("host-contract")
            yield* Effect.gen(function*() {
              yield* fs.writeFile(path, bytes)
              expect(new TextDecoder().decode(yield* fs.readFile(path))).toBe("host-contract")
            }).pipe(
              Effect.ensuring(fs.remove(path, { force: true }).pipe(Effect.catch(() => Effect.void)))
            )
          }),
        layer
      ))

    it("declares Path behavior", () =>
      run(
        pathCap.expected === "failure"
          ? Effect.gen(function*() {
            const path = yield* Path.Path
            yield* assertFailure(
              Effect.try({
                try: () => path.fromFileUrl(new URL("file:///host-contract/value")),
                catch: (error) => error
              }),
              pathCap.code
            )
          })
          : Effect.gen(function*() {
            const path = yield* Path.Path
            expect(path.normalize("/host-contract/./nested/../value")).toBe("/host-contract/value")
          }),
        layer
      ))

    it("declares Shell exec behavior", () =>
      run(
        shellCap.expected === "failure"
          ? unsupportedShell("exec", shellCap.code)
          : Effect.gen(function*() {
            const shell = yield* ShellService.Shell
            const result = yield* shell.exec(shellCap.execCommand ?? "printf host-contract")
            expect(result.exitCode).toBe(0)
            expect(result.stdout).toBe(shellCap.expectedStdout ?? "host-contract")
          }),
        layer
      ))

    it("declares Shell streaming behavior", () =>
      run(
        shellCap.expected === "failure"
          ? unsupportedShell("stream", shellCap.code)
          : Effect.gen(function*() {
            const shell = yield* ShellService.Shell
            const chunks = yield* shell.stream(
              shellCap.streamCommand ?? "printf host-contract-stream"
            ).pipe(Stream.runCollect)
            const output = Array.from(chunks, (chunk) => new TextDecoder().decode(chunk.chunk)).join("")
            expect(output).toContain(shellCap.expectedStreamText ?? "host-contract-stream")
          }),
        layer
      ))

    it("declares Shell cwd, env, and stdin option behavior", () =>
      run(
        shellCap.expected === "failure"
          ? unsupportedShell("exec", shellCap.code)
          : Effect.gen(function*() {
            const shell = yield* ShellService.Shell
            const result = yield* shell.exec(
              shellCap.optionsCommand ??
                "read host_contract_input; printf '%s:%s' \"$host_contract_input\" \"$HOST_CONTRACT_ENV\"",
              shellCap.options ?? {
                env: { HOST_CONTRACT_ENV: "env" },
                stdin: "stdin\n"
              }
            )
            expect(result.exitCode).toBe(0)
            expect(result.stdout).toBe(shellCap.expectedOptionsStdout ?? "stdin:env")
          }),
        layer
      ))

    it("declares Shell timeout behavior", () =>
      run(
        shellCap.expected === "failure"
          ? unsupportedShell("timeout", shellCap.code)
          : Effect.gen(function*() {
            const shell = yield* ShellService.Shell
            yield* assertFailure(
              shell.exec(shellCap.timeoutCommand ?? "sleep 1", { timeoutMs: 0 }),
              "timeout"
            )
          }),
        layer
      ))

    it("declares Shell interruption behavior", () =>
      run(
        shellCap.expected === "failure"
          ? unsupportedShell("interruption", shellCap.code)
          : Effect.gen(function*() {
            const shell = yield* ShellService.Shell
            const fiber = yield* shell.stream(
              shellCap.interruptCommand ?? "sleep 10"
            ).pipe(
              Stream.concat(Stream.never),
              Stream.runDrain,
              Effect.forkChild({ startImmediately: true })
            )
            yield* Effect.yieldNow
            yield* Fiber.interrupt(fiber)
          }),
        layer
      ))

    it("declares Pty cursor/replay behavior", () =>
      run(
        ptyCap.expected === "failure"
          ? Effect.gen(function*() {
            const pty = yield* PtyService.Pty
            yield* Effect.scoped(
              assertFailure(
                pty.spawn("host-contract-unsupported", { cols: 80, rows: 24 }),
                ptyCap.code
              )
            )
          })
          : Effect.scoped(
            Effect.gen(function*() {
              const pty = yield* PtyService.Pty
              const handle = yield* pty.spawn(
                ptyCap.command ?? "printf host-contract-pty",
                { cols: 80, rows: 24 }
              )
              yield* handle.resize(100, 30)
              expect(yield* handle.exitCode).toBe(0)
              const chunks = yield* handle.attach(5).pipe(Stream.runCollect)
              const output = Array.from(chunks, (chunk) => new TextDecoder().decode(chunk)).join("")
              expect(output).toContain(ptyCap.expectedOutput ?? "contract-pty")
            })
          ),
        layer
      ))

    it("declares Jj behavior", () =>
      run(
        jjCap.expected === "failure"
          ? Effect.gen(function*() {
            const jj = yield* JjService.Jj
            yield* assertFailure(jj.status(), jjCap.code)
          })
          : Effect.gen(function*() {
            const jj = yield* JjService.Jj
            expect(typeof (yield* jj.status())).toBe("string")
          }),
        layer
      ))

    it("declares HttpTransport behavior", () =>
      run(
        httpTransportCap.expected === "failure"
          ? Effect.gen(function*() {
            const transport = yield* HttpTransportService.HttpTransport
            yield* assertFailure(
              transport.execute(HttpClientRequest.get("http://127.0.0.1:1/host-contract")),
              httpTransportCap.code
            )
          })
          : Effect.gen(function*() {
            const transport = yield* HttpTransportService.HttpTransport
            httpTransportCap.assertResponse(
              yield* transport.execute(httpTransportCap.request)
            )
          }),
        layer
      ))
  })
}
