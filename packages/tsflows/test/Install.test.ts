import { NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Install from "../src/Install.ts"
import * as PackageManager from "../src/PackageManager.ts"

const platform = { os: "linux", arch: "x64", libc: null }

const withFixture = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "tsflows-install-")))
  try {
    await Fs.writeFile(NodePath.join(root, "package.json"), "{}\n", "utf8")
    await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8")
    return await use(root)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
}

const installEnvironment = async (root: string): Promise<Install.Environment> => ({
  manager: "pnpm",
  managerVersion: "10.10.0",
  platform,
  lockfile: {
    path: "pnpm-lock.yaml",
    digest: await Effect.runPromise(
      PackageManager.lockfileDigest(root, "pnpm-lock.yaml").pipe(Effect.provide(NodeServices.layer))
    )
  },
  npmrc: null
})

describe("Install", () => {
  it("always reconciles node_modules instead of trusting a freshness marker", async () => {
    await withFixture(async (root) => {
      await Fs.mkdir(NodePath.join(root, "node_modules"))
      await Fs.writeFile(
        NodePath.join(root, "node_modules/.flows-link.json"),
        JSON.stringify({ store: "0".repeat(64), manifest: "1".repeat(64), linked: false }),
        "utf8"
      )
      let fetches = 0
      let links = 0
      const evidence = await Effect.runPromise(
        PackageManager.packageJsonDigest(root).pipe(Effect.provide(NodeServices.layer))
      )
      const service: PackageManager.Service = {
        name: "pnpm",
        projectRoot: root,
        storeDirectory: ".flows/store/pnpm",
        lockfileName: "pnpm-lock.yaml",
        platformSensitive: true,
        platform,
        version: Effect.succeed("10.10.0"),
        fetch: Effect.sync(() => {
          fetches += 1
        }),
        link: Effect.sync(() => {
          links += 1
        }),
        linkManifest: Effect.succeed(evidence)
      }
      const environment = await installEnvironment(root)
      const store = await Effect.runPromise(
        PackageManager.storeManifest({
          manager: "pnpm",
          managerVersion: environment.managerVersion,
          platform,
          lockfileDigest: environment.lockfile.digest,
          npmrcDigest: null
        }).pipe(Effect.provide(NodeServices.layer))
      )

      const link = () =>
        Install.executeLink({ environment, store }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service)
        )
      const first = await Effect.runPromise(link())
      const second = await Effect.runPromise(link())
      expect(first.linked).toBe(true)
      expect(second.linked).toBe(true)
      expect(fetches).toBe(0)
      expect(links).toBe(2)
    })
  })

  it("refuses a manager version that changes between measurement and fetch", async () => {
    await withFixture(async (root) => {
      let fetched = false
      const evidence = await Effect.runPromise(
        PackageManager.packageJsonDigest(root).pipe(Effect.provide(NodeServices.layer))
      )
      const service: PackageManager.Service = {
        name: "pnpm",
        projectRoot: root,
        storeDirectory: ".flows/store/pnpm",
        lockfileName: "pnpm-lock.yaml",
        platformSensitive: true,
        platform,
        version: Effect.succeed("10.11.0"),
        fetch: Effect.sync(() => {
          fetched = true
        }),
        link: Effect.void,
        linkManifest: Effect.succeed(evidence)
      }
      const environment = await installEnvironment(root)

      await expect(Effect.runPromise(
        Install.executeFetch({ environment }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service)
        )
      )).rejects.toThrow(/measured install environment changed/)
      expect(fetched).toBe(false)
    })
  })
})
