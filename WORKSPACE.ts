/**
 * Workspace-level declarations for the flows repository.
 *
 * `WORKSPACE.ts` declares what exists; `BUILD.ts` files declare targets. The
 * toolchain is registered here once, so a target reads the registration
 * instead of taking the runtime and the package manager as attrs.
 *
 * Discovery resolves this file before it opens the workspace index, so the
 * declarations here are available to every command, including the read-only
 * ones.
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
