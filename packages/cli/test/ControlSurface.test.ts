import { NodeServices } from "@effect/platform-node"
import { Control as ControlService } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { TestConsole } from "effect/testing"
import { Command } from "effect/unstable/cli"
import { HttpServer } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { cli } from "../src/Command.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"

interface Invocation {
  readonly value: unknown
  readonly exitCode: number
}

const runCommand = Command.runWith(cli, { version: "0.0.0" })

const invoke = Effect.fnUntraced(function*(args: ReadonlyArray<string>) {
  const before = (yield* TestConsole.logLines).length
  const exit = yield* Effect.exit(runCommand(args))
  if (Exit.isFailure(exit)) {
    return yield* Effect.fail(Cause.squash(exit.cause))
  }

  const lines = yield* TestConsole.logLines
  const text = lines.slice(before).map(String).join("\n")
  if (text.length === 0) {
    return yield* Effect.fail(new Error(`command produced no output: ${args.join(" ")}`))
  }
  const value = yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new Error(`command produced invalid JSON: ${String(cause)}`)
  })
  return { value, exitCode: Output.exitCode(value) } satisfies Invocation
})

const scenario = Effect.gen(function*() {
  const plan = yield* invoke(["--json", "plan", "system/test"])

  const card = plan.value as {
    readonly approval: unknown
  }
  const approval = yield* Effect.try({
    try: () => {
      if (
        card.approval === null ||
        typeof card.approval !== "object" ||
        !("target" in card.approval) ||
        !("idempotencyKey" in card.approval)
      ) {
        throw new Error("plan did not emit the complete approval payload")
      }
      return JSON.stringify(card.approval)
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause))
  })
  const parked = yield* invoke(["--json", "run", approval])
  const approve = yield* invoke(["--json", "approve", approval, "--scope", "run"])
  const run = yield* invoke(["--json", "run", approval])

  return { plan, parked, approve, run }
})

const scenarioServices = Layer.merge(TestConsole.layer, Output.layer)

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "createdAt" && key !== "updatedAt" && key !== "stampedAt")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)])
    )
  }
  return value
}

const isWaitingForApproval = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  (
    (value as { readonly _tag?: unknown })._tag === "Parked" ||
    (value as { readonly status?: unknown }).status === "waiting-approval"
  )

const addressUrl = (server: HttpServer.HttpServer["Service"]): string => {
  const address = server.address
  if (address._tag !== "TcpAddress") throw new Error("expected a TCP control server")
  return `http://127.0.0.1:${address.port}`
}

const testControl = TestControl.layer({ now: () => 0 })
const websocketEvent = {
  sequence: 1,
  kind: "control.websocket.connected",
  occurredAt: 0,
  payload: null
}
const streamingControl = Layer.effect(
  ControlService.Control,
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    return ControlService.make({
      ...control,
      watch: () => Stream.succeed(websocketEvent)
    })
  })
).pipe(Layer.provide(testControl))

describe("Control surface", () => {
  it("mounts the remote parser path on a real ephemeral Node server", async () => {
    const local = await Effect.runPromise(
      invoke(["--json", "plan", "system/test"]).pipe(
        Effect.provide(testControl),
        Effect.provide(scenarioServices),
        Effect.provide(NodeServices.layer)
      )
    )
    const remote = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        return yield* invoke(["--json", "plan", "system/test"]).pipe(
          Effect.provide(NodeControl.layerControl({ remote: addressUrl(server) })),
          Effect.provide(scenarioServices)
        )
      }).pipe(
        Effect.provide(
          NodeControl.layerServerNoopAuth({ host: "127.0.0.1", port: 0 }).pipe(
            Layer.provide(testControl)
          )
        ),
        Effect.scoped
      )
    )

    expect(normalize(remote)).toEqual(normalize(local))
  })

  it("keeps local and remote plan, approve, and run behavior equivalent", async () => {
    const local = await Effect.runPromise(
      scenario.pipe(
        Effect.provide(testControl),
        Effect.provide(scenarioServices),
        Effect.provide(NodeServices.layer)
      )
    )

    const remote = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        return yield* scenario.pipe(
          Effect.provide(NodeControl.layerControl({ remote: addressUrl(server) })),
          Effect.provide(scenarioServices)
        )
      }).pipe(
        Effect.provide(
          NodeControl.layerServerNoopAuth({ host: "127.0.0.1", port: 0 }).pipe(
            Layer.provide(testControl)
          )
        ),
        Effect.scoped
      )
    )

    expect(isWaitingForApproval(local.parked.value)).toBe(true)
    expect(isWaitingForApproval(remote.parked.value)).toBe(true)
    expect(local.parked.exitCode).toBe(3)
    expect(remote.parked.exitCode).toBe(3)
    expect(normalize(remote)).toEqual(normalize(local))
  })

  it("uses WebSocket for the remote watch projection", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        return yield* Effect.gen(function*() {
          const control = yield* ControlService.Control
          return yield* control.watch({}).pipe(Stream.runHead)
        }).pipe(
          Effect.provide(NodeControl.layerControl({ remote: addressUrl(server) }))
        )
      }).pipe(
        Effect.provide(
          NodeControl.layerServerNoopAuth({ host: "127.0.0.1", port: 0 }).pipe(
            Layer.provide(streamingControl)
          )
        ),
        Effect.scoped
      )
    )

    expect(events._tag).toBe("Some")
    if (events._tag === "Some") {
      expect(events.value).toEqual(websocketEvent)
    }
  })
})
