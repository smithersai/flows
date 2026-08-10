// Deep reviewed and polished by a human on 2026-08-10.

import { Effect, Exit, FileSystem, Layer, Option, Path, Schema, Scope } from "effect"
import { Etag, HttpPlatform } from "effect/unstable/http"
import { HttpApi, HttpApiTest } from "effect/unstable/httpapi"
import { RpcTest } from "effect/unstable/rpc"
import { describe, expect, it } from "vitest"
import { DurableDeferred, Flow, FlowEngine, FlowProxy, FlowProxyServer } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Scope.Scope>) =>
  it(name, () => runPromise(Effect.scoped(body())))

const Echo = Flow.make("Proxy/Echo", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  error: Schema.Literal("invalid"),
  idempotencyKey: ({ value }) => String(value)
})

const Gate = DurableDeferred.make("Proxy/Gate", { success: Schema.Number })

const Suspends = Flow.make("Proxy/Suspends", {
  payload: { id: Schema.String },
  success: Schema.Number,
  idempotencyKey: ({ id }) => id
})

const flows = [Echo, Suspends] as const

const makeLayer = (echo: (value: number) => Effect.Effect<number, "invalid">) => {
  let calls = 0
  const counted = (value: number) =>
    Effect.suspend(() => {
      calls++
      return echo(value)
    })
  const layer = Layer.mergeAll(
    Echo.toLayer(({ value }) => counted(value)),
    Suspends.toLayer(() => DurableDeferred.await(Gate))
  ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
  return { layer, calls: () => calls }
}

describe("FlowProxyServer.layerRpcHandlers", () => {
  effect("dispatches execute requests to the registered flow", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      const result = yield* client["Proxy/Echo"]({
        payload: { value: 41 },
        executionId: "echo-1"
      })
      expect(result).toBe(42)
      expect(calls()).toBe(1)
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer)))
    )
  })

  effect("deduplicates repeated execute requests for one execution id", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      const first = yield* client["Proxy/Echo"]({ payload: { value: 1 }, executionId: "dedupe" })
      const second = yield* client["Proxy/Echo"]({ payload: { value: 1 }, executionId: "dedupe" })
      expect([first, second]).toEqual([2, 2])
      // the second request replays the completed execution instead of re-running it
      expect(calls()).toBe(1)
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer)))
    )
  })

  effect("concurrent execute requests share a single execution", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value * 2))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      const call = client["Proxy/Echo"]({ payload: { value: 5 }, executionId: "concurrent" })
      const results = yield* Effect.all([call, call, call], { concurrency: "unbounded" })
      expect(results).toEqual([10, 10, 10])
      expect(calls()).toBe(1)
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer)))
    )
  })

  effect("surfaces flow failures as typed rpc errors", () => {
    const { layer } = makeLayer(() => Effect.fail("invalid" as const))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      const exit = yield* Effect.exit(
        client["Proxy/Echo"]({ payload: { value: 7 }, executionId: "failing" })
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain("invalid")
      }
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer)))
    )
  })

  effect("discard starts the flow without awaiting it, and resume drives it forward", () => {
    const { layer } = makeLayer((value) => Effect.succeed(value))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      yield* client["Proxy/SuspendsDiscard"]({
        payload: { id: "resume-me" },
        executionId: "resume-me"
      })
      yield* Effect.yieldNow
      const suspended = yield* Suspends.poll("resume-me")
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")

      // resume is a no-op while the deferred is unresolved
      yield* client["Proxy/SuspendsResume"]({ executionId: "resume-me" })
      yield* Effect.yieldNow
      const stillSuspended = yield* Suspends.poll("resume-me")
      expect(Option.isSome(stillSuspended) && stillSuspended.value._tag).toBe("Suspended")

      const token = DurableDeferred.tokenFromExecutionId(Gate, {
        flow: Suspends,
        executionId: "resume-me"
      })
      yield* DurableDeferred.succeed(Gate, { token, value: 9 })
      yield* client["Proxy/SuspendsResume"]({ executionId: "resume-me" })
      let result = yield* Suspends.poll("resume-me")
      for (let i = 0; i < 20 && (Option.isNone(result) || result.value._tag !== "Complete"); i++) {
        yield* Effect.yieldNow
        result = yield* Suspends.poll("resume-me")
      }
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe(9)
      }
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provideMerge(layer)))
    )
  })

  effect("serves prefixed rpc tags when a prefix is configured", () => {
    const { layer } = makeLayer((value) => Effect.succeed(value + 100))
    const group = FlowProxy.toRpcGroup(flows, { prefix: "v1/" })
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(group)
      const result = yield* client["v1/Proxy/Echo"]({
        payload: { value: 1 },
        executionId: "prefixed"
      })
      expect(result).toBe(101)
    }).pipe(
      Effect.provide(
        FlowProxyServer.layerRpcHandlers(flows, { prefix: "v1/" }).pipe(Layer.provide(layer))
      )
    )
  })
})

const HttpTestServices = Layer.mergeAll(
  Path.layer,
  Etag.layerWeak,
  HttpPlatform.layer
).pipe(Layer.provideMerge(FileSystem.layerNoop({})))

class ProxyApi extends HttpApi.make("proxy").add(
  FlowProxy.toHttpApiGroup("flows", flows)
) {}

describe("FlowProxyServer.layerHttpApi", () => {
  const client = HttpApiTest.groups(ProxyApi, ["flows"])

  const provide =
    (layer: Layer.Layer<any, never, never>) => <A, E>(self: Effect.Effect<A, E, any>): Effect.Effect<A, E, never> =>
      self.pipe(
        Effect.provide(
          FlowProxyServer.layerHttpApi(ProxyApi, "flows", flows).pipe(
            Layer.provideMerge(layer)
          )
        ),
        Effect.provide(HttpTestServices)
      ) as Effect.Effect<A, E, never>

  effect("routes the execute endpoint to the flow handler", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
    return Effect.gen(function*() {
      const api = yield* client
      const result = yield* api.flows["Proxy/Echo"]({
        payload: { payload: { value: 1 }, executionId: "http-execute" }
      })
      expect(result).toBe(2)
      expect(calls()).toBe(1)
    }).pipe(provide(layer))
  })

  effect("returns the declared error from the execute endpoint", () => {
    const { layer } = makeLayer(() => Effect.fail("invalid" as const))
    return Effect.gen(function*() {
      const api = yield* client
      const exit = yield* Effect.exit(
        api.flows["Proxy/Echo"]({
          payload: { payload: { value: 2 }, executionId: "http-error" }
        })
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain("invalid")
      }
    }).pipe(provide(layer))
  })

  effect("discard and resume endpoints drive a suspended execution", () => {
    const { layer } = makeLayer((value) => Effect.succeed(value))
    return Effect.gen(function*() {
      const api = yield* client
      yield* api.flows["Proxy/SuspendsDiscard"]({
        payload: { payload: { id: "http-resume" }, executionId: "http-resume" }
      })
      yield* Effect.yieldNow
      const suspended = yield* Suspends.poll("http-resume")
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")

      const token = DurableDeferred.tokenFromExecutionId(Gate, {
        flow: Suspends,
        executionId: "http-resume"
      })
      yield* DurableDeferred.succeed(Gate, { token, value: 3 })
      yield* api.flows["Proxy/SuspendsResume"]({ payload: { executionId: "http-resume" } })
      let result = yield* Suspends.poll("http-resume")
      for (let i = 0; i < 20 && (Option.isNone(result) || result.value._tag !== "Complete"); i++) {
        yield* Effect.yieldNow
        result = yield* Suspends.poll("http-resume")
      }
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe(3)
      }
    }).pipe(provide(layer))
  })
})
