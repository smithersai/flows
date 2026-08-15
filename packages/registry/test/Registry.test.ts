import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem, Layer, Option } from "effect"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  BodyRefMarkdown,
  FlowDescriptor,
  Provenance,
  SchemaRefMarkdownArgs,
  SchemaRefMarkdownOutput,
  type Source,
  SourceScan
} from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Registry from "../src/Registry.ts"
import type { DiscoveryError, RegistryError } from "../src/RegistryError.ts"
import { discoveryError } from "../src/RegistryError.ts"

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url))
const projectRoot = `${fixtures}/project/flows`
const foreignRoot = `${fixtures}/foreign`

const project: Source = {
  source: "project",
  root: projectRoot,
  naming: "path"
}

const foreign: Source = {
  source: "foreign",
  root: foreignRoot,
  naming: "frontmatter"
}

const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const provideRegistry = <A, E>(
  effect: Effect.Effect<A, E, Registry.Registry>,
  sources: ReadonlyArray<Source> = [project, foreign]
): Effect.Effect<A, E | DiscoveryError | RegistryError> =>
  effect.pipe(
    Effect.provide(Registry.layer({ sources })),
    Effect.provide(Discovery.layer),
    Effect.provide(platformLayer)
  )

describe("Registry", () => {
  it("merges sources in order, warns on duplicates, and keeps first provenance", async () => {
    const result = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const entries = yield* registry.list()
          const warnings = yield* registry.warnings()
          return { entries, warnings }
        })
      )
    )

    const review = result.entries.find((entry) => entry.name === "review")
    expect(review?.provenance).toEqual(new Provenance({ source: "project", root: projectRoot }))
    expect(
      result.warnings.some((warning) => warning.code === "duplicate_name" && warning.name === "review")
    ).toBe(true)
  })

  it("loads an unmodified third-party skill through progressive disclosure", async () => {
    const result = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const entries = yield* registry.list()
          const descriptor = yield* registry.get("pdf-processing")
          const body = yield* registry.loadBody("pdf-processing")
          const rendered = yield* registry.runPrompt("pdf-processing", { args: "Extract report.pdf" })
          return { entries, descriptor, body, rendered }
        })
      )
    )

    expect(result.entries.map((entry) => entry.name)).toContain("pdf-processing")
    expect(result.descriptor.name).toBe("pdf-processing")
    expect(result.descriptor.output._tag).toBe("MarkdownOutput")
    expect(result.body._tag).toBe("Prompt")
    expect(result.rendered).toContain("Do not overwrite the source document")
    expect(result.rendered).toContain(`- Base directory: ${foreignRoot}/pdf`)
    expect(result.rendered.endsWith("\n\nExtract report.pdf")).toBe(true)
    if (result.body._tag === "Prompt") {
      expect(result.body.text).toContain("# PDF Processing")
      expect(result.body.text).not.toContain("name: pdf-processing")
      expect(result.body.text.startsWith("---")).toBe(false)
      expect(result.body.baseDirectory).toBe(`${foreignRoot}/pdf`)
    }
  })

  it("keeps hidden entries lookup- and body-loadable while excluding them from visible", async () => {
    const result = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const visible = yield* registry.visible()
          const hidden = yield* registry.get("hidden")
          const body = yield* registry.loadBody("hidden")
          return { visible, hidden, body }
        })
      )
    )

    expect(result.visible.map((entry) => entry.name)).not.toContain("hidden")
    expect(result.hidden.name).toBe("hidden")
    expect(result.body._tag).toBe("Prompt")
  })

  it("rejects module flows at the markdown prompt boundary", async () => {
    const error = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          return yield* Effect.flip(registry.runPrompt("review/read-pr", { args: "4821" }))
        })
      )
    )

    expect(error.code).toBe("not_prompt_flow")
  })

  it("fails unknown lookup with not_found", async () => {
    const error = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          return yield* Effect.flip(registry.get("does-not-exist"))
        })
      )
    )

    expect(error.code).toBe("not_found")
  })

  it("fails construction when either colliding source is system", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return yield* registry.list()
      }).pipe(
        Effect.provide(Registry.layer({ sources: [{ ...project, system: true }, foreign] })),
        Effect.provide(Discovery.layer),
        Effect.provide(platformLayer),
        Effect.flip
      )
    )

    expect(error.code).toBe("system_collision")
  })

  it("defers body reads until loadBody and returns a typed read failure", async () => {
    const descriptor = new FlowDescriptor({
      name: "lazy",
      description: "Loads only when requested.",
      body: new BodyRefMarkdown({
        path: `${fixtures}/does-not-exist.md`,
        baseDirectory: fixtures
      }),
      input: new SchemaRefMarkdownArgs({}),
      output: new SchemaRefMarkdownOutput({}),
      model: Option.none(),
      flows: [],
      capabilities: [],
      effects: {
        reads: [],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      placement: Option.none(),
      modelInvocable: true,
      path: `${fixtures}/does-not-exist.md`,
      frontmatter: {},
      provenance: new Provenance({ source: "test", root: fixtures })
    })
    const registryLayer = Registry.layerFromDescriptors([descriptor]).pipe(Layer.provide(platformLayer))

    const entries = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return yield* registry.list()
      }).pipe(Effect.provide(registryLayer))
    )
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return yield* Effect.flip(registry.loadBody("lazy"))
      }).pipe(Effect.provide(registryLayer))
    )

    expect(entries.map((entry) => entry.name)).toEqual(["lazy"])
    expect(error.code).toBe("body_unavailable")
    expect(error.cause).toMatchObject({ _tag: "PlatformError" })
  })

  it("refreshes all sources atomically for same-session rediscovery", async () => {
    const before = new FlowDescriptor({
      name: "before",
      description: "Present before refresh.",
      body: new BodyRefMarkdown({
        path: `${fixtures}/before.md`,
        baseDirectory: fixtures
      }),
      input: new SchemaRefMarkdownArgs({}),
      output: new SchemaRefMarkdownOutput({}),
      model: Option.none(),
      flows: [],
      capabilities: [],
      effects: {
        reads: [],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      placement: Option.none(),
      modelInvocable: true,
      path: `${fixtures}/before.md`,
      frontmatter: {},
      provenance: new Provenance({ source: "test", root: fixtures })
    })
    const after = new FlowDescriptor({
      name: "after",
      description: "Present after refresh.",
      body: new BodyRefMarkdown({
        path: `${fixtures}/after.md`,
        baseDirectory: fixtures
      }),
      input: new SchemaRefMarkdownArgs({}),
      output: new SchemaRefMarkdownOutput({}),
      model: Option.none(),
      flows: [],
      capabilities: [],
      effects: {
        reads: [],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      placement: Option.none(),
      modelInvocable: true,
      path: `${fixtures}/after.md`,
      frontmatter: {},
      provenance: new Provenance({ source: "test", root: fixtures })
    })
    let scans = 0
    const discovery = Discovery.makeNoop({
      scan: () => {
        scans++
        return scans <= 2
          ? Effect.succeed(new SourceScan({ entries: scans === 1 ? [before] : [after], warnings: [] }))
          : Effect.fail(discoveryError({ code: "read_failed", method: "scan" }))
      }
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        const initial = yield* registry.list()
        yield* registry.refresh()
        const refreshed = yield* registry.list()
        const refreshError = yield* Effect.flip(registry.refresh())
        const preserved = yield* registry.list()
        return { initial, refreshed, refreshError, preserved }
      }).pipe(
        Effect.provide(Registry.layer({ sources: [{ source: "test", root: fixtures, naming: "path" }] })),
        Effect.provide(Layer.succeed(Discovery.Discovery)(discovery)),
        Effect.provide(platformLayer)
      )
    )

    expect(result.initial.map((entry) => entry.name)).toEqual(["before"])
    expect(result.refreshed.map((entry) => entry.name)).toEqual(["after"])
    expect(result.refreshError.code).toBe("read_failed")
    expect(result.preserved.map((entry) => entry.name)).toEqual(["after"])
  })

  it("preserves lenient discovery warnings without logging or throwing", async () => {
    const warnings = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          return yield* registry.warnings()
        })
      )
    )

    expect(
      warnings.some(
        (warning) => warning.code === "missing_description" && warning.path.endsWith("/broken/flow.mdx")
      )
    ).toBe(true)
  })
})
