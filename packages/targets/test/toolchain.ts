/**
 * The toolchain registration shared by target tests.
 *
 * Every tool-running target reads the registered manager, and the targets that
 * evaluate an inline program read the registered runtime. Tests assert on the
 * argv a target produces, so they need one fixed registration rather than one
 * per file: two files registering different versions would produce different
 * argv for the same target and hide a regression behind a fixture difference.
 *
 * Importing this module registers the toolchain. The registration slot is
 * process state, so the module clears any previous one first: vitest gives each
 * test file its own module registry, but a host that shares one registry across
 * files would otherwise hit the once-only refusal.
 */
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"

/** The runtime every test target runs under. */
export const runtime = Runtime.Node({ version: "24.9.0" })

/** The package manager every test target runs its tool through. */
export const packageManager = PackageManager.Pnpm({ version: "11.21.0", runtime })

/** Registers {@link runtime} and {@link packageManager}, replacing any prior registration. */
const register = (manager: PackageManager.PackageManager): PackageManager.Toolchain => {
  PackageManager.resetToolchains()
  return PackageManager.registerToolchains({ runtime, packageManager: manager })
}

/** The toolchain this test module registered. */
export const toolchain = register(packageManager)

/**
 * Runs `body` with a different manager registered, then restores the shared
 * one.
 *
 * A rule reads the registration while it builds its declaration, so a test that
 * wants npm behaviour has to register npm around the declaration rather than
 * pass it as an attr.
 */
export const withPackageManager = <A>(
  manager: PackageManager.PackageManager,
  body: () => A
): A => {
  register(manager)
  try {
    return body()
  } finally {
    register(packageManager)
  }
}
