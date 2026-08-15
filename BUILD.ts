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

// .github/workflows/ci.yml is hand-written. This target's default `contract`
// mode only verifies the checked-in workflow still runs the declared gates;
// only an explicit `write` mode would regenerate the file.
export const ci = GithubCiGen({
  cacheUrlSecret: "TSFLOWS_CACHE_URL",
  kinds: ["build", "test", "lint", "docs"],
  gates: [{ name: "documentation parity", command: "pnpm exec tsflows docs '//...'", job: "test" }]
})

export const packageDefaults = DefaultRule({
  directories: "packages/*",
  macro: StandardPackage
})
