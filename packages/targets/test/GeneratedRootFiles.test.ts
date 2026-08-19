import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Install from "../src/Install.ts"
import * as Lockfile from "../src/Lockfile.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as PnpmWorkspaceFile from "../src/PnpmWorkspaceFile.ts"
import * as Target from "../src/Target.ts"
import * as Tsconfig from "../src/Tsconfig.ts"
import { runtime, withPackageManager } from "./toolchain.ts"

const workspaceRoot = NodePath.resolve(import.meta.dirname, "../../..")

describe("Tsconfig", () => {
  it("renders only the sections a declaration fills", () => {
    expect(Tsconfig.render(Tsconfig.Attrs.make({}))).toBe("{}\n")
  })

  it("renders each section in the documented order", () => {
    const rendered = Tsconfig.render(Tsconfig.Attrs.make({
      extends: { _tag: "File", path: "tsconfig.base.json" },
      compilerOptions: { noEmit: true, module: "NodeNext" },
      include: ["src/**/*"],
      exclude: ["**/dist/**"],
      references: ["../plan"]
    }))
    expect(rendered).toBe(`{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "module": "NodeNext"
  },
  "include": [
    "src/**/*"
  ],
  "exclude": [
    "**/dist/**"
  ],
  "references": [
    {
      "path": "../plan"
    }
  ]
}
`)
  })

  it("gives a bare extends path the relative prefix the compiler needs", () => {
    const relative = (path: string) =>
      JSON.parse(Tsconfig.render(Tsconfig.Attrs.make({ extends: { _tag: "File", path } })))["extends"]
    expect(relative("tsconfig.base.json")).toBe("./tsconfig.base.json")
    expect(relative("//tsconfig.base.json")).toBe("./tsconfig.base.json")
    expect(relative("./already.json")).toBe("./already.json")
    expect(relative("../sibling.json")).toBe("../sibling.json")
  })

  it("refuses compiler options that are not plain JSON", () => {
    expect(() =>
      Tsconfig.render(Tsconfig.Attrs.make({
        compilerOptions: { paths: new Proxy({}, {}) } as never
      }))
    ).toThrow()
  })

  it("checks by default and writes only through the write half", () => {
    expect(Target.metadata(Tsconfig.Tsconfig({})).attrs).toMatchObject({ path: "tsconfig.json" })
    expect(Target.metadata(Tsconfig.TsconfigWrite({})).outputs)
      .toEqual({ cwd: ".", paths: ["tsconfig.json"] })
    expect(Target.metadata(Tsconfig.Tsconfig({})).outputs).toBeUndefined()
    expect(Target.metadata(Tsconfig.Tsconfig({})).cacheable).toBe(true)
    expect(Target.metadata(Tsconfig.TsconfigWrite({})).cacheable).toBe(false)
  })

  it("splits the non-writing and writing halves across verbs", () => {
    expect(Target.metadata(Tsconfig.Tsconfig({})).kinds).toEqual(["lint"])
    expect(Target.metadata(Tsconfig.TsconfigWrite({})).kinds).toEqual(["run"])
  })
})

describe("PnpmWorkspace", () => {
  it("renders packages, sorted allowBuilds, and the link policy", () => {
    const rendered = PnpmWorkspaceFile.render(PnpmWorkspaceFile.Attrs.make({
      packages: ["packages/*", "apps/*"],
      allowBuilds: { sharp: false, esbuild: false },
      linkWorkspacePackages: true
    }))
    expect(rendered).toBe(`packages:
  - "packages/*"
  - "apps/*"

allowBuilds:
  esbuild: false
  sharp: false

linkWorkspacePackages: true
`)
  })

  it("sorts allowBuilds so reordering a literal is not drift", () => {
    const one = PnpmWorkspaceFile.render(PnpmWorkspaceFile.Attrs.make({
      packages: ["packages/*"],
      allowBuilds: { a: true, z: false }
    }))
    const other = PnpmWorkspaceFile.render(PnpmWorkspaceFile.Attrs.make({
      packages: ["packages/*"],
      allowBuilds: { z: false, a: true }
    }))
    expect(one).toBe(other)
  })

  it("quotes a mapping key YAML would otherwise read as another type", () => {
    const rendered = PnpmWorkspaceFile.render(PnpmWorkspaceFile.Attrs.make({
      packages: ["plain"],
      allowBuilds: { "@scope/name": false, no: true, "1.0": true, "with space": false, "es5-ext": true }
    }))
    // Sequence entries are always quoted; mapping keys only when YAML needs it.
    expect(rendered).toContain("  - \"plain\"\n")
    expect(rendered).toContain("  es5-ext: true\n")
    expect(rendered).toContain("  \"@scope/name\": false\n")
    expect(rendered).toContain("  \"no\": true\n")
    expect(rendered).toContain("  \"1.0\": true\n")
    expect(rendered).toContain("  \"with space\": false\n")
  })

  it("omits allowBuilds entirely when nothing is declared", () => {
    const rendered = PnpmWorkspaceFile.render(PnpmWorkspaceFile.Attrs.make({
      packages: ["packages/*"]
    }))
    expect(rendered).not.toContain("allowBuilds")
  })

  it("refuses a workspace whose registered manager does not write this file", () => {
    const npm = PackageManager.Npm({ version: "10.9.0", runtime })
    expect(() => withPackageManager(npm, () => PnpmWorkspaceFile.PnpmWorkspace({ packages: ["packages/*"] })))
      .toThrow(/requires the pnpm declaration; this workspace declares npm/)
  })
})

describe("Lockfile", () => {
  it("resolves without linking and declares the manager's lockfile as its output", () => {
    const metadata = Target.metadata(Lockfile.Lockfile({}))
    expect(metadata.outputs).toEqual({ cwd: ".", paths: ["pnpm-lock.yaml"] })
    expect(metadata.kinds).toEqual(["build"])
  })

  it("is never cacheable, because resolution reaches the network", () => {
    expect(Target.metadata(Lockfile.Lockfile({})).cacheable).toBe(false)
  })

  it("declares every package manifest it resolves from", () => {
    const metadata = Target.metadata(Lockfile.Lockfile({}))
    expect(metadata.inputs).toEqual([
      { _tag: "Glob", pattern: "packages/*/package.json", exclude: [] }
    ])
  })

  it("writes the lockfile the registered manager writes", () => {
    const npm = PackageManager.Npm({ version: "10.9.0", runtime })
    expect(withPackageManager(npm, () => Target.metadata(Lockfile.Lockfile({})).outputs))
      .toEqual({ cwd: ".", paths: ["package-lock.json"] })
  })
})

describe("Install", () => {
  it("is a run target that never caches its own result", () => {
    const metadata = Target.metadata(Install.Install({}))
    expect(metadata.kinds).toEqual(["run"])
    expect(metadata.cacheable).toBe(false)
  })

  it("takes the lockfile as a dependency edge and its content as key material", () => {
    const lockfile = Lockfile.Lockfile({})
    const metadata = Target.metadata(Install.Install({ lockfile }))
    expect(metadata.dependencies).toHaveLength(1)
    expect(metadata.inputs.map((input) => (input as { readonly path: string }).path))
      .toEqual(["pnpm-lock.yaml", ".npmrc", "package.json"])
  })

  it("defaults every generated-file dependency to absent", () => {
    const attrs = Target.metadata(Install.Install({})).attrs as Install.Attrs
    expect(attrs.lockfile).toBe(null)
    expect(attrs.manifest).toBe(null)
    expect(attrs.workspace).toBe(null)
    expect(Target.metadata(Install.Install({})).dependencies).toEqual([])
  })
})

describe("the checked-in root files match what BUILD.ts declares", () => {
  // These are the drift checks `smthrs lint` runs. Keeping them here means a
  // change to a generator, or a hand edit to a generated file, fails in this
  // package's own suite rather than only in a workspace-wide run.
  it("renders the checked-in pnpm-workspace.yaml", async () => {
    const declared = PnpmWorkspaceFile.render(PnpmWorkspaceFile.Attrs.make({
      packages: ["packages/*", "packages/build/infra", "examples", "apps/*"],
      allowBuilds: {
        "@journeyapps/wa-sqlite": false,
        dprint: false,
        "es5-ext": false,
        esbuild: false,
        "msgpackr-extract": false,
        playwright: false,
        sharp: false,
        "unrs-resolver": false,
        "vue-demi": false,
        workerd: false
      },
      linkWorkspacePackages: true,
      settings: { verifyDepsBeforeRun: false }
    }))
    const actual = await Fs.readFile(NodePath.join(workspaceRoot, "pnpm-workspace.yaml"), "utf8")
    expect(declared).toBe(actual)
  })

  it("renders the checked-in tsconfig.json", async () => {
    const declared = Tsconfig.render(Tsconfig.Attrs.make({
      extends: { _tag: "File", path: "tsconfig.base.json" },
      compilerOptions: {
        noEmit: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        paths: { "*": ["./*"] }
      },
      include: [
        "packages/*/src/**/*",
        "packages/*/test/**/*",
        "packages/storage/*/src/**/*",
        "packages/storage/*/test/**/*",
        "packages/coding-agent/examples/**/*"
      ],
      exclude: ["**/dist/**", "packages/coding-agent/examples/extensions/gondolin/**"]
    }))
    const actual = await Fs.readFile(NodePath.join(workspaceRoot, "tsconfig.json"), "utf8")
    expect(declared).toBe(actual)
  })
})
