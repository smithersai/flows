/**
 * The `Smithers` namespace: the whole BUILD.ts authoring surface.
 *
 * A BUILD.ts file imports this namespace once and reaches everything through
 * it, so the import line never changes as a workspace grows:
 *
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
 * export const cacheToken = Smithers.Secret("SMITHERS_CACHE_TOKEN")
 * ```
 *
 * Library code that consumes this package imports the module it needs
 * directly, `@smthrs/targets/Target`, rather than going through the
 * namespace.
 *
 * @since 0.1.0
 */
import * as CargoModule from "./Cargo.ts"
import * as CiToolchainModule from "./CiToolchain.ts"
import * as PackageManagerModule from "./PackageManager.ts"
import * as RuntimeModule from "./Runtime.ts"
import * as RustToolchainModule from "./RustToolchain.ts"
import * as VerbModule from "./Verb.ts"

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
 * Target construction and target metadata.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Target from "./Target.ts"

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
export { PackageDefaults } from "./PackageDefaults.ts"
/** @category actions @since 0.1.0 */
export { Exec, ExecError, ExecLive } from "./Exec.ts"
/** @category macros @since 0.1.0 */
export { StandardPackage } from "./StandardPackage.ts"
/** @category targets @since 0.1.0 */
export { Filegroup } from "./Filegroup.ts"
/** @category actions @since 0.1.0 */
export { ExpandFilegroup, ExpandFilegroupLive, FilegroupError } from "./Filegroup.ts"
/** @category guards @since 0.1.0 */
export { isFilegroup } from "./Filegroup.ts"
/** @category targets @since 0.1.0 */
export { Install } from "./Install.ts"
/** @category targets @since 0.1.0 */
export { Lockfile } from "./Lockfile.ts"
/** @category targets @since 0.1.0 */
export { PnpmWorkspace } from "./PnpmWorkspaceFile.ts"
/** @category targets @since 0.1.0 */
export { Tsconfig } from "./Tsconfig.ts"
/** @category constructors @since 0.1.0 */
export { Secret } from "./Secret.ts"
/** @category targets @since 0.1.0 */
export { TsBuild } from "./TsBuild.ts"
/** @category targets @since 0.1.0 */
export { DtsBuild } from "./DtsBuild.ts"
/** @category targets @since 0.1.0 */
export { Typecheck } from "./Typecheck.ts"
/** @category targets @since 0.1.0 */
export { Vitest } from "./Vitest.ts"
/** @category targets @since 0.1.0 */
export { VitestCoverage } from "./VitestCoverage.ts"
/** @category targets @since 0.1.0 */
export { VitestWatch } from "./VitestWatch.ts"
/** @category targets @since 0.1.0 */
export { BiomeCheck } from "./BiomeCheck.ts"
/** @category targets @since 0.1.0 */
export { Dprint } from "./Dprint.ts"
/** @category targets @since 0.1.0 */
export { EsLint } from "./EsLint.ts"
/** @category targets @since 0.1.0 */
export { DepsLint } from "./DepsLint.ts"
/** @category targets @since 0.1.0 */
export { PackageLint } from "./PackageLint.ts"
/** @category targets @since 0.1.0 */
export { DocsParity } from "./DocsParity.ts"
/** @category actions @since 0.1.0 */
export { CheckDocs, CheckDocsLive, DocsParityError } from "./DocsParity.ts"
/** @category targets @since 0.1.0 */
export { SortPackageJson } from "./SortPackageJson.ts"
/** @category constructors @since 0.1.0 */
export { generated, PackageJson } from "./PackageJson.ts"
/** @category targets @since 0.1.0 */
export { PackageJsonCheck, PackageJsonWrite } from "./PackageJson.ts"
/** @category actions @since 0.1.0 */
export { SyncPackageJson, SyncPackageJsonLive } from "./PackageJson.ts"
/** @category targets @since 0.1.0 */
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
/** @category targets @since 0.1.0 */
export { GithubCiGen } from "./GithubCiGen.ts"
/** @category actions @since 0.1.0 */
/** @category parsing @since 0.1.0 */
export * as GithubWorkflow from "./GithubWorkflow.ts"
/** @category targets @since 0.1.0 */
export { Changesets } from "./Changesets.ts"
/** @category targets @since 0.1.0 */
export { NpmPublish } from "./NpmPublish.ts"
/** @category targets @since 0.1.0 */
export { JsrPublish } from "./JsrPublish.ts"
/** @category targets @since 0.1.0 */
export { TypedocDocs } from "./TypedocDocs.ts"
/** @category targets @since 0.1.0 */
export { LlmLint } from "./LlmLint.ts"
/** @category actions @since 0.1.0 */
export { ClaudeCliMissing, FindingsError, LlmReview, LlmReviewError, LlmReviewLive } from "./LlmLint.ts"
/** @category targets @since 0.1.0 */
export { Clean } from "./Clean.ts"
/** @category targets @since 0.1.0 */
export { Dev } from "./Dev.ts"
/** @category targets @since 0.1.0 */
export { ToolBuild } from "./ToolBuild.ts"
/** @category targets @since 0.1.0 */
export { CargoLint, CargoTest } from "./Cargo.ts"
/** @category targets @since 0.1.0 */
export { NodeTest } from "./NodeTest.ts"
/** @category constructors @since 0.1.0 */
export { entrypoint, testRunner } from "./NodeTest.ts"
/** @category targets @since 0.1.0 */
export { NodeBinary } from "./NodeBinary.ts"
/** @category actions @since 0.1.0 */
export {
  CaptureOutputs,
  CaptureOutputsLive,
  measureOutput,
  OutputError,
  readOutputManifest,
  verifyOutputs
} from "./ToolBuild.ts"

/**
 * Declared JavaScript runtimes and the argv they run programs with.
 *
 * The name is both the namespace the constructors live under and the type they
 * return, so a BUILD.ts file writes `Runtime.Node({ … })` and annotates the
 * result `Runtime`. The module's remaining types are reachable at
 * `@smthrs/targets/Runtime`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export const Runtime = RuntimeModule

/**
 * One declared JavaScript runtime.
 *
 * @category models
 * @since 0.1.0
 */
export type Runtime = RuntimeModule.Runtime

/**
 * Declared package managers, their argv spellings, and the lockfile each one
 * writes.
 *
 * The name is both the namespace the constructors live under and the type they
 * return, so a BUILD.ts file writes `PackageManager.Pnpm({ … })` and annotates
 * the result `PackageManager`. The module's remaining types are reachable at
 * `@smthrs/targets/PackageManager`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export const PackageManager = PackageManagerModule

/**
 * One declared package manager.
 *
 * @category models
 * @since 0.1.0
 */
export type PackageManager = PackageManagerModule.PackageManager

/**
 * The CLI verbs a generated pipeline may run across a target graph.
 *
 * The name is both the namespace the verb values live under and the type they
 * have, so a BUILD.ts file writes `pipelineVerbs: [Verb.Build, Verb.Test]` and
 * annotates the result `Verb`. The module's remaining types are reachable at
 * `@smthrs/targets/Verb`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export const Verb = VerbModule

/**
 * One CLI verb a generated pipeline may run.
 *
 * @category models
 * @since 0.1.0
 */
export type Verb = VerbModule.Verb

/**
 * Declared Rust toolchains and the argv they install and run cargo with.
 *
 * The name is both the namespace the constructors live under and the type they
 * return, so a BUILD.ts file writes `RustToolchain.Pinned({})` and annotates the
 * result `RustToolchain`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export const RustToolchain = RustToolchainModule

/**
 * One declared Rust toolchain.
 *
 * @category models
 * @since 0.1.0
 */
export type RustToolchain = RustToolchainModule.RustToolchain

/**
 * Declared cargo gates and the argv each one renders to.
 *
 * The targets themselves are `Smithers.CargoLint` and `Smithers.CargoTest`; this
 * namespace holds the check constructors a BUILD.ts file passes them,
 * `Cargo.Fmt()`, `Cargo.Clippy()`, and `Cargo.Test()`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export const Cargo = CargoModule

/**
 * What one generated CI job requires before its targets run.
 *
 * The name is both the namespace the constructors live under and the type
 * `Needs` returns, so a BUILD.ts file writes `CiToolchain.Needs({ … })` and
 * annotates the result `CiToolchain`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export const CiToolchain = CiToolchainModule

/**
 * Everything one generated CI job requires before its targets run.
 *
 * @category models
 * @since 0.1.0
 */
export type CiToolchain = CiToolchainModule.Toolchain

/**
 * Placeholder minting and outbound secret substitution.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as SecretProxy from "./SecretProxy.ts"
