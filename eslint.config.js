// Aggregator ESLint flat config for the Bazel lint aspect.
//
// ESLint 9 discovers flat config from the process working directory. The
// rules_lint aspect runs eslint with the working directory at the Bazel bin
// root, so per-package configs are never found on their own. This file is
// the config the aspect discovers: it imports each wired package's own
// eslint.config.js and re-prefixes its `files` globs with the package path,
// so the rules each package maintains apply to exactly the same sources as
// the package's own `eslint src` script.
//
// Flat-config arrays are order-sensitive and later global entries (those
// without `files`, such as js.configs.recommended) would re-enable rules that
// an earlier package's scoped entries turned off. All global entries
// therefore come first, then every package's scoped entries.
//
// This file is only consulted when eslint runs at the workspace root.
// Per-package `pnpm run lint` resolves the package's own config first and
// never reads this file.
import canonical from "./packages/canonical/eslint.config.js"
import crypto from "./packages/crypto/eslint.config.js"
import keys from "./packages/keys/eslint.config.js"

const packages = { canonical, crypto, keys }

const globals = (configs) => configs.filter((entry) => entry.files === undefined)

const scoped = (pkg, configs) =>
  configs
    .filter((entry) => entry.files !== undefined)
    .map((entry) => ({ ...entry, files: entry.files.map((pattern) => `packages/${pkg}/${pattern}`) }))

export default [
  ...Object.values(packages).flatMap(globals),
  ...Object.entries(packages).flatMap(([pkg, configs]) => scoped(pkg, configs))
]
