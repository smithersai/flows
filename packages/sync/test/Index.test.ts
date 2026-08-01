/**
 * The package barrel. Every consumer imports through it, so its namespace
 * re-exports are part of the public contract: a renamed or dropped module here
 * breaks callers without any single module's own tests noticing.
 */
import { describe, expect, it } from "vitest"
import * as Sync from "../src/index.ts"

describe("@smithers/sync barrel", () => {
  it("re-exports every module as its own namespace", () => {
    expect(Object.keys(Sync).sort()).toEqual([
      "RunCatalog",
      "SyncClient",
      "SyncError",
      "SyncProtocol",
      "SyncRpcs",
      "SyncServer"
    ])
  })

  it("re-exports the same module objects the deep imports resolve to", async () => {
    expect(Sync.SyncError).toBe(await import("../src/SyncError.ts"))
    expect(Sync.SyncProtocol).toBe(await import("../src/SyncProtocol.ts"))
    expect(Sync.SyncRpcs).toBe(await import("../src/SyncRpcs.ts"))
    expect(Sync.RunCatalog).toBe(await import("../src/RunCatalog.ts"))
    expect(Sync.SyncServer).toBe(await import("../src/SyncServer.ts"))
    expect(Sync.SyncClient).toBe(await import("../src/SyncClient.ts"))
  })

  it("keeps the service namespaces' constructor conventions distinct", () => {
    expect(typeof Sync.SyncServer.make).toBe("function")
    expect(typeof Sync.SyncServer.makeNoop).toBe("function")
    expect(typeof Sync.SyncClient.makeNoop).toBe("function")
    expect(typeof Sync.RunCatalog.make).toBe("function")
    expect(Sync.SyncServer.makeNoop).not.toBe(Sync.SyncClient.makeNoop)
  })

  it("exposes the tagged error classes with their canonical tags", () => {
    expect(new Sync.SyncError.SyncError({ code: "unknown", message: "x" })._tag).toBe(
      "flows/sync/SyncError"
    )
    expect(
      new Sync.SyncError.SyncGapError({ runId: "run" as never, expectedFrom: 1, receivedFrom: 3 } as never)._tag
    ).toBe("flows/sync/SyncGapError")
  })
})
