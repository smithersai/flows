import * as Capability from "@smthrs/capability-next/Capability"
import * as Permission from "@smthrs/capability-next/Permission"
import * as KernelHttpClient from "@smthrs/kernel-next/HttpClient"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Random from "effect/Random"
import type * as Scope from "effect/Scope"
import * as TestClock from "effect/testing/TestClock"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as Request from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import { ModelError } from "../src/ModelError.js"
import * as RequestExecutor from "../src/RequestExecutor.js"

interface ResponseSpec {
  readonly status: number
  readonly body: string
  readonly headers?: Readonly<Record<string, string>> | undefined
}

const response = (
  request: HttpClientRequest.HttpClientRequest,
  spec: ResponseSpec
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(spec.body, {
      status: spec.status,
      ...(spec.headers !== undefined ? { headers: spec.headers } : {})
    })
  )

const executorLayer = (
  specs: ReadonlyArray<ResponseSpec>,
  requests: Array<HttpClientRequest.HttpClientRequest>
): Layer.Layer<RequestExecutor.RequestExecutor> => {
  let cursor = 0
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request)
      const spec = specs[Math.min(cursor, specs.length - 1)]
      cursor += 1
      if (spec === undefined) throw new Error("A fake response is required")
      return response(request, spec)
    })
  )
  return RequestExecutor.layer.pipe(
    Layer.provide(Layer.succeed(KernelHttpClient.HttpClient)(client))
  )
}

const execute = (
  executor: RequestExecutor.RequestExecutor,
  request: HttpClientRequest.HttpClientRequest,
  options: Omit<RequestExecutor.ExecuteOptions, "modelId"> = {}
) => executor.execute(request, { modelId: "test-model", ...options })

const run = <A, E>(
  effect: Effect.Effect<A, E, RequestExecutor.RequestExecutor | Scope.Scope>,
  layer: Layer.Layer<RequestExecutor.RequestExecutor>
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
      )
    )
  )

const request = (
  url = "https://provider.test/v1/models",
  body = "{}",
  headers: Headers.Input = {}
): HttpClientRequest.HttpClientRequest =>
  Request.post(url, { headers }).pipe(
    Request.bodyText(body, "application/json")
  )

const expectModelError = (value: unknown): ModelError => {
  expect(value).toBeInstanceOf(ModelError)
  if (!(value instanceof ModelError)) throw new Error("Expected ModelError")
  return value
}

const bodyBytes = (value: HttpClientRequest.HttpClientRequest): ReadonlyArray<number> =>
  value.body._tag === "Uint8Array" ? Array.from(value.body.body) : []

describe("RequestExecutor", () => {
  it("retries a generic 429 exactly twice and preserves Retry-After metadata", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer(
      Array.from({ length: 3 }, () => ({
        status: 429,
        body: "{\"error\":{\"message\":\"rate limited\"}}",
        headers: { "retry-after": "2" }
      })),
      requests
    )

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const executor = yield* RequestExecutor.RequestExecutor
          const fiber = yield* execute(executor, request()).pipe(Effect.flip, Effect.forkChild)

          yield* Effect.yieldNow
          expect(requests).toHaveLength(1)
          yield* TestClock.adjust(2_000)
          expect(requests).toHaveLength(2)
          yield* TestClock.adjust(2_000)

          return yield* Fiber.join(fiber)
        }).pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    const modelError = expectModelError(error)
    expect(requests).toHaveLength(3)
    expect(modelError).toMatchObject({
      code: "rate_limited",
      retryAfterMillis: 2_000,
      resetAtEpochMillis: 6_000,
      resetSource: "retry-after",
      httpStatus: 429
    })
  })

  it("does not retry a 400 response", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([
      { status: 400, body: "{\"error\":{\"message\":\"invalid parameter\"}}" },
      { status: 200, body: "unexpected" }
    ], requests)

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(executor, request()).pipe(Effect.flip)
      }),
      layer
    )

    expect(expectModelError(error).code).toBe("invalid_request")
    expect(requests).toHaveLength(1)
  })

  it("retries 503 responses with exponential TestClock-controlled backoff", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([
      { status: 503, body: "busy" },
      { status: 503, body: "still busy" },
      { status: 200, body: "ok" }
    ], requests)

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const executor = yield* RequestExecutor.RequestExecutor
          const fiber = yield* execute(executor, request()).pipe(Effect.forkChild)

          yield* Effect.yieldNow
          expect(requests).toHaveLength(1)
          yield* TestClock.adjust(500)
          expect(requests).toHaveLength(2)
          yield* TestClock.adjust(1_000)

          return yield* Fiber.join(fiber)
        }).pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(Random.Random, {
            nextDoubleUnsafe: () => 0.5,
            nextIntUnsafe: () => 0
          }),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(result.status).toBe(200)
    expect(requests).toHaveLength(3)
  })

  it("classifies explicit quota before retry and retains its reset", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([
      {
        status: 429,
        body: "{\"error\":{\"code\":\"insufficient_quota\",\"message\":\"billing quota exhausted\"}}",
        headers: {
          "x-ratelimit-reset-requests": "1m",
          "x-request-id": "req_quota"
        }
      },
      { status: 200, body: "unexpected" }
    ], requests)

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* TestClock.setTime(10_000)
          const executor = yield* RequestExecutor.RequestExecutor
          return yield* execute(executor, request()).pipe(Effect.flip)
        }).pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(expectModelError(error)).toMatchObject({
      code: "quota_exceeded",
      providerCode: "insufficient_quota",
      requestId: "req_quota",
      resetAtEpochMillis: 70_000,
      resetSource: "x-ratelimit-reset-requests",
      httpStatus: 429
    })
    expect(requests).toHaveLength(1)
  })

  it("does not classify quota-like prose without an explicit provider code", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer(
      Array.from({ length: 3 }, () => ({
        status: 429,
        body: "{\"error\":{\"message\":\"billing quota exhausted\"}}",
        headers: { "retry-after-ms": "0" }
      })),
      requests
    )

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(executor, request()).pipe(Effect.flip)
      }),
      layer
    )

    expect(expectModelError(error).code).toBe("rate_limited")
    expect(requests).toHaveLength(3)
  })

  it("reuses byte-identical method, URL, headers, and body", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([
      { status: 503, body: "busy", headers: { "retry-after-ms": "0" } },
      { status: 503, body: "busy", headers: { "retry-after-ms": "0" } },
      { status: 503, body: "busy", headers: { "retry-after-ms": "0" } }
    ], requests)
    const original = request(
      "https://provider.test/v1/models?debug=1",
      "{\"model\":\"test\"}",
      { authorization: "Bearer test-secret", "x-public": "same" }
    )

    await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        yield* execute(executor, original).pipe(Effect.flip)
      }),
      layer
    )

    expect(requests).toHaveLength(3)
    const signatures = requests.map((value) => ({
      method: value.method,
      url: value.url,
      urlParams: value.urlParams.params,
      headers: Object.entries(value.headers),
      body: bodyBytes(value)
    }))
    expect(signatures[1]).toEqual(signatures[0])
    expect(signatures[2]).toEqual(signatures[0])
  })

  it("parses an HTTP-date Retry-After against the Effect Clock", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const now = 1_700_000_000_000
    const reset = now + 2_000
    const layer = executorLayer([
      {
        status: 429,
        body: "rate limited",
        headers: { "retry-after": new Date(reset).toUTCString() }
      },
      { status: 200, body: "ok" }
    ], requests)

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* TestClock.setTime(now)
          const executor = yield* RequestExecutor.RequestExecutor
          const fiber = yield* execute(executor, request()).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(1_999)
          expect(requests).toHaveLength(1)
          yield* TestClock.adjust(1)
          return yield* Fiber.join(fiber)
        }).pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(result.status).toBe(200)
    expect(requests).toHaveLength(2)
  })

  it("normalizes Anthropic and OpenAI reset headers to absolute instants", async () => {
    const now = 1_700_000_000_000

    const openAiRequests: Array<HttpClientRequest.HttpClientRequest> = []
    const openAiLayer = executorLayer([{
      status: 400,
      body: "bad",
      headers: { "x-ratelimit-reset-tokens": "10s" }
    }], openAiRequests)
    const openAiError = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* TestClock.setTime(now)
          const executor = yield* RequestExecutor.RequestExecutor
          return yield* execute(executor, request()).pipe(Effect.flip)
        }).pipe(
          Effect.provide(openAiLayer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )
    expect(expectModelError(openAiError)).toMatchObject({
      resetAtEpochMillis: now + 10_000,
      resetSource: "x-ratelimit-reset-tokens"
    })

    const anthropicRequests: Array<HttpClientRequest.HttpClientRequest> = []
    const anthropicReset = now + 30_000
    const anthropicLayer = executorLayer([{
      status: 400,
      body: "bad",
      headers: {
        "anthropic-ratelimit-requests-reset": new Date(anthropicReset).toISOString()
      }
    }], anthropicRequests)
    const anthropicError = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* TestClock.setTime(now)
          const executor = yield* RequestExecutor.RequestExecutor
          return yield* execute(executor, request()).pipe(Effect.flip)
        }).pipe(
          Effect.provide(anthropicLayer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )
    expect(expectModelError(anthropicError)).toMatchObject({
      resetAtEpochMillis: anthropicReset,
      resetSource: "anthropic-ratelimit-requests-reset"
    })
  })

  it("selects only the exhausted resource window", async () => {
    const now = 1_700_000_000_000
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([{
      status: 400,
      body: "bad",
      headers: {
        "x-ratelimit-remaining-tokens": "100",
        "x-ratelimit-reset-tokens": "1s",
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "1m"
      }
    }], requests)

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* TestClock.setTime(now)
          const executor = yield* RequestExecutor.RequestExecutor
          return yield* execute(executor, request()).pipe(Effect.flip)
        }).pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(expectModelError(error)).toMatchObject({
      resetAtEpochMillis: now + 60_000,
      resetSource: "x-ratelimit-reset-requests"
    })
  })

  it("prefers Retry-After over resource reset windows", async () => {
    const now = 1_700_000_000_000
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([{
      status: 400,
      body: "bad",
      headers: {
        "retry-after": "30",
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "1m"
      }
    }], requests)

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* TestClock.setTime(now)
          const executor = yield* RequestExecutor.RequestExecutor
          return yield* execute(executor, request()).pipe(Effect.flip)
        }).pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(expectModelError(error)).toMatchObject({
      retryAfterMillis: 30_000,
      resetAtEpochMillis: now + 30_000,
      resetSource: "retry-after"
    })
  })

  it("normalizes an explicit provider-body reset field", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const resetAtEpochMillis = 1_700_000_060_000
    const layer = executorLayer([{
      status: 400,
      body: `{"error":{"message":"bad","reset_at":${resetAtEpochMillis / 1_000}}}`
    }], requests)

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(executor, request()).pipe(Effect.flip)
      }),
      layer
    )

    expect(expectModelError(error)).toMatchObject({
      resetAtEpochMillis,
      resetSource: "body.error.reset_at"
    })
  })

  it("retains provider request IDs", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([{
      status: 400,
      body: "bad",
      headers: { "x-amzn-requestid": "amazon-request-123" }
    }], requests)

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(executor, request()).pipe(Effect.flip)
      }),
      layer
    )

    expect(expectModelError(error).requestId).toBe("amazon-request-123")
  })

  it("redacts before capping oversized provider diagnostics", async () => {
    const secret = "credential-before-cap"
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([{
      status: 400,
      body: `${secret}${"x".repeat(20_000)}`
    }], requests)

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(
          executor,
          request("https://provider.test/v1/models", "{}", { authorization: `Bearer ${secret}` })
        ).pipe(Effect.flip)
      }),
      layer
    )

    const serialized = JSON.stringify(expectModelError(error))
    expect(serialized).not.toContain(secret)
    expect(serialized.length).toBeLessThan(16_384)
  })

  it("never serializes header, query, JSON-body, or echoed credential bytes", async () => {
    const headerSecret = "header-secret-123"
    const querySecret = "query-secret-456"
    const bodySecret = "body-secret-789"
    const responseSecret = "response-secret-012"
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([{
      status: 400,
      body: JSON.stringify({
        error: {
          message: `echoed ${headerSecret} ${querySecret} ${bodySecret}`,
          api_key: responseSecret
        }
      })
    }], requests)

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        const credentialRequest = request(
          `https://provider.test/v1/models?key=${querySecret}`,
          JSON.stringify({ api_key: bodySecret, model: "safe" }),
          { authorization: `Bearer ${headerSecret}` }
        )
        return yield* execute(executor, credentialRequest).pipe(Effect.flip)
      }),
      layer
    )

    const serialized = JSON.stringify(expectModelError(error))
    for (const secret of [headerSecret, querySecret, bodySecret, responseSecret]) {
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain(encodeURIComponent(secret))
    }
    expect(serialized).toContain("<redacted>")
  })

  it("classifies network failures as transport errors with a redacted URL", async () => {
    const secret = "transport-query-secret"
    const cause = Object.assign(new Error(`socket closed for ${secret}`), {
      name: "SocketError",
      code: "ECONNRESET"
    })
    const client = HttpClient.make((failedRequest) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request: failedRequest,
            description: `provider echoed ${secret}`,
            cause
          })
        })
      )
    )
    const layer = RequestExecutor.layer.pipe(
      Layer.provide(Layer.succeed(KernelHttpClient.HttpClient)(client))
    )

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(
          executor,
          request(`https://provider.test/v1/models?key=${secret}`)
        ).pipe(Effect.flip)
      }),
      layer
    )

    const modelError = expectModelError(error)
    expect(modelError.code).toBe("transport")
    expect(JSON.stringify(modelError)).not.toContain(secret)
    expect(modelError.message).toContain("%3Credacted%3E")
    expect(modelError.message).toContain("SocketError [ECONNRESET] socket closed")
  })

  it("preserves a typed kernel denial without converting it to ModelError", async () => {
    // The kernel projects a permission failure into the error channel Effect's
    // `HttpClient` tag fixes, keeping the structured failure on the cause.
    const deniedClient = HttpClient.make((request) =>
      Effect.fail(
        KernelHttpClient.toHttpClientError({
          request,
          error: new Permission.PermissionDenied({
            capability: Capability.make("model:call", "provider.test/test-model"),
            reason: "denied by policy"
          })
        })
      )
    )
    const layer = RequestExecutor.layer.pipe(
      Layer.provide(Layer.succeed(KernelHttpClient.HttpClient)(deniedClient))
    )

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(executor, request()).pipe(Effect.flip)
      }),
      layer
    )

    expect(error).toBeInstanceOf(Permission.PermissionDenied)
    expect(error).toMatchObject({
      code: "permission_denied",
      capability: Capability.make("model:call", "provider.test/test-model"),
      reason: "denied by policy"
    })
  })

  it("preserves the complete typed permission suspension request", async () => {
    const required = new Permission.PermissionRequired({
      requestId: "permission-model-1",
      runId: "run-7",
      capability: Capability.make("model:call", "provider.test/test-model"),
      tier: "sealed",
      meta: { provider: "provider.test", attempt: 1 }
    })
    const permissionClient = HttpClient.make((request) =>
      Effect.fail(KernelHttpClient.toHttpClientError({ request, error: required }))
    )
    const layer = RequestExecutor.layer.pipe(
      Layer.provide(Layer.succeed(KernelHttpClient.HttpClient)(permissionClient))
    )

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(executor, request()).pipe(Effect.flip)
      }),
      layer
    )

    expect(error).toBe(required)
    expect(error).toMatchObject({
      code: "permission_required",
      requestId: "permission-model-1",
      runId: "run-7",
      capability: Capability.make("model:call", "provider.test/test-model"),
      tier: "sealed",
      meta: { provider: "provider.test", attempt: 1 }
    })
  })

  it("retries transport failures with bounded backoff", async () => {
    let attempts = 0
    const original = request()
    const client = HttpClient.make((attemptedRequest) =>
      Effect.sync(() => {
        attempts += 1
        return attempts
      }).pipe(
        Effect.flatMap((attempt) =>
          attempt < 3
            ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request: attemptedRequest,
                  description: "temporary network failure"
                })
              })
            )
            : Effect.succeed(response(attemptedRequest, { status: 200, body: "ok" }))
        )
      )
    )
    const layer = RequestExecutor.layer.pipe(
      Layer.provide(Layer.succeed(KernelHttpClient.HttpClient)(client))
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const executor = yield* RequestExecutor.RequestExecutor
          const fiber = yield* execute(executor, original).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          expect(attempts).toBe(1)
          yield* TestClock.adjust(500)
          expect(attempts).toBe(2)
          yield* TestClock.adjust(1_000)
          return yield* Fiber.join(fiber)
        }).pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(Random.Random, {
            nextDoubleUnsafe: () => 0.5,
            nextIntUnsafe: () => 0
          }),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(result.status).toBe(200)
    expect(attempts).toBe(3)
  })

  it("redacts password credentials in headers, query, request bodies, and echoed diagnostics", async () => {
    const headerPassword = "header-password"
    const queryPassword = "query-password"
    const bodyPassword = "body-password"
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([{
      status: 400,
      body: JSON.stringify({
        error: {
          message: `${headerPassword} ${queryPassword} ${bodyPassword}`,
          password: "response-password"
        }
      })
    }], requests)

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(
          executor,
          request(
            `https://provider.test/v1/models?password=${queryPassword}`,
            JSON.stringify({ password: bodyPassword }),
            { "x-password": headerPassword }
          )
        ).pipe(Effect.flip)
      }),
      layer
    )

    const serialized = JSON.stringify(expectModelError(error))
    for (const password of [headerPassword, queryPassword, bodyPassword, "response-password"]) {
      expect(serialized).not.toContain(password)
    }
  })

  it("propagates interruption of an in-flight execute", async () => {
    let started = false
    const client = HttpClient.make(() =>
      Effect.sync(() => {
        started = true
      }).pipe(Effect.andThen(Effect.never))
    )
    const layer = RequestExecutor.layer.pipe(
      Layer.provide(Layer.succeed(KernelHttpClient.HttpClient)(client))
    )

    const interrupted = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const executor = yield* RequestExecutor.RequestExecutor
          const fiber = yield* execute(executor, request()).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          expect(started).toBe(true)
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        }).pipe(
          Effect.provide(layer),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(Exit.hasInterrupts(interrupted)).toBe(true)
  })
})
