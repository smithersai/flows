/**
 * `tsflows`: dependency installation expressed as flows.
 *
 * Two modules, mirroring the two questions the design answers: which package
 * manager does the work, and what the work is made of.
 *
 * @since 0.1.0
 */

/**
 * The `install` flow, its action declarations, and their implementation layers.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Install from "./Install.ts"

/**
 * The package-manager layer seam and its npm, pnpm, and Bun implementations.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as PackageManager from "./PackageManager.ts"
