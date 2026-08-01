import { describe, expect, it } from "vitest"
import * as Flows from "../src/index.ts"

describe("barrel", () => {
  it("re-exports every engine package as a namespace", () => {
    expect(Object.keys(Flows).sort()).toEqual([
      "Database",
      "Engine",
      "EngineStore",
      "Host",
      "Journal",
      "Kernel",
      "Keys",
      "Plugin",
      "Sync",
      "TimeTravel"
    ])
  })

  it.each(
    [
      ["Database", Flows.Database],
      ["Engine", Flows.Engine],
      ["EngineStore", Flows.EngineStore],
      ["Host", Flows.Host],
      ["Journal", Flows.Journal],
      ["Kernel", Flows.Kernel],
      ["Keys", Flows.Keys],
      ["Plugin", Flows.Plugin],
      ["Sync", Flows.Sync],
      ["TimeTravel", Flows.TimeTravel]
    ] as const
  )("%s namespace is populated", (_name, namespace) => {
    expect(Object.keys(namespace).length).toBeGreaterThan(0)
  })
})
