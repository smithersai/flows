/**
 * Root tsflows targets for the flows pnpm workspace.
 *
 * `nodeModules` is executable today. Shared input declarations and the
 * default-rule declaration are inert configuration values, not targets.
 */
import {
  DefaultRule,
  GithubCiGen,
  PnpmWorkspace,
  StandardPackage,
  file
} from "tsflows-rules"

export const nodeModules = PnpmWorkspace({
  packageManager: "pnpm@11.21.0"
})

export const rootPackageJson = file("//package.json")
export const rootTsconfig = file("//tsconfig.base.json")
export const workspaceTsconfig = file("//tsconfig.json")
export const rootJSDocConfig = file("//eslint.jsdoc.js")
export const pnpmWorkspace = file("//pnpm-workspace.yaml")

export const ci = GithubCiGen({
  cacheUrlSecret: "TSFLOWS_CACHE_URL"
})

export const packageDefaults = DefaultRule({
  directories: "packages/*",
  macro: StandardPackage
})
