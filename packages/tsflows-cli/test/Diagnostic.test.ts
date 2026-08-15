import { describe, expect, it } from "vitest"
import * as Diagnostic from "../src/Diagnostic.ts"

describe("Diagnostic", () => {
  it("renders data without invoking accessors, proxies, or object conversion", () => {
    let calls = 0
    const getter = Object.defineProperty({}, "message", {
      get: () => {
        calls += 1
        return "getter message"
      }
    })
    const converted = {
      toString: () => {
        calls += 1
        return "converted message"
      }
    }
    const proxy = new Proxy(new Error("proxy message"), {
      getOwnPropertyDescriptor: (target, property) => {
        calls += 1
        return Reflect.getOwnPropertyDescriptor(target, property)
      }
    })

    expect(Diagnostic.message(getter, "fallback")).toBe("fallback")
    expect(Diagnostic.message(converted, "fallback")).toBe("fallback")
    expect(Diagnostic.message(proxy, "fallback")).toBe("fallback")
    expect(calls).toBe(0)
  })

  it("preserves a safe native Error and wraps every other rejection", () => {
    const native = new Error("native")
    expect(Diagnostic.error(native)).toBe(native)
    expect(Diagnostic.error("text").message).toBe("text")
    expect(Diagnostic.error({}).message).toBe("operation failed")
  })

  it("bounds and well-forms messages", () => {
    expect(Diagnostic.message("bad\ud800text")).toBe("bad\ufffdtext")
    expect(Diagnostic.message("x".repeat(Diagnostic.maximumMessageCodeUnits + 1))).toHaveLength(
      Diagnostic.maximumMessageCodeUnits
    )
  })
})
