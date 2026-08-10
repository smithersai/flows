/**
 * Run the same host program against two adapters.
 *
 * The host surface is a closed set of service tags: `FileSystem`, `Path`,
 * `Shell`, `Pty`, `Jj`, and a one-hop `HttpTransport`. A program written
 * against the tags runs on any bundle that provides them. This example runs
 * one program twice:
 *
 * `TestHost.layer` supplies an in-memory filesystem and a scripted shell, so
 * the assertions are deterministic and nothing touches the machine.
 *
 * `NodeHost.layer` supplies the real Node adapters, so the same `Shell.exec`
 * call spawns a real process.
 *
 * Browser and Bun bundles implement the same tags and live at
 * `@smthrs/host/browser/BrowserHost` and `@smthrs/host/bun/BunHost`.
 */
import { Shell } from "@smthrs/host"
import * as NodeHost from "@smthrs/host/node/NodeHost"
import * as TestHost from "@smthrs/host/test/TestHost"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"

export interface Summary {
  readonly scriptedRead: string
  readonly scriptedExec: string
  readonly nodeExec: string
}

/** The adapter-neutral program: read a file, then run a command. */
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const shell = yield* Shell.Shell
  const bytes = yield* fs.readFile("/workspace/input.txt")
  const executed = yield* shell.exec("read-input")
  return { read: new TextDecoder().decode(bytes), executed: executed.stdout.trim() }
})

export const main: Effect.Effect<Summary> = Effect.gen(function*() {
  const scripted = yield* program.pipe(
    Effect.provide(
      TestHost.layer({
        files: { "/workspace/input.txt": "hello from memory" },
        commands: { "read-input": { stdout: "hello from script\n", exitCode: 0 } }
      })
    )
  )

  const node = yield* Effect.gen(function*() {
    const shell = yield* Shell.Shell
    const result = yield* shell.exec("printf 'hello from node'")
    return result.stdout
  }).pipe(Effect.provide(NodeHost.layer))

  return {
    scriptedRead: scripted.read,
    scriptedExec: scripted.executed,
    nodeExec: node
  }
}).pipe(Effect.orDie)
