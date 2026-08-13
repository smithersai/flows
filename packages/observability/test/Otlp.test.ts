import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { describe, expect, it } from "vitest"
import { Otlp } from "../src/index.ts"

/** A `fetch` stand-in that records every export request and never networks. */
const recordingFetch = () => {
  const requests: Array<{ readonly url: string; readonly body: unknown }> = []
  const fetch: typeof globalThis.fetch = (input, init) => {
    const body = typeof init?.body === "string"
      ? init.body
      : new TextDecoder().decode(init?.body as Uint8Array)
    requests.push({ url: String(input), body: JSON.parse(body) })
    return Promise.resolve(new Response("{}", { status: 200 }))
  }
  return { requests, fetch }
}

/** Runs `effect` under the layer with a fresh registry and the recording fetch. */
const runExporting = <A>(
  effect: Effect.Effect<A>,
  layer: Layer.Layer<never>,
  fetch: typeof globalThis.fetch
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(Metric.MetricRegistry, new Map())
    )
  )

const resourceAttributes = (request: { readonly body: unknown }): Record<string, unknown> => {
  const body = request.body as {
    readonly resourceMetrics: ReadonlyArray<{
      readonly resource: { readonly attributes: ReadonlyArray<{ key: string; value: { stringValue: string } }> }
    }>
  }
  return Object.fromEntries(
    body.resourceMetrics[0]!.resource.attributes.map((attribute) => [attribute.key, attribute.value.stringValue])
  )
}

describe("Otlp", () => {
  it("exports registered metrics to the collector with flows resource defaults", async () => {
    const collector = recordingFetch()
    const counter = Metric.counter("observability_test_events")
    await runExporting(
      Metric.update(counter, 3),
      Otlp.layerFetch({ baseUrl: "http://collector.invalid:4318" }),
      collector.fetch
    )
    const exports = collector.requests.filter((request) => request.url.endsWith("/v1/metrics"))
    expect(exports.length).toBeGreaterThan(0)
    expect(JSON.stringify(exports[0]!.body)).toContain("observability_test_events")
    const attributes = resourceAttributes(exports[0]!)
    expect(attributes["service.name"]).toBe("flows")
    expect(attributes["service.version"]).toBe("0.1.0")
  })

  it("prefers the caller's service identity and resource attributes", async () => {
    const collector = recordingFetch()
    await runExporting(
      Metric.update(Metric.counter("observability_test_identity"), 1),
      Otlp.layerFetch({
        baseUrl: "http://collector.invalid:4318",
        serviceName: "my-harness",
        serviceVersion: "9.9.9",
        attributes: { "deployment.environment.name": "test" },
        exportInterval: "1 hour",
        shutdownTimeout: "1 second"
      }),
      collector.fetch
    )
    const exports = collector.requests.filter((request) => request.url.endsWith("/v1/metrics"))
    const attributes = resourceAttributes(exports[0]!)
    expect(attributes["service.name"]).toBe("my-harness")
    expect(attributes["service.version"]).toBe("9.9.9")
    expect(attributes["deployment.environment.name"]).toBe("test")
  })

  it("posts every signal below the configured base URL", async () => {
    const collector = recordingFetch()
    await runExporting(
      Effect.log("an exported line"),
      Otlp.layerFetch({ baseUrl: "http://collector.invalid:4318/nested" }),
      collector.fetch
    )
    for (const request of collector.requests) {
      expect(request.url).toMatch(/^http:\/\/collector\.invalid:4318\/nested\/v1\/(logs|metrics|traces)$/)
    }
    expect(collector.requests.some((request) => request.url.endsWith("/v1/logs"))).toBe(true)
  })

  it("layerNoop provides nothing and exports nothing", async () => {
    const collector = recordingFetch()
    await runExporting(Metric.update(Metric.counter("observability_test_noop"), 1), Otlp.layerNoop, collector.fetch)
    expect(collector.requests).toEqual([])
  })
})
