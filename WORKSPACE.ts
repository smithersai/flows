/**
 * Workspace-level declarations for the flows repository.
 *
 * `WORKSPACE.ts` declares what exists; `BUILD.ts` files declare targets. The
 * toolchain is registered here once, so a target reads the registration
 * instead of taking the runtime and the package manager as attrs.
 *
 * Discovery resolves this file before it opens the workspace index, so the
 * registration is in place before any `BUILD.ts` evaluates and every rule can
 * read it while it builds its declaration.
 *
 * Targets stay in `BUILD.ts`. Only a `BUILD.ts` file contributes targets to a
 * package, so a target declared here would have no label.
 */
import { Smithers } from "@smthrs/targets"

/**
 * The interpreter every tool runs under. The declaration is a requirement: the
 * Runtime service measures the host and refuses to execute when it does not
 * satisfy this.
 */
export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })

/**
 * The package manager. It takes the runtime as a dependency because pnpm is
 * itself a program the runtime executes.
 */
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })

/**
 * The registered toolchain. Its identity is cache-key material: a target's key
 * records the manager and the runtime the result was produced under, so a
 * version bump here invalidates every target.
 */
export const toolchain = Smithers.registerToolchains({ runtime, packageManager })

/**
 * Per-package npm addressing. `npm("effect")` declares one lockfile package
 * as a content-addressed input: the declaration digests the package's
 * lockfile entries and their transitive closure, so a target re-keys when the
 * package changes and stays stable when an unrelated entry changes. The
 * installed `node_modules` tree is never read, so the input-expansion guard
 * that refuses `node_modules` is untouched.
 */
export const npm = Smithers.NpmLock({ lockfile: Smithers.file("//pnpm-lock.yaml") })
