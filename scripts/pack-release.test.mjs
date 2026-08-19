import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  dependencyOrder,
  packResultFilename,
  publicationManifest,
  readWorkspaceManifests,
  releaseGroup,
  workspaceDependencies,
  workspaces
} from "./pack-release.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workflow = (name) => readFileSync(join(repoRoot, ".github", "workflows", name), "utf8")

/**
 * The build-system target each modelled gate command stands for.
 *
 * Comparing the two workflows by shell string stopped working the moment a
 * gate could be spelled either way: `pnpm run circular` and
 * `pnpm exec smthrs build '//:circular'` run the same gate, and a string
 * comparison reads them as two different gates while a workflow that dropped
 * the gate entirely reads as a match for nothing at all. The comparison below
 * is over TARGETS, so a gate satisfies parity however it is spelled.
 *
 * Only commands with a root target in BUILD.ts appear here. `pnpm run check`,
 * `pnpm run lint`, `pnpm test`, and the recursive build are per-package
 * recursions with no single root label, so they keep their command as their
 * identity until they have one.
 */
const modelledGates = new Map([
  ["pnpm run circular", "build //:circular"],
  ["pnpm run browser", "build //:browser"],
  ["node --test scripts/pack-release.test.mjs", "build //:packReleaseTest"],
  ["node --test scripts/release-rehearsal.test.mjs", "build //:releaseRehearsalTest"],
  ["node --test scripts/set-release-version.test.mjs", "build //:setReleaseVersionTest"],
  ["node --test scripts/flows-backup.test.mjs", "build //:flowsBackupTest"],
  ["node --test scripts/check-test-pins.test.mjs", "build //:checkTestPinsTest"]
])

/**
 * Targets ci.yml runs that release.yml is not required to run, each with the
 * reason. Anything not named here is a divergence and fails the parity gate.
 */
const ciOnlyTargets = new Map([
  [
    "lint //:ci",
    "the workflow contract holds ci.yml to its own gate roster. release.yml is not the file it reads."
  ],
  [
    "docs //...",
    "documentation parity runs only on the pull-request path today. This is a real gap in release.yml's" +
    " roster, not a property of the gate, and closing it is an edit to release.yml."
  ]
])

/** A smithers build invocation, in either the workspace-binary or source form. */
const smithersInvocation =
  /\b(?:pnpm exec smthrs|pnpm dlx @smthrs\/build-cli|npx smthrs|bunx smthrs|node packages\/build-cli\/src\/main\.js) (build|test|lint|docs|ci|run) ['"]([^'"]+)['"]/g

/** The shell gate shapes this repository's workflows use. */
const shellGates = [
  /\bpnpm run [a-z][a-z:-]*/g,
  /\bpnpm --recursive --if-present run [a-z][a-z:-]*/g,
  /\bpnpm test\b/g,
  /\bnode (?:--test )?scripts\/[\w.-]+\.mjs/g
]

/**
 * Splits a workflow into its jobs, keeping each job's body and whether it is
 * advisory.
 *
 * Job ids sit at two spaces under the top-level `jobs:` key and job keys at
 * four, which is enough structure to separate the required lanes from the
 * `continue-on-error` ones without a YAML parser.
 */
const workflowJobs = (source) => {
  const jobs = []
  let inJobs = false
  let current
  for (const line of source.split("\n")) {
    if (/^\S/.test(line)) {
      inJobs = /^jobs:\s*$/.test(line)
      current = undefined
      continue
    }
    if (!inJobs) continue
    const declaration = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (declaration !== null) {
      current = { id: declaration[1], advisory: false, lines: [] }
      jobs.push(current)
      continue
    }
    if (current === undefined) continue
    if (/^ {4}continue-on-error:\s*true\s*$/.test(line)) current.advisory = true
    current.lines.push(line)
  }
  return jobs
}

/**
 * The set of gate targets a workflow's required jobs run.
 *
 * Advisory jobs are excluded: a `continue-on-error` lane cannot fail a merge,
 * so requiring release.yml to reproduce it would pin an advisory experiment as
 * a release gate. A command with no modelled target keeps its own text as its
 * identity, prefixed `shell`, so it still participates in the comparison.
 */
const gateTargets = (source) => {
  const targets = new Set()
  for (const job of workflowJobs(source)) {
    if (job.advisory) continue
    const body = job.lines.join("\n")
    for (const [, verb, pattern] of body.matchAll(smithersInvocation)) targets.add(`${verb} ${pattern}`)
    for (const shape of shellGates) {
      for (const match of body.matchAll(shape)) {
        targets.add(modelledGates.get(match[0]) ?? `shell ${match[0]}`)
      }
    }
  }
  return targets
}

/** The ci.yml targets release.yml does not run and is not excused from. */
const parityGaps = (ci, release) => {
  const covered = gateTargets(release)
  return [...gateTargets(ci)].filter((target) => !covered.has(target) && !ciOnlyTargets.has(target)).sort()
}

test("publicationManifest replaces source exports without mutating the input", () => {
  const manifest = {
    name: "@smthrs/example",
    exports: {
      ".": "./src/index.ts"
    },
    publishConfig: {
      access: "public",
      provenance: true,
      exports: {
        ".": {
          types: "./dist/esm/index.d.ts",
          import: "./dist/esm/index.js",
          require: "./dist/cjs/index.js"
        }
      }
    }
  }

  assert.deepEqual(publicationManifest(manifest), {
    name: "@smthrs/example",
    exports: {
      ".": {
        types: "./dist/esm/index.d.ts",
        import: "./dist/esm/index.js",
        require: "./dist/cjs/index.js"
      }
    },
    publishConfig: {
      access: "public",
      provenance: true
    }
  })
  assert.equal(manifest.exports["."], "./src/index.ts")
  assert.ok("exports" in manifest.publishConfig)
})

test("packResultFilename makes pnpm's absolute pack result portable", () => {
  assert.equal(
    packResultFilename(
      { filename: "/tmp/release/smthrs-example-0.1.0.tgz" },
      "@smthrs/example"
    ),
    "smthrs-example-0.1.0.tgz"
  )
  assert.throws(
    () => packResultFilename({}, "@smthrs/example"),
    /pnpm pack returned no filename/
  )
})

test("publicationManifest rejects a package without publication exports", () => {
  assert.throws(
    () => publicationManifest({ name: "@smthrs/example", publishConfig: { access: "public" } }),
    /publishConfig\.exports/
  )
})

test("workspaces covers every non-private engine package under packages/", () => {
  // Recomputed here rather than imported, so a change to the derivation in
  // pack-release.mjs has to agree with an independent reading of packages/.
  const packagesRoot = join(repoRoot, "packages")
  const manifests = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(packagesRoot, name, "package.json")))
    .map((name) => [name, JSON.parse(readFileSync(join(packagesRoot, name, "package.json"), "utf8"))])
  const published = manifests
    .filter(([, manifest]) => !manifest.private && manifest.smthrs?.group === "engine")
    .map(([name]) => name)

  assert.equal(releaseGroup, "engine")
  assert.deepEqual([...workspaces].sort(), published.sort())
  assert.ok(manifests.some(([, manifest]) => !manifest.private && manifest.smthrs?.group === "agent"))
  assert.ok(manifests.some(([, manifest]) => manifest.smthrs?.group === "tooling"))
})

test("pack-release lists workspace directories and package names in publication order", () => {
  const list = execFileSync(process.execPath, ["scripts/pack-release.mjs", "--list"], {
    cwd: repoRoot,
    encoding: "utf8"
  })
  const names = execFileSync(process.execPath, ["scripts/pack-release.mjs", "--names"], {
    cwd: repoRoot,
    encoding: "utf8"
  })
  const manifests = readWorkspaceManifests()

  assert.deepEqual(list.trim().split("\n"), workspaces)
  assert.deepEqual(names.trim().split("\n"), workspaces.map((directory) => manifests.get(directory).name))
})

test("pack-release order is a topological order of the workspace dependency graph", () => {
  const dependencies = workspaceDependencies(readWorkspaceManifests())
  const position = new Map(workspaces.map((name, index) => [name, index]))
  const unordered = []
  for (const [workspace, edges] of dependencies) {
    for (const edge of edges) {
      if (position.get(edge) > position.get(workspace)) unordered.push(`${workspace} -> ${edge}`)
    }
  }

  // @smthrs/kernel publishes kernel/test/TestHost, which imports
  // @smthrs/platform-browser, and platform-browser imports @smthrs/kernel
  // back. That cycle is the one edge publication order cannot respect. A
  // second entry here is a new cycle, and a new release-ordering hazard.
  assert.deepEqual(unordered.sort(), ["kernel -> platform-browser"])
})

test("release.yml publishes exactly the packed workspaces, in the packed order", () => {
  const release = workflow("release.yml")

  // The publish step reads the pack manifest, so the published set is the
  // packed set and the published order is the packed order by construction.
  assert.match(release, /manifest\.json/)
  assert.match(release, /entry\.name \+ " " \+ entry\.filename/)
  assert.deepEqual([...release.matchAll(/@smthrs\/[\w-]+/g)].map((match) => match[0]), [])
})

test("the root BUILD.ts names every package manifest this suite reads", () => {
  // `//:packReleaseTest` and `//:setReleaseVersionTest` are cacheable root
  // targets whose key material is the manifest list in BUILD.ts. A glob
  // cannot cross the package boundaries, so the list is hand-maintained, and
  // this case is what keeps it complete: a manifest on disk that BUILD.ts does
  // not name is a gate replaying green over a package it never keyed.
  const packagesRoot = join(repoRoot, "packages")
  const onDisk = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "package.json")))
    .map((entry) => `//packages/${entry.name}/package.json`)
    .sort()
  const build = readFileSync(join(repoRoot, "BUILD.ts"), "utf8")
  const declared = [...build.matchAll(/Smithers\.file\("(\/\/packages\/[^/"]+\/package\.json)"\)/g)]
    .map((match) => match[1])
    .sort()

  assert.deepEqual(declared, onDisk)
})

test("every gate target in ci.yml also runs in release.yml", () => {
  assert.deepEqual(parityGaps(workflow("ci.yml"), workflow("release.yml")), [])
})

test("the ci-only excuses name targets ci.yml actually runs", () => {
  const ci = gateTargets(workflow("ci.yml"))
  const stale = [...ciOnlyTargets.keys()].filter((target) => !ci.has(target))

  assert.deepEqual(stale, [], "an excuse for a gate ci.yml no longer runs is an excuse that hides the next one")
})

test("the parity gate fails on a ci.yml gate release.yml does not run", () => {
  const ci = [
    "jobs:",
    "  test:",
    "    steps:",
    "      - run: pnpm run circular",
    "      - run: pnpm run browser"
  ].join("\n")
  const release = ["jobs:", "  publish:", "    steps:", "      - run: pnpm run circular"].join("\n")

  assert.deepEqual(parityGaps(ci, release), ["build //:browser"])
})

test("a gate converted to a smithers target still satisfies parity", () => {
  // The failure this replaces: the old extractor recognised `pnpm run
  // <script>` and nothing else, so converting ci.yml's gate to a smithers
  // invocation emptied ci.yml's side of the comparison and the test passed
  // while protecting nothing.
  const ci = ["jobs:", "  test:", "    steps:", "      - run: pnpm exec smthrs build '//:circular'"].join("\n")
  const release = ["jobs:", "  publish:", "    steps:", "      - run: pnpm run circular"].join("\n")

  assert.deepEqual([...gateTargets(ci)], ["build //:circular"])
  assert.deepEqual(parityGaps(ci, release), [])
  assert.deepEqual(parityGaps(ci, ["jobs:", "  publish:", "    steps:", "      - run: pnpm test"].join("\n")), [
    "build //:circular"
  ])
})

test("an advisory lane is not held to release.yml's roster", () => {
  const ci = [
    "jobs:",
    "  shadow:",
    "    continue-on-error: true",
    "    steps:",
    "      - run: node packages/build-cli/src/main.js ci \"//packages/...\""
  ].join("\n")

  assert.deepEqual([...gateTargets(ci)], [])
  assert.deepEqual(parityGaps(ci, "jobs:\n  publish:\n    steps: []\n"), [])
})

test("dependencyOrder is a topological order with an alphabetical tiebreak", () => {
  assert.deepEqual(
    dependencyOrder(new Map([["z", new Set()], ["a", new Set(["z"])], ["m", new Set()]])),
    ["m", "z", "a"]
  )
})

test("dependencyOrder enters a cycle at its alphabetically first member", () => {
  assert.deepEqual(
    dependencyOrder(new Map([
      ["b", new Set(["c"])],
      ["c", new Set(["b"])],
      ["a", new Set(["b", "c"])],
      ["d", new Set()]
    ])),
    ["d", "b", "c", "a"]
  )
})
