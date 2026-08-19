import { Runtime as BuildRuntime } from "@smthrs/build"
import * as PackageManagerDeclaration from "@smthrs/targets/PackageManager"
import * as RuntimeDeclaration from "@smthrs/targets/Runtime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import {
  defaultToolchain,
  layerNonInteractiveNodeServices,
  layerRuntime,
  packageManagerEnvironment,
  runInstall,
  type Toolchain,
  toolchainOf
} from "../src/engine.ts"

describe("install engine boundary", () => {
  it("withholds default and workspace-declared cache credentials from package managers", () => {
    const environment = packageManagerEnvironment(
      {
        PATH: "/bin",
        SMITHERS_CACHE_URL: "https://cache.example.test",
        SMITHERS_CACHE_TOKEN: "default-secret",
        WORKSPACE_CACHE_SECRET: "custom-secret"
      },
      ["WORKSPACE_CACHE_SECRET"],
      false
    )

    expect(environment).toEqual({ PATH: "/bin" })
    expect(Object.isFrozen(environment)).toBe(true)
  })

  it("matches environment names case-insensitively on Windows", () => {
    const environment = packageManagerEnvironment(
      {
        Path: "C:\\Windows",
        smithers_cache_token: "secret",
        Custom_Token: "custom"
      },
      ["CUSTOM_TOKEN"],
      true
    )

    expect(environment).toEqual({ Path: "C:\\Windows" })
  })

  it("rejects malformed sensitive-name declarations", () => {
    expect(() => packageManagerEnvironment({}, ["BAD-NAME"])).toThrow("invalid environment name")
    expect(() => packageManagerEnvironment({}, Array.from({ length: 65 }, () => "TOKEN")))
      .toThrow("at most 64")
  })

  it("rejects hostile environment shapes without invoking accessors", () => {
    let reads = 0
    const source = Object.defineProperty({ PATH: "/bin" }, "SECRET", {
      enumerable: true,
      get: () => {
        reads += 1
        return "secret"
      }
    })
    expect(() => packageManagerEnvironment(source)).toThrow(/must be an enumerable data property/)
    expect(reads).toBe(0)
    expect(() => packageManagerEnvironment({ PATH: "/bin", Path: "/other" }, [], true)).toThrow(
      /repeats a case-insensitive name/
    )
    expect(() => packageManagerEnvironment({ TOKEN: 42 } as never)).toThrow(/string or undefined/)
  })

  it("snapshots the supplied environment", () => {
    const source = { PATH: "/first" }
    const environment = packageManagerEnvironment(source)
    source.PATH = "/second"
    expect(environment).toEqual({ PATH: "/first" })
  })

  it("refuses a cache directory that disagrees with the install Flow boundary", async () => {
    await expect(runInstall("/path/need/not/exist", { cacheDirectory: "custom-cache" }))
      .rejects.toThrow(/declared store boundary/)
  })

  it("validates install options before touching the workspace", async () => {
    let reads = 0
    const accessor = Object.defineProperty({}, "cacheDirectory", {
      enumerable: true,
      get: () => {
        reads += 1
        return ".flows"
      }
    })
    await expect(runInstall("/path/need/not/exist", accessor)).rejects.toThrow(/data property/)
    expect(reads).toBe(0)
    await expect(runInstall("/path/need/not/exist", { typo: true } as never)).rejects.toThrow(
      /unknown property/
    )
    await expect(runInstall("/path/need/not/exist", { signal: {} as AbortSignal })).rejects.toThrow(
      /must be an AbortSignal/
    )
  })
})

describe("the declared toolchain", () => {
  const declaredRuntime = RuntimeDeclaration.Node({ version: ">=22.19.0" })
  const declared = PackageManagerDeclaration.Toolchain.make({
    runtime: declaredRuntime,
    packageManager: PackageManagerDeclaration.Pnpm({ version: "11.21.0", runtime: declaredRuntime })
  })

  /** Verifies the host against the runtime layer `runInstall` composes. */
  const verifyRuntime = (toolchain: Toolchain): Promise<string> =>
    Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* BuildRuntime.Runtime
        return yield* runtime.verify
      }).pipe(
        Effect.provide(layerRuntime(toolchain).pipe(Layer.provideMerge(layerNonInteractiveNodeServices)))
      )
    )

  it("carries the registered declaration into the layer shape", () => {
    expect(toolchainOf(declared)).toEqual({
      manager: "pnpm",
      managerVersion: "11.21.0",
      managerExecutable: undefined,
      runtime: "node",
      runtimeVersion: ">=22.19.0",
      runtimeExecutable: undefined
    })
  })

  /**
   * The install verb runs a target no BUILD.ts file declares. Before the
   * registration reached it, it composed {@link defaultToolchain} and accepted
   * whatever interpreter the host had.
   */
  it("enforces the declared version requirement instead of >=0.0.0", async () => {
    expect(defaultToolchain.runtimeVersion).toBe(">=0.0.0")
    await expect(verifyRuntime(defaultToolchain)).resolves.toMatch(/^\d+\./)

    const unsatisfiable = toolchainOf(
      PackageManagerDeclaration.Toolchain.make({
        runtime: RuntimeDeclaration.Node({ version: ">=999.0.0" }),
        packageManager: PackageManagerDeclaration.Pnpm({
          version: "11.21.0",
          runtime: RuntimeDeclaration.Node({ version: ">=999.0.0" })
        })
      })
    )
    await expect(verifyRuntime(unsatisfiable)).rejects.toThrow(/the workspace declares >=999\.0\.0/)
  })

  it("refuses an install toolchain that is not a manager and a runtime", async () => {
    await expect(
      runInstall("/path/need/not/exist", { toolchain: { manager: "gradle" } as never })
    ).rejects.toThrow(/must declare a manager, a runtime, and a version for each/)
    await expect(
      runInstall("/path/need/not/exist", {
        toolchain: { ...toolchainOf(declared), runtimeVersion: 22 } as never
      })
    ).rejects.toThrow(/must declare a manager, a runtime, and a version for each/)
  })
})
