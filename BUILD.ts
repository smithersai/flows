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
  file,
  glob
} from "tsflows-rules"

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

export const ci = GithubCiGen({
  workflowName: "CI",
  pattern: "//...",
  kinds: ["build", "test", "lint"],
  pushBranches: ["main"],
  pullRequest: true,
  workflowDispatch: true,
  runsOn: "ubuntu-latest",
  nodeVersion: "22",
  cacheUrlSecret: "TSFLOWS_CACHE_URL",
  cancelInProgress: true,
  output: ".github/workflows/ci.yml"
})

export const packageDefaults = DefaultRule.make({
  directories: glob("packages/*"),
  marker: "package.json",
  unless: "BUILD.ts",
  macro: StandardPackage,
  attrs: { deps: [] }
})
