import { describe, expect, it } from "vitest"
import { DefaultRule, expand, isDefaultRule, TypeId as DefaultRuleTypeId } from "../src/DefaultRule.ts"
import { GithubCiGen, type Attrs as GithubCiGenAttrs } from "../src/GithubCiGen.ts"
import * as Input from "../src/Input.ts"
import { PnpmWorkspace, type Attrs as PnpmWorkspaceAttrs } from "../src/PnpmWorkspace.ts"
import * as Rule from "../src/Rule.ts"

describe("Alchemy-style BUILD.ts constructors", () => {
  it("validates declared inputs at construction", () => {
    expect(() => Input.file("")).toThrow()
    expect(Input.file("package.json")).toEqual({ _tag: "File", path: "package.json" })
    expect(Input.glob("src/**/*.ts")).toEqual({
      _tag: "Glob",
      pattern: "src/**/*.ts",
      exclude: []
    })
    expect(Input.gitDiff("origin/main")).toEqual({ _tag: "GitDiff", base: "origin/main" })
  })

  it("constructs callable default rules and lifts directory strings", () => {
    const macro = () => ({})
    const declaration = DefaultRule({ directories: "packages/*", macro })

    expect(isDefaultRule(declaration)).toBe(true)
    expect(declaration.directories).toEqual({ _tag: "Glob", pattern: "packages/*", exclude: [] })
    expect(declaration.marker).toBe("package.json")
    expect(declaration.unless).toBe("BUILD.ts")
    expect(declaration.attrs).toEqual({})
  })

  it("rejects forged default rules and hostile macro results without invoking traps", () => {
    let invoked = false
    const proxy = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        invoked = true
        return undefined
      },
      has: () => {
        invoked = true
        return true
      }
    })
    expect(isDefaultRule(proxy)).toBe(false)
    expect(isDefaultRule({ [DefaultRuleTypeId]: DefaultRuleTypeId })).toBe(false)
    expect(invoked).toBe(false)

    const declaration = DefaultRule({
      directories: "packages/*",
      macro: () => proxy
    })
    expect(() => expand(declaration, "packages/a")).toThrow(/plain record/)
    expect(invoked).toBe(false)
  })

  it("applies the GitHub CI constructor defaults", () => {
    const attrs = Rule.metadata(GithubCiGen({ cacheUrlSecret: "TSFLOWS_CACHE_URL" })).attrs as GithubCiGenAttrs

    expect(attrs).toMatchObject({
      workflowName: "CI",
      pattern: "//...",
      kinds: ["build", "test", "lint"],
      pushBranches: ["main"],
      pullRequest: true,
      workflowDispatch: true,
      cacheUrlSecret: "TSFLOWS_CACHE_URL",
      cancelInProgress: true,
      jobs: [],
      gates: [],
      requiredJobs: [],
      output: ".github/workflows/ci.yml",
      mode: "contract"
    })
  })

  it("applies the pnpm workspace constructor defaults", () => {
    const attrs = Rule.metadata(PnpmWorkspace({ packageManager: "pnpm@11.21.0" })).attrs as PnpmWorkspaceAttrs

    expect(attrs.lockfile).toEqual(Input.file("pnpm-lock.yaml"))
    expect(attrs.workspaceFile).toEqual(Input.file("pnpm-workspace.yaml"))
    expect(attrs.packageJson).toEqual(Input.file("package.json"))
  })
})
