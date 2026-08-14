/**
 * Root tsflows targets for the flows pnpm workspace.
 *
 * `nodeModules` is executable today. Shared input declarations and the
 * default-rule declaration are inert configuration values, not targets.
 */
import {
  DefaultRule,
  PnpmWorkspace,
  StandardPackage,
  file,
  glob
} from "../tsflows/rules/src/index.ts"

export const nodeModules = PnpmWorkspace({
  projectRoot: ".",
  lockfile: "pnpm-lock.yaml",
  workspaceFile: "pnpm-workspace.yaml",
  packageManager: "pnpm@11.21.0"
})

export const rootPackageJson = file("//package.json")
export const rootTsconfig = file("//tsconfig.base.json")
export const workspaceTsconfig = file("//tsconfig.json")
export const rootJSDocConfig = file("//eslint.jsdoc.js")
export const pnpmWorkspace = file("//pnpm-workspace.yaml")

export const packageDefaults = DefaultRule.make({
  directories: glob("packages/*"),
  marker: "package.json",
  unless: "BUILD.ts",
  macro: StandardPackage,
  attrs: { deps: [] }
})
