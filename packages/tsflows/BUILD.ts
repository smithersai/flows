/**
 * The tsflows workspace root.
 *
 * Two inert declarations and one run target:
 *
 * - `template` is the inert shared manifest every package merges under.
 * - `packageDefaults` synthesizes a standard package's targets, and its
 *   manifest targets, for any `packages/*` directory without a BUILD.ts.
 * - `newPackage` is the `run` target that creates such a directory.
 */
import { DefaultRule, NewPackage, PackageJson, PackageJsonTemplate, StandardPackage } from "tsflows-rules"

/**
 * The manifest fields every package in this workspace shares.
 *
 * Scripts here are literal commands: a template is workspace wide and cannot
 * name one package's targets. A package binds its own targets in its own
 * `scripts`, where the command is derived from the resolved label.
 */
export const template = PackageJsonTemplate.make({
  type: "module",
  license: "MIT",
  author: "flows",
  sideEffects: [],
  engines: { node: ">=22.19.0" },
  scripts: PackageJsonTemplate.standardScripts
})

/**
 * Standard package defaults.
 *
 * A directory under `packages/` with a `package.json` and no `BUILD.ts` gets
 * the four conventional targets plus `packageJsonCheck`, `packageJsonWrite`,
 * and `packageJsonRefresh`. `packageJsonCheck` runs under `lint` and `ci`; the
 * two writing targets run under `run` alone.
 */
export const packageDefaults = DefaultRule({
  directories: "packages/*",
  marker: "package.json",
  macro: (attrs: { readonly cwd: string }) => {
    const standard = StandardPackage({ deps: [], cwd: attrs.cwd })
    return {
      ...standard,
      packageJson: PackageJson({
        name: `@smthrs/${attrs.cwd.split("/").at(-1) ?? attrs.cwd}`,
        version: "0.1.0",
        template,
        scripts: { build: standard.lib, lint: standard.lint },
        publish: { entry: standard.lib }
      })
    }
  }
})

/**
 * Scaffolds a new workspace package.
 *
 * ```sh
 * tsflows run //:newPackage --name @smthrs/widget
 * ```
 */
export const newPackage = NewPackage({
  directory: "packages",
  version: "0.1.0",
  license: "MIT",
  fields: template.fields,
  tsconfigExtends: "../../tsconfig.json"
})
