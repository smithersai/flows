import { Option } from "effect"
import { FastCheck } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Capability from "../src/Capability.ts"

const capability = (action: Capability.Action, resource: string): Capability.Capability =>
  Capability.make(action, resource)

const pattern = (action: Capability.PatternAction, resource: string): Capability.CapabilityPattern =>
  new Capability.CapabilityPattern({ action, resource })

describe("Capability", () => {
  it("formats and parses resources containing colons", () => {
    const value = capability("net:get", "example.test:8443/api:v1")
    expect(Capability.format(value)).toBe("net:get:example.test:8443/api:v1")
    expect(Option.getOrNull(Capability.parse(Capability.format(value)))).toEqual(value)
    expect(Option.isNone(Capability.parse("unknown:action:resource"))).toBe(true)
    expect(Option.isNone(Capability.parse("fs:read"))).toBe(true)
  })

  it("round trips formatted capabilities", () => {
    const action = FastCheck.constantFrom<Capability.Action>(
      "fs:read",
      "fs:write",
      "net:get",
      "net:post",
      "model:call",
      "proc:spawn",
      "jj:status",
      "jj:diff",
      "jj:snapshot",
      "jj:restore",
      "jj:workspace-add",
      "jj:workspace-forget"
    )
    FastCheck.assert(
      FastCheck.property(action, FastCheck.string(), (selectedAction, resource) => {
        const value = capability(selectedAction, resource)
        expect(Option.getOrNull(Capability.parse(Capability.format(value)))).toEqual(value)
      })
    )
  })

  it.each([
    [pattern("fs:read", "src/*.ts"), capability("fs:read", "src/Capability.ts"), true],
    [pattern("fs:read", "src/*.ts"), capability("fs:read", "src/nested/Capability.ts"), true],
    [pattern("fs:read", "src/?.ts"), capability("fs:read", "src/a.ts"), true],
    [pattern("fs:read", "src/?.ts"), capability("fs:read", "src/ab.ts"), false],
    [pattern("fs:read", "src/**/Capability.ts"), capability("fs:read", "src/nested/Capability.ts"), true],
    [pattern("fs:*", "C:/work/**"), capability("fs:write", "C:\\work\\nested\\a.ts"), true],
    [pattern("jj:*", "repository"), capability("jj:diff", "repository"), true],
    [pattern("model:*", "api.example.test/**"), capability("model:call", "api.example.test/large"), true],
    [pattern("*", "**"), capability("proc:spawn", "git status"), true],
    [pattern("proc:spawn", "npm *"), capability("proc:spawn", "npm"), true],
    [pattern("fs:read", "c:/work/**"), capability("fs:read", "C:\\WORK\\nested\\a.ts"), true],
    [pattern("net:*", "example.test"), capability("net:post", "other.test"), false]
  ])("matches %o against %o", (selectedPattern, selectedCapability, expected) => {
    expect(Capability.matches(selectedPattern, selectedCapability)).toBe(expected)
  })

  it.each([
    [pattern("fs:read", "src/a.ts"), pattern("fs:read", "src/a.ts"), true],
    [pattern("fs:*", "src/**"), pattern("fs:read", "src/nested/a.ts"), true],
    [pattern("*", "**"), pattern("jj:*", "repository"), true],
    [pattern("jj:*", "repository/**"), pattern("jj:diff", "repository/one"), true],
    [pattern("fs:read", "src/**"), pattern("fs:write", "src/a.ts"), false],
    [pattern("fs:read", "src/*"), pattern("fs:read", "src/a.ts"), false],
    [pattern("fs:read", "src/**"), pattern("fs:read", "source/a.ts"), false]
  ])("conservatively checks subsumption", (left, right, expected) => {
    expect(Capability.subsumes(left, right)).toBe(expected)
  })

  it.each([
    [capability("fs:read", "anything"), "sealed"],
    [capability("net:get", "example.test"), "sealed"],
    [capability("model:call", "api.example.test/large"), "sealed"],
    [capability("jj:status", "repository"), "sealed"],
    [capability("jj:diff", "repository"), "sealed"],
    [capability("fs:write", "src/a.ts"), "compensable"],
    [capability("fs:write", "/workspace/src/a.ts"), "compensable"],
    [capability("fs:write", "../escape"), "irreversible"],
    [capability("fs:write", "/outside/a.ts"), "irreversible"],
    [capability("jj:snapshot", "repository"), "compensable"],
    [capability("jj:restore", "repository"), "compensable"],
    [capability("jj:workspace-add", "repository"), "compensable"],
    [capability("jj:workspace-forget", "repository"), "compensable"],
    [capability("proc:spawn", "git status"), "irreversible"],
    [capability("net:post", "example.test"), "irreversible"]
  ])("classifies %o as %s", (value, expected) => {
    expect(Capability.tierOf(value, { workspaceRoot: "/workspace" })).toBe(expected)
  })

  it("requires idempotency keys only for irreversible effects", () => {
    expect(Capability.requiresIdempotencyKey("sealed")).toBe(false)
    expect(Capability.requiresIdempotencyKey("compensable")).toBe(false)
    expect(Capability.requiresIdempotencyKey("irreversible")).toBe(true)
  })

  it.each([
    ["C:/Work", "c:/work/src/a.ts"],
    ["C:/", "c:/src/a.ts"],
    ["c:\\", "C:\\src\\a.ts"]
  ])("classifies Windows writes inside workspace %s case-insensitively", (workspaceRoot, resource) => {
    expect(
      Capability.tierOf(capability("fs:write", resource), { workspaceRoot })
    ).toBe("compensable")
  })
})
