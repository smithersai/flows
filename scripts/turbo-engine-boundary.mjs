#!/usr/bin/env node
/**
 * Release-train boundary assertion, driven by `turbo query`.
 *
 * The release train packs only `smthrs.group === "engine"`, so an engine
 * package must never depend on an agent or tooling package. `turbo
 * boundaries` enforces the same rule from import scanning (see the
 * `boundaries` block in turbo.json); this script proves the rule from the
 * other side — Turbo's GraphQL package graph — so the assertion does not
 * depend on Boundaries' experimental status.
 *
 * Run it from anywhere: `node scripts/turbo-engine-boundary.mjs`.
 * Exit code 1 with a per-package listing when the boundary is violated.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function resolve(...parts) {
  return join(...parts)
}

const query = `query {
  packages {
    items {
      name
      directDependencies {
        items {
          name
        }
      }
    }
  }
}`

const turboBin = join(repoRoot, "node_modules", ".bin", "turbo")
const result = JSON.parse(
  execFileSync(turboBin, ["query", query], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
)

// name -> smthrs.group, read from each workspace manifest. The GraphQL schema
// does not expose custom manifest fields, so the group tier comes from disk.
const groups = new Map()
const workspaceGlobs = ["packages", "apps"]
for (const top of workspaceGlobs) {
  const { readdirSync, existsSync } = await import("node:fs")
  for (const entry of readdirSync(join(repoRoot, top), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(repoRoot, top, entry.name, "package.json")
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    if (manifest.smthrs?.group) groups.set(manifest.name, manifest.smthrs.group)
  }
}
const infraManifest = JSON.parse(readFileSync(join(repoRoot, "packages", "build", "infra", "package.json"), "utf8"))
groups.set(infraManifest.name, infraManifest.smthrs.group)

const violations = []
let enginePackages = 0
for (const pkg of result.data.packages.items) {
  if (groups.get(pkg.name) !== "engine") continue
  enginePackages++
  for (const dep of pkg.directDependencies.items) {
    const depGroup = groups.get(dep.name)
    if (depGroup !== undefined && depGroup !== "engine") {
      violations.push(`${pkg.name} (engine) depends on ${dep.name} (${depGroup})`)
    }
  }
}

if (violations.length > 0) {
  console.error("engine boundary violated:")
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log(`engine boundary holds: ${enginePackages} engine packages, 0 agent/tooling dependencies`)
