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

// There is deliberately no GithubCiGen target here yet. Its write mode's
// default output is .github/workflows/ci.yml, which is still hand-written,
// so a declared target made `tsflows build //:ci` an overwrite of the real
// CI configuration. Re-declare it with an explicit path when workflow
// generation is adopted and the generated file becomes the source of truth.

export const packageDefaults = DefaultRule({
  directories: "packages/*",
  macro: StandardPackage
})
