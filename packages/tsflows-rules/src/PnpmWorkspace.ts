/**
 * pnpm workspace installation targets.
 *
 * @since 0.1.0
 */
import { Install, PackageManager } from "@smthrs/tsflows-next"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Input from "./Input.ts"
import * as Rule from "./Rule.ts"

/**
 * Attributes for {@link PnpmWorkspace}.
 *
 * The three file attrs are caller-owned declarations harvested by
 * {@link Rule.make}; the rule does not reconstruct paths or hide a root
 * package.json input. `packageManager` is tool identity, not a file path.
 * The conventional paths are constructor defaults, but the constructed attrs
 * still carry typed file declarations that contribute content to key material.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  /** @default Input.file("pnpm-lock.yaml") */
  lockfile: Input.File.pipe(
    Schema.withConstructorDefault(Effect.succeed(Input.file("pnpm-lock.yaml")))
  ),
  /** @default Input.file("pnpm-workspace.yaml") */
  workspaceFile: Input.File.pipe(
    Schema.withConstructorDefault(Effect.succeed(Input.file("pnpm-workspace.yaml")))
  ),
  /** @default Input.file("package.json") */
  packageJson: Input.File.pipe(
    Schema.withConstructorDefault(Effect.succeed(Input.file("package.json")))
  ),
  packageManager: Schema.NonEmptyString
})

/**
 * Attributes for {@link PnpmWorkspace}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Plans the real tsflows install Flow for a pnpm workspace.
 *
 * The Install Flow measures the lockfile and manager version, runs a sealed
 * fetch, then always materializes host-local links. The caller declares the
 * lockfile, workspace manifest, and root package.json directly in attrs, so
 * their content reaches key material through {@link Rule.make} collection.
 * The wrapper target itself is not cacheable: a JSON hit would skip the whole
 * nested flow, including link, without restoring either the manager store or
 * `node_modules`.
 *
 * @category rules
 * @since 0.1.0
 */
export const PnpmWorkspace = Rule.make("PnpmWorkspace", {
  attrs: Attrs,
  kinds: ["run"],
  success: Install.LinkManifest,
  error: PackageManager.PackageManagerError,
  cache: false,
  implementation: () => Install.Install.call({})
})
