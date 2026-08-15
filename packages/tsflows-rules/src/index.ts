/**
 * BUILD.ts rule authoring, macros, and catalog.
 *
 * @since 0.1.0
 */

/**
 * Workspace remote-cache declarations.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as RemoteCache from "./RemoteCache.ts"

/**
 * Declared input schemas and constructors.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Input from "./Input.ts"

/**
 * Rule construction and target metadata.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Rule from "./Rule.ts"

/**
 * Confined filesystem reads shared by discovery.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as SafeFs from "./SafeFs.ts"

/**
 * Package manifest declarations, rendering, and target synthesis.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as PackageJsonDeclaration from "./PackageJson.ts"

/**
 * Shared inert manifest templates.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as PackageJsonTemplate from "./PackageJsonTemplate.ts"

/** @category constructors @since 0.1.0 */
export { file, gitDiff, glob } from "./Input.ts"
/** @category constructors @since 0.1.0 */
export { Workspace } from "./Config.ts"
/** @category constructors @since 0.1.0 */
export { DefaultRule } from "./DefaultRule.ts"
/** @category actions @since 0.1.0 */
export { Exec, ExecError, ExecLive } from "./Exec.ts"
/** @category macros @since 0.1.0 */
export { StandardPackage } from "./StandardPackage.ts"
/** @category rules @since 0.1.0 */
export { Filegroup } from "./Filegroup.ts"
/** @category actions @since 0.1.0 */
export { ExpandFilegroup, ExpandFilegroupLive, FilegroupError } from "./Filegroup.ts"
/** @category guards @since 0.1.0 */
export { isFilegroup } from "./Filegroup.ts"
/** @category rules @since 0.1.0 */
export { PnpmWorkspace } from "./PnpmWorkspace.ts"
/** @category rules @since 0.1.0 */
export { TsBuild } from "./TsBuild.ts"
/** @category rules @since 0.1.0 */
export { DtsBuild } from "./DtsBuild.ts"
/** @category rules @since 0.1.0 */
export { Typecheck } from "./Typecheck.ts"
/** @category rules @since 0.1.0 */
export { Vitest } from "./Vitest.ts"
/** @category rules @since 0.1.0 */
export { VitestCoverage } from "./VitestCoverage.ts"
/** @category rules @since 0.1.0 */
export { VitestWatch } from "./VitestWatch.ts"
/** @category rules @since 0.1.0 */
export { BiomeCheck } from "./BiomeCheck.ts"
/** @category rules @since 0.1.0 */
export { Dprint } from "./Dprint.ts"
/** @category rules @since 0.1.0 */
export { EsLint } from "./EsLint.ts"
/** @category rules @since 0.1.0 */
export { DepsLint } from "./DepsLint.ts"
/** @category rules @since 0.1.0 */
export { PackageLint } from "./PackageLint.ts"
/** @category rules @since 0.1.0 */
export { DocsParity } from "./DocsParity.ts"
/** @category actions @since 0.1.0 */
export { CheckDocs, CheckDocsLive, DocsParityError } from "./DocsParity.ts"
/** @category rules @since 0.1.0 */
export { SortPackageJson } from "./SortPackageJson.ts"
/** @category constructors @since 0.1.0 */
export { generated, PackageJson } from "./PackageJson.ts"
/** @category rules @since 0.1.0 */
export { PackageJsonCheck, PackageJsonWrite } from "./PackageJson.ts"
/** @category actions @since 0.1.0 */
export { SyncPackageJson, SyncPackageJsonLive } from "./PackageJson.ts"
/** @category rules @since 0.1.0 */
export { NewPackage } from "./NewPackage.ts"
/** @category actions @since 0.1.0 */
export { ScaffoldPackage, ScaffoldPackageLive } from "./NewPackage.ts"
/** @category actions @since 0.1.0 */
export {
  CheckFile,
  CheckFileLive,
  checkGeneratedFile,
  DriftError,
  WriteFile,
  WriteFileError,
  WriteFileLive,
  writeGeneratedFile
} from "./GeneratedFile.ts"
/** @category rules @since 0.1.0 */
export { GithubCiGen } from "./GithubCiGen.ts"
/** @category actions @since 0.1.0 */
export { CheckWorkflow, CheckWorkflowLive } from "./GithubCiGen.ts"
/** @category parsing @since 0.1.0 */
export * as GithubWorkflow from "./GithubWorkflow.ts"
/** @category rules @since 0.1.0 */
export { Changesets } from "./Changesets.ts"
/** @category rules @since 0.1.0 */
export { NpmPublish } from "./NpmPublish.ts"
/** @category rules @since 0.1.0 */
export { JsrPublish } from "./JsrPublish.ts"
/** @category rules @since 0.1.0 */
export { TypedocDocs } from "./TypedocDocs.ts"
/** @category rules @since 0.1.0 */
export { LlmLint } from "./LlmLint.ts"
/** @category actions @since 0.1.0 */
export { ClaudeCliMissing, FindingsError, LlmReview, LlmReviewError, LlmReviewLive } from "./LlmLint.ts"
/** @category rules @since 0.1.0 */
export { Clean } from "./Clean.ts"
/** @category rules @since 0.1.0 */
export { Dev } from "./Dev.ts"
/** @category rules @since 0.1.0 */
export { ToolBuild } from "./ToolBuild.ts"
/** @category actions @since 0.1.0 */
export {
  CaptureOutputs,
  CaptureOutputsLive,
  measureOutput,
  OutputError,
  readOutputManifest,
  verifyOutputs
} from "./ToolBuild.ts"
