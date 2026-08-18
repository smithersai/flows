import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import { Effect, Layer, Redacted, Result, Schema, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as Auth from "../src/Auth.ts"
import * as Endpoint from "../src/Endpoint.ts"
import * as Framing from "../src/Framing.ts"
import * as Model from "../src/Model.ts"
import { ModelError } from "../src/ModelError.ts"
import * as ModelEvent from "../src/ModelEvent.ts"
import * as ModelRequest from "../src/ModelRequest.ts"
import * as OpenAICompatible from "../src/OpenAICompatible.ts"
import * as Protocol from "../src/Protocol.ts"
import * as RequestExecutor from "../src/RequestExecutor.ts"
import * as Route from "../src/Route.ts"

const request = ModelRequest.ModelRequest.make({
  modelId: "test-model",
  system: [],
  messages: [],
  tools: [],
  params: ModelRequest.GenerationParams.make()
})

const endpoint = (options: Endpoint.MakeOptions): Endpoint.Endpoint => Result.getOrThrow(Endpoint.make(options))

const TestBody = Schema.Struct({
  z: Schema.Finite,
  a: Schema.Array(Schema.String)
})
const TestEvent = Schema.Record(Schema.String, Schema.Unknown)

const kernelHttpClientLayer = (
  client: HttpClient.HttpClient
): Layer.Layer<KernelHttpClient.HttpClient> => Layer.succeed(KernelHttpClient.HttpClient)(client)

const protocol = Protocol.make({
  id: "test",
  supportsDeferred: () => false,
  body: {
    schema: TestBody,
    from: () => Effect.succeed({ z: 1, a: ["body"] })
  },
  stream: {
    event: Schema.fromJsonString(TestEvent),
    initial: () => 0,
    step: (state) => Effect.succeed([state, []] as const),
    onHalt: () => []
  },
  classifyError: (status, body) => new ModelError({ code: "transport", message: `${status}: ${body}` })
})

describe("Route.prepare", () => {
  it("is deterministic and excludes credentials from the sealed-step view", async () => {
    const key = "test-secret-api-key"
    const route = Route.make({
      id: "test-route",
      protocol,
      endpoint: endpoint({ url: "https://example.test", path: "/v1/responses" }),
      auth: Auth.bearer(Redacted.make(key)),
      framing: Framing.sse,
      headers: { "x-public": "yes" }
    })

    const first = await Effect.runPromise(Route.prepare(route, request))
    const second = await Effect.runPromise(Route.prepare(route, request))

    expect(first.body).toEqual(second.body)
    expect(first.bodyText).toBe("{\"a\":[\"body\"],\"z\":1}")
    expect(first.publicHeaders).toEqual({ "content-type": "application/json", "x-public": "yes" })
    expect(JSON.stringify(first)).not.toContain(key)
    expect(JSON.stringify(new ModelError({ code: "transport", message: "safe" }))).not.toContain(key)
  })

  it("rejects credential-bearing headers before they can enter the prepared view", async () => {
    const route = Route.make({
      id: "unsafe",
      protocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("auth-secret")),
      framing: Framing.sse,
      headers: { "x-api-key": "step-key-secret" }
    })

    const error = await Effect.runPromise(Route.prepare(route, request).pipe(Effect.flip))
    expect(error).toMatchObject({ code: "invalid_request" })
    expect(JSON.stringify(error)).not.toContain("step-key-secret")
  })

  it("rejects password headers before they can enter the prepared view", async () => {
    const route = Route.make({
      id: "unsafe-password",
      protocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("auth-secret")),
      framing: Framing.sse,
      headers: { "x-password": "step-key-password" }
    })

    const error = await Effect.runPromise(Route.prepare(route, request).pipe(Effect.flip))
    expect(error).toMatchObject({ code: "invalid_request" })
    expect(JSON.stringify(error)).not.toContain("step-key-password")
  })

  it("rejects invalid request and protocol body values before canonical encoding", async () => {
    const invalidProtocol = Protocol.make({
      ...protocol,
      body: {
        schema: TestBody,
        from: () => Effect.succeed({ z: Number.NaN, a: ["body"] })
      }
    })
    const route = Route.make({
      id: "invalid-body",
      protocol: invalidProtocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("secret")),
      framing: Framing.sse
    })

    const invalidBody = await Effect.runPromise(Route.prepare(route, request).pipe(Effect.flip))
    expect(invalidBody).toMatchObject({ code: "invalid_request" })

    const invalidRequest = {
      ...request,
      params: { temperature: Number.NaN }
    } as unknown as ModelRequest.ModelRequest
    const invalidParams = await Effect.runPromise(
      Route.prepare(
        Result.getOrThrow(Route.openai({
          apiKey: Redacted.make("secret")
        })),
        invalidRequest
      ).pipe(Effect.flip)
    )
    expect(invalidParams).toMatchObject({ code: "invalid_request" })
  })

  it("keeps OpenAI-compatible routes on the portable protocol surface", async () => {
    const compatible = Result.getOrThrow(OpenAICompatible.make({
      id: "groq",
      baseUrl: "https://api.groq.com/openai",
      apiKey: Redacted.make("compatible-secret")
    }))

    expect(compatible.protocol.id).toBe("openai-responses")
    expect(compatible.protocol.supportsDeferred("gpt-5.4")).toBe(false)
    await expect(Route.prepare(compatible, request).pipe(Effect.runPromise)).resolves.toMatchObject({ routeId: "groq" })
  })

  it("wires route, auth, executor, framing, protocol, and settlement over a fake HTTP client", async () => {
    let sent: HttpClientRequest.HttpClientRequest | undefined
    const sse = [
      "event: response.output_text.delta",
      "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"delta\":\"wired\"}",
      "",
      "event: response.output_text.done",
      "data: {\"type\":\"response.output_text.done\",\"item_id\":\"msg_1\"}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}",
      "",
      ""
    ].join("\n")
    const client = HttpClient.make((httpRequest) =>
      Effect.sync(() => {
        sent = httpRequest
        return HttpClientResponse.fromWeb(
          httpRequest,
          new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
        )
      })
    )

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const model = yield* Model.Model
          return yield* model.stream(request).pipe(Stream.runCollect)
        }).pipe(
          Effect.provide(Route.layer(Result.getOrThrow(Route.openai({ apiKey: Redacted.make("openai-secret") })))),
          Effect.provide(RequestExecutor.layer),
          Effect.provide(kernelHttpClientLayer(client)),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(Array.from(events)).toEqual([
      { type: "text-start", id: "msg_1" },
      { type: "text-delta", id: "msg_1", text: "wired" },
      { type: "text-end", id: "msg_1" },
      {
        type: "settle",
        stopReason: "stop",
        responseId: "resp_1"
      }
    ])
    expect(sent?.headers.authorization).toBe("Bearer openai-secret")
    expect(sent?.body._tag).toBe("Uint8Array")
    const settled = ModelEvent.settledMessage(events)
    expect(settled.message).toMatchObject({
      responseId: "resp_1",
      content: [{ type: "text", text: "wired" }]
    })
    if (sent?.body._tag === "Uint8Array") {
      expect(new TextDecoder().decode(sent.body.body)).toContain("\"stream\":true")
    }
  })

  it("uses the route protocol classifier for HTTP failures", async () => {
    const classifiedProtocol = Protocol.make({
      ...protocol,
      classifyError: (status: number) =>
        new ModelError({
          code: "content_policy",
          message: "protocol-specific refusal",
          providerCode: "policy_violation",
          httpStatus: status
        })
    })
    const route = Route.make({
      id: "classified",
      protocol: classifiedProtocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("secret")),
      framing: Framing.sse
    })
    const client = HttpClient.make((httpRequest) =>
      Effect.succeed(HttpClientResponse.fromWeb(httpRequest, new Response("provider body", { status: 418 })))
    )

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const model = yield* Model.Model
          return yield* model.stream(request).pipe(Stream.runDrain, Effect.flip)
        }).pipe(
          Effect.provide(Route.layer(route)),
          Effect.provide(RequestExecutor.layer),
          Effect.provide(kernelHttpClientLayer(client)),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(error).toMatchObject({
      code: "content_policy",
      message: "protocol-specific refusal",
      providerCode: "policy_violation",
      httpStatus: 418
    })
  })

  it("keeps protocol parser failures in the typed stream error channel", async () => {
    const expected = new ModelError({
      code: "invalid_provider_output",
      message: "fixture parser failure"
    })
    const failingProtocol = Protocol.make({
      ...protocol,
      stream: {
        ...protocol.stream,
        step: () => Effect.fail(expected)
      }
    })
    const config = Route.make({
      id: "failing",
      protocol: failingProtocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("secret")),
      framing: Framing.sse
    })
    const executor = RequestExecutor.RequestExecutor.of({
      execute: (httpRequest) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            httpRequest,
            new Response("data: {}\n\n", {
              status: 200,
              headers: { "content-type": "text/event-stream" }
            })
          )
        )
    })
    const model = await Effect.runPromise(
      Route.toModel(config).pipe(Effect.provideService(RequestExecutor.RequestExecutor, executor))
    )
    const error = await Effect.runPromise(
      Effect.scoped(model.stream(request).pipe(Stream.runDrain, Effect.flip))
    )

    expect(error).toBe(expected)
  })
})
