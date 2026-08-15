/**
 * The CI-workflow reader and the gate contract that keeps a generated or
 * verified pipeline from quietly dropping a repository's required gates.
 */
import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import {
  executableKinds,
  GithubCiGen,
  missingRequiredJobs,
  readWorkflowSource,
  render,
  workflowSourceByteLimit
} from "../src/GithubCiGen.ts"
import {
  isSupportedInstall,
  maximumWorkflowBytes,
  missingGates,
  parseWorkflow as parseStrictWorkflow,
  performsInstall,
  stripShellComments,
  supportedInstallCommands,
  WorkflowParseError,
  workspaceExec
} from "../src/GithubWorkflow.ts"
import * as Rule from "../src/Rule.ts"

/**
 * The flows repository's own pipeline, read from disk. It is the workload
 * this reader exists for: seven jobs, block scalars, `continue-on-error`
 * advisory lanes, `with:` maps, `env:` maps, and heavy comment traffic.
 */
const realWorkflowPath = NodePath.resolve(
  import.meta.dirname,
  "../../.github/workflows/ci.yml"
)

const readReal = async (): Promise<string | undefined> => Fs.readFile(realWorkflowPath, "utf8").catch(() => undefined)

/** Most focused fixtures omit trigger prose; supply the smallest real trigger. */
const parseWorkflow = (source: string): ReturnType<typeof parseStrictWorkflow> =>
  parseStrictWorkflow(/^on\s*:/m.test(source) ? source : `on: workflow_dispatch\n${source}`)

describe("parseWorkflow", () => {
  it("refuses a document that is not a runnable workflow", () => {
    const job = "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run check\n"
    expect(() => parseStrictWorkflow(job)).toThrow(/missing the required top-level `on`/)
    expect(() => parseStrictWorkflow("on: push\n")).toThrow(/missing the required top-level `jobs`/)
    expect(() => parseStrictWorkflow("on: {}\njobs:\n")).toThrow(/declares no trigger/)
    expect(() => parseStrictWorkflow("on: push\njobs:\n")).toThrow(/declares no jobs/)
    expect(() => parseStrictWorkflow("on: push\njobs: not-a-mapping\n")).toThrow(/inline `jobs` mappings/)
    expect(() => parseStrictWorkflow("on:\n  not-a-mapping\njobs:\n")).toThrow(/expected a "key: value"/)
  })

  it("accepts scalar, sequence, and block-mapping trigger forms", () => {
    const job = "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run check\n"
    for (const trigger of ["on: push", "on: [push, pull_request]", "on:\n  push:\n  workflow_dispatch:"]) {
      expect(parseStrictWorkflow(`${trigger}\n${job}`).jobs).toHaveLength(1)
    }
  })

  it("refuses jobs and steps GitHub cannot execute", () => {
    expect(() => parseWorkflow("jobs:\n  test:\n    steps:\n      - run: pnpm run check\n"))
      .toThrow(/declares no runner/)
    expect(() => parseWorkflow("jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n"))
      .toThrow(/declares no steps/)
    expect(() => parseWorkflow("jobs:\n  test: inline\n"))
      .toThrow(/must be a block mapping/)
    expect(() =>
      parseWorkflow(
        "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - name: inert\n"
      )
    ).toThrow(/exactly one of `uses` or `run`/)
    expect(() =>
      parseWorkflow(
        "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        run: echo shadow\n"
      )
    ).toThrow(/exactly one of `uses` or `run`/)
  })

  it("accepts an unconditional reusable-workflow job as executable", () => {
    const workflow = parseWorkflow("jobs:\n  delegated:\n    uses: owner/repo/.github/workflows/ci.yml@main\n")
    expect(workflow.jobs[0]).toMatchObject({
      id: "delegated",
      uses: "owner/repo/.github/workflows/ci.yml@main",
      runsOn: undefined,
      steps: []
    })
    expect(missingRequiredJobs(workflow, ["delegated"])).toEqual([])
  })

  it("refuses ambiguous block scalar indentation and unsupported explicit indentation", () => {
    expect(() =>
      parseWorkflow(
        "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo safe\n         pnpm run check\n"
      )
    ).toThrow(/block scalar content is indented less/)
    expect(() =>
      parseWorkflow(
        "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |2\n          pnpm run check\n"
      )
    ).toThrow(/explicit block-scalar indentation is not supported/)
  })

  it("does not reinterpret scalar-looking shell text as nested YAML", () => {
    const workflow = parseWorkflow(
      "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo safe\n          example: |2\n"
    )
    expect(workflow.jobs[0]!.steps[0]!.run).toContain("example: |2")
  })

  it("refuses YAML merges and inherited shell defaults it cannot verify", () => {
    expect(() =>
      parseWorkflow(
        "defaults:\n  run:\n    shell: python\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run check\n"
      )
    ).toThrow(/top-level "defaults" is not supported/)
    expect(() =>
      parseWorkflow(
        "jobs:\n  test:\n    <<: '*conditional'\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run check\n"
      )
    ).toThrow(/"<<" in job/)
    expect(() =>
      parseWorkflow(
        "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - <<: '*conditional'\n        run: pnpm run check\n"
      )
    ).toThrow(/YAML merge in a step/)
  })

  it("bounds direct parser input as well as filesystem reads", () => {
    expect(() => parseStrictWorkflow(`on: push\n#${"x".repeat(maximumWorkflowBytes)}\njobs:\n`))
      .toThrow(/larger than/)
  })

  it("reads jobs, names, runners, and step commands", () => {
    const workflow = parseWorkflow(
      [
        "name: CI",
        "on:",
        "  push:",
        "    branches: [main]",
        "jobs:",
        "  test:",
        "    name: check + test",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          node-version: 22.19.0",
        "      - name: Typecheck",
        "        run: pnpm run check",
        ""
      ].join("\n")
    )
    expect(workflow.name).toBe("CI")
    expect(workflow.jobs).toHaveLength(1)
    expect(workflow.jobs[0]!.id).toBe("test")
    expect(workflow.jobs[0]!.name).toBe("check + test")
    expect(workflow.jobs[0]!.runsOn).toBe("ubuntu-latest")
    expect(workflow.jobs[0]!.steps.map((step) => step.uses ?? step.run)).toEqual([
      "actions/checkout@v4",
      "actions/setup-node@v4",
      "pnpm run check"
    ])
  })

  it("reads a block scalar as the step's whole script", () => {
    const workflow = parseWorkflow(
      [
        "jobs:",
        "  pack:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: Pack",
        "        env:",
        "          PACK_DIR: /tmp/packs",
        "        run: |",
        "          node scripts/pack-release.mjs \"$PACK_DIR\"",
        "",
        "          node scripts/smoke-release.mjs \"$PACK_DIR\"",
        ""
      ].join("\n")
    )
    const run = workflow.jobs[0]!.steps[0]!.run
    expect(run).toContain("node scripts/pack-release.mjs")
    expect(run).toContain("node scripts/smoke-release.mjs")
    // Indentation comes off the first content line, so the script is not
    // silently shifted by the depth its step happens to sit at.
    expect(run!.split("\n")[0]).toBe("node scripts/pack-release.mjs \"$PACK_DIR\"")
  })

  it("does not invent command boundaries while reading a folded block scalar", () => {
    const workflow = parseWorkflow(
      [
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: >",
        "          echo harmless",
        "          pnpm run check",
        "      - run: >",
        "          pnpm run lint",
        "          --silent",
        ""
      ].join("\n")
    )
    expect(workflow.jobs[0]!.steps[0]!.run).toBe("echo harmless pnpm run check")
    expect(missingGates(workflow, [{ name: "typecheck", command: "pnpm run check" }]).map((gate) => gate.name))
      .toEqual(["typecheck"])
    expect(missingGates(workflow, [{ name: "lint", command: "pnpm run lint" }])).toEqual([])
  })

  it("decodes quoted YAML before scanning its shell command boundaries", () => {
    const workflow = parseWorkflow(
      [
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: \"echo \\u0022; pnpm run check\\u0022\"",
        "      - run: 'echo ''; pnpm run lint'''",
        ""
      ].join("\n")
    )
    expect(workflow.jobs[0]!.steps.map((step) => step.run)).toEqual([
      "echo \"; pnpm run check\"",
      "echo '; pnpm run lint'"
    ])
    expect(
      missingGates(workflow, [
        { name: "typecheck", command: "pnpm run check" },
        { name: "lint", command: "pnpm run lint" }
      ]).map((gate) => gate.name)
    ).toEqual(["typecheck", "lint"])
    // YAML-only escape forms are refused rather than decoded as a different
    // shell program by this intentionally smaller scalar decoder.
    expect(() =>
      parseWorkflow(
        "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: \"echo \\x22; pnpm run check\\x22\"\n"
      )
    ).toThrow(/unsupported double-quoted scalar/)
  })

  it("keeps a `#` that is not a comment and drops one that is", () => {
    const workflow = parseWorkflow(
      [
        "jobs:",
        "  a:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      # a whole-line comment",
        "      - run: echo \"a#b\" # trailing comment",
        ""
      ].join("\n")
    )
    expect(workflow.jobs[0]!.steps[0]!.run).toBe("echo \"a#b\"")
  })

  it("reads a block sequence written at its key's own indentation", () => {
    // YAML allows a sequence to sit at the indentation of the key that owns
    // it, which is how `needs:` and `steps:` are most often written. Reading
    // it by indentation alone left `steps` empty (every gate in the job then
    // reported missing) and refused a `needs:` list outright.
    const workflow = parseWorkflow(
      [
        "name: CI",
        "on:",
        "  push:",
        "    branches:",
        "    - main",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "    - uses: actions/checkout@v4",
        "    - name: Typecheck",
        "      run: pnpm run check",
        "  gate:",
        "    runs-on: ubuntu-latest",
        "    needs:",
        "    - build",
        "    steps:",
        "    - run: cargo test --locked",
        ""
      ].join("\n")
    )
    expect(workflow.name).toBe("CI")
    expect(workflow.jobs.map((job) => job.id)).toEqual(["build", "gate"])
    expect(workflow.jobs[0]!.steps.map((step) => step.uses ?? step.run)).toEqual([
      "actions/checkout@v4",
      "pnpm run check"
    ])
    expect(workflow.jobs[1]!.steps.map((step) => step.run)).toEqual(["cargo test --locked"])
    expect(missingGates(workflow, [
      { name: "typecheck", command: "pnpm run check", job: "build" },
      { name: "rust", command: "cargo test --locked", job: "gate" }
    ])).toEqual([])
  })

  it("refuses tab indentation instead of guessing at the structure", () => {
    expect(() => parseWorkflow("jobs:\n\ta:\n")).toThrow(WorkflowParseError)
  })

  it("refuses duplicate job ids instead of reporting a job GitHub will not run", () => {
    // YAML keeps the last duplicate key, so the first `a` never runs. A gate
    // pinned to `a` would otherwise match the shadowed steps.
    expect(() =>
      parseWorkflow(
        [
          "jobs:",
          "  a:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: pnpm run check",
          "  a:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo skipped",
          ""
        ].join("\n")
      )
    ).toThrow(/duplicate job id "a"/)
  })

  it("refuses a duplicate top-level key, which shadows a whole jobs mapping", () => {
    // The second `jobs:` is the one GitHub runs, so a gate matched against
    // `a` would report present while nothing ran it.
    expect(() =>
      parseWorkflow(
        [
          "name: CI",
          "jobs:",
          "  a:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: pnpm run check",
          "jobs:",
          "  b:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo only-this-runs",
          ""
        ].join("\n")
      )
    ).toThrow(/duplicate top-level key "jobs"/)
  })

  it("refuses a duplicate key inside one job", () => {
    expect(() =>
      parseWorkflow(
        [
          "jobs:",
          "  a:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: pnpm run check",
          "    steps:",
          "      - run: echo only-this-runs",
          ""
        ].join("\n")
      )
    ).toThrow(/duplicate key "steps" in job "a"/)
  })

  it("refuses a duplicate key inside one step", () => {
    expect(() =>
      parseWorkflow(
        [
          "jobs:",
          "  a:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - name: s",
          "        run: pnpm run check",
          "        run: echo only-this-runs",
          ""
        ].join("\n")
      )
    ).toThrow(/duplicate key "run" in a step of job "a"/)
  })

  /**
   * `"test":` and `test:` are the same YAML key. Reading the quoted spelling
   * literally invented a job id nothing could match, so a gate and a required
   * job pinned to `test` both reported missing against a workflow that runs
   * them — and the duplicate-key check no longer saw the two spellings as one
   * key. Quoting is also how the renderer keeps an id such as `no` a string.
   */
  it("reads a quoted job id and a quoted step key as the key they are", () => {
    const quoted = parseWorkflow(
      [
        "jobs:",
        "  \"no\":",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - \"name\": Typecheck",
        "        \"run\": pnpm run check",
        ""
      ].join("\n")
    )
    expect(quoted.jobs.map((job) => job.id)).toEqual(["no"])
    expect(quoted.jobs[0]!.steps[0]!.name).toBe("Typecheck")
    expect(missingGates(quoted, [{ name: "typecheck", command: "pnpm run check", job: "no" }])).toEqual([])
    expect(missingRequiredJobs(quoted, ["no"])).toEqual([])
  })

  it("refuses a job id repeated in its other spelling", () => {
    expect(() =>
      parseWorkflow(
        [
          "jobs:",
          "  test:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: pnpm run check",
          "  \"test\":",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo only-this-runs",
          ""
        ].join("\n")
      )
    ).toThrow(/duplicate job id "test"/)
  })

  it("refuses a line that is not a mapping entry", () => {
    expect(() => parseWorkflow("jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - bare\n"))
      .toThrow(WorkflowParseError)
  })

  it("parses the flows repository's own pipeline", async () => {
    const source = await readReal()
    if (source === undefined) return
    const workflow = parseWorkflow(source)
    expect(workflow.name).toBe("CI")
    expect(workflow.jobs.map((job) => job.id)).toEqual([
      "test",
      "rust",
      "wasm-repro",
      "bun",
      "browser",
      "node-macos",
      "node-windows"
    ])
    // Every job has at least a checkout, so no job parsed as empty.
    for (const job of workflow.jobs) expect(job.steps.length).toBeGreaterThan(0)
  })

  /**
   * The real contract, and the proof that it is not vacuously green: the same
   * file with one required job made conditional IN MEMORY is reported broken.
   * Nothing is written.
   */
  it("holds the flows pipeline's required jobs to running unconditionally", async () => {
    const source = await readReal()
    if (source === undefined) return
    const required = ["test", "rust", "wasm-repro", "bun", "browser", "node-macos", "node-windows"]
    expect(missingRequiredJobs(parseWorkflow(source), required)).toEqual([])
    const skipped = source.replace(/^ {2}bun:$/m, "  bun:\n    if: false")
    expect(skipped).not.toBe(source)
    expect(missingRequiredJobs(parseWorkflow(skipped), required)).toEqual(["bun (conditional)"])
    // The gate pinned to that job goes with it.
    expect(
      missingGates(parseWorkflow(skipped), [
        { name: "bun suites", command: "bun node_modules/vitest/vitest.mjs run", job: "bun" }
      ]).map((gate) => gate.name)
    ).toEqual(["bun suites"])
  })

  /**
   * A gate contract proves a COMMAND STRING is still in the pipeline. It
   * cannot prove the command still exists, so a renamed script leaves a green
   * contract in front of a red pipeline. This closes that gap for the real
   * repository: every `pnpm run <script>` a step invokes must be a script in
   * the root manifest, and every `node <file>` must be a file on disk.
   */
  it("runs only scripts and files the flows repository actually has", async () => {
    const source = await readReal()
    if (source === undefined) return
    const manifest = JSON.parse(
      await Fs.readFile(NodePath.resolve(realWorkflowPath, "../../../package.json"), "utf8")
    ) as { readonly scripts?: Readonly<Record<string, string>> }
    const scripts = new Set(Object.keys(manifest.scripts ?? {}))
    const commands = parseWorkflow(source).jobs
      .flatMap((job) => job.steps)
      .flatMap((step) => step.run === undefined ? [] : [step.run])
      .join("\n")

    // `pnpm --recursive run build` runs a PACKAGE script, so it is satisfied
    // by any workspace member; a bare `pnpm run check` needs the root one.
    const workspaceScripts = new Set<string>()
    const root = NodePath.resolve(realWorkflowPath, "../../..")
    for (const entry of await Fs.readdir(NodePath.join(root, "packages"))) {
      const manifestPath = NodePath.join(root, "packages", entry, "package.json")
      const text = await Fs.readFile(manifestPath, "utf8").catch(() => undefined)
      if (text === undefined) continue
      const parsed = JSON.parse(text) as { readonly scripts?: Readonly<Record<string, string>> }
      for (const script of Object.keys(parsed.scripts ?? {})) workspaceScripts.add(script)
    }

    const invocations = [
      ...commands.matchAll(/\bpnpm ([^\n]*?)run ([\w:-]+)/g),
      ...commands.matchAll(/\bpnpm (--recursive |)(test)\b/g)
    ].map((match) => ({ recursive: /(^|\s)(-r|--recursive|--filter)(\s|=|$)/.test(match[1]!), script: match[2]! }))
    expect(invocations.length).toBeGreaterThan(0)
    expect(
      invocations
        .filter(({ recursive, script }) => !(recursive ? workspaceScripts : scripts).has(script))
        .map(({ script }) => script)
    ).toEqual([])

    const invokedFiles = [...commands.matchAll(/\bnode (?:--test )?([\w./-]+\.(?:mjs|js|cjs))/g)]
      .map((match) => match[1]!)
    expect(invokedFiles.length).toBeGreaterThan(0)
    const missing: Array<string> = []
    for (const file of [...new Set(invokedFiles)]) {
      const absolute = NodePath.resolve(realWorkflowPath, "../../..", file)
      const present = await Fs.stat(absolute).then(() => true, () => false)
      if (!present) missing.push(file)
    }
    expect(missing).toEqual([])
  })
})

describe("missingGates", () => {
  const workflow = parseWorkflow(
    [
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: pnpm run check",
      "      - run: pnpm run lint",
      "  rust:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: cargo test --locked",
      ""
    ].join("\n")
  )

  it("reports nothing when every gate is present", () => {
    expect(missingGates(workflow, [
      { name: "typecheck", command: "pnpm run check" },
      { name: "rust test", command: "cargo test --locked", job: "rust" }
    ])).toEqual([])
  })

  it("reports a gate that no step runs", () => {
    expect(
      missingGates(workflow, [{ name: "circular", command: "pnpm run circular" }])
        .map((gate) => gate.name)
    ).toEqual(["circular"])
  })

  it("reports a gate whose only occurrence is commented out", () => {
    // The step still exists and the text is still in the file, but nothing
    // runs the command, so the contract must fail rather than pass on prose.
    const commented = parseWorkflow(
      [
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: |",
        "          # pnpm run circular is disabled while the graph is fixed",
        "          echo skipped",
        ""
      ].join("\n")
    )
    expect(commented.jobs[0]!.steps[0]!.run).toContain("# pnpm run circular")
    expect(
      missingGates(commented, [{ name: "circular", command: "pnpm run circular" }]).map((gate) => gate.name)
    ).toEqual(["circular"])
  })

  it("keeps matching a real command in a multiline script that also has comments", () => {
    const script = parseWorkflow(
      [
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: |",
        "          # the guard below is required",
        "          pnpm run circular",
        "          echo \"done # not a comment\"",
        ""
      ].join("\n")
    )
    expect(missingGates(script, [{ name: "circular", command: "pnpm run circular" }])).toEqual([])
    // A `#` inside a quoted word is not a comment, so the echo argument
    // survives the comment strip — but it is DATA, not a command, so it does
    // not satisfy a gate. Only the `echo` that runs it would.
    expect(script.jobs[0]!.steps[0]!.run).toContain("done # not a comment")
    expect(missingGates(script, [{ name: "echo", command: "done # not a comment" }]).map((gate) => gate.name))
      .toEqual(["echo"])
    expect(missingGates(script, [{ name: "echo", command: "echo" }])).toEqual([])
  })

  it("still matches a `uses` gate, which has no shell comments to strip", () => {
    const actions = parseWorkflow(
      ["jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v4", ""]
        .join("\n")
    )
    expect(missingGates(actions, [{ name: "checkout", command: "actions/checkout@v4" }])).toEqual([])
  })

  it("does not count command text assigned to a non-shell or dynamic shell", () => {
    const workflow = parseWorkflow(
      [
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: pnpm run check",
        "        shell: python",
        "      - run: pnpm run lint",
        "        shell: ${{ matrix.shell }}",
        "      - run: pnpm run circular",
        "        shell: bash",
        ""
      ].join("\n")
    )
    expect(
      missingGates(workflow, [
        { name: "typecheck", command: "pnpm run check" },
        { name: "lint", command: "pnpm run lint" },
        { name: "circular", command: "pnpm run circular" }
      ]).map((gate) => gate.name)
    ).toEqual(["typecheck", "lint"])
  })

  it("reports a gate that runs in the wrong job", () => {
    // `pnpm run check` exists, but not in the `rust` job, which is what a
    // platform-pinned gate (macOS, Windows, Bun) has to assert.
    expect(
      missingGates(workflow, [{ name: "typecheck on rust", command: "pnpm run check", job: "rust" }])
        .map((gate) => gate.name)
    ).toEqual(["typecheck on rust"])
  })

  /**
   * A gate proves a command RUNS. Substring matching proved only that the text
   * was somewhere in a script, so every script below satisfied a
   * `pnpm run check` gate while running no typecheck at all.
   */
  it("refuses text that is not a command the shell would run", () => {
    const gate = [{ name: "typecheck", command: "pnpm run check" }]
    const scripts = [
      // The command is an ARGUMENT, so the shell prints it and runs nothing.
      "echo pnpm run check",
      "printf '%s\\n' \"pnpm run check\"",
      // Quoted data, including data that carries its own separators.
      "echo \"first; pnpm run check\"",
      "echo 'pnpm run check && pnpm run lint'",
      // A longer command name that merely starts with the gate.
      "pnpm run checkall",
      // A longer command name that merely ends with it.
      "xpnpm run check",
      // The gate as the tail of a flag value.
      "pnpm run build --script=pnpm run check",
      // A here-doc body is data, not commands.
      "cat <<'EOF'\npnpm run check\nEOF",
      // A function declaration defers its body; declaring it runs nothing.
      "check() { pnpm run check; }",
      "function check { pnpm run check; }",
      "check() { echo deferred; }pnpm run check",
      // An escaped separator is an argument, so it opens no second command.
      "echo \\; pnpm run check",
      "echo a\\;pnpm run check"
    ]
    for (const script of scripts) {
      const parsed = parseWorkflow(
        ["jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - run: |"]
          .concat(script.split("\n").map((line) => `          ${line}`))
          .concat("")
          .join("\n")
      )
      expect(parsed.jobs[0]!.steps[0]!.run).toContain("pnpm run check")
      expect({ script, missing: missingGates(parsed, gate).map((entry) => entry.name) })
        .toEqual({ script, missing: ["typecheck"] })
    }
  })

  it("matches a real command wherever the shell would start one", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      // The plain case, and the same command carrying extra flags.
      ["pnpm run check", "pnpm run check"],
      ["pnpm install --frozen-lockfile --ignore-scripts", "pnpm install --frozen-lockfile"],
      // After `if`, after `!`, and with a trailing `;` — the shape the flows
      // pipeline's wasm byte-comparison uses.
      ["if ! cmp \"$A\" b; then\n  exit 1\nfi", "cmp"],
      // After `&&`, inside a subshell, inside a loop body.
      ["for pkg in a b; do\n  (cd \"packages/$pkg\" && bun x.mjs run --coverage.enabled=false)\ndone", "bun x.mjs run"],
      // After `;`, after `|`, and on a later line of a multiline script.
      ["true; pnpm run lint", "pnpm run lint"],
      ["check() { echo deferred; }\npnpm run check", "pnpm run check"],
      ["cat log | pnpm run lint", "pnpm run lint"],
      [
        "find . -name dist -exec rm -rf {} +\npnpm --recursive --if-present run build",
        "pnpm --recursive --if-present run build"
      ],
      // A `NAME=value` prefix still leaves a command behind it.
      ["CI=1 pnpm test", "pnpm test"],
      // A redirection ends the command word.
      ["pnpm run check >log 2>&1", "pnpm run check"]
    ]
    for (const [script, command] of cases) {
      const parsed = parseWorkflow(
        ["jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - run: |"]
          .concat(script.split("\n").map((line) => `          ${line}`))
          .concat("")
          .join("\n")
      )
      expect({ script, missing: missingGates(parsed, [{ name: command, command }]).map((gate) => gate.name) })
        .toEqual({ script, missing: [] })
    }
  })

  it("refuses a `uses` value that merely contains the action a gate names", () => {
    const actions = parseWorkflow(
      [
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: evil-org/actions/checkout@v4",
        "      - uses: actions/setup-node@v4",
        ""
      ].join("\n")
    )
    // A different action whose name ends with the gate's is not the gate's.
    expect(missingGates(actions, [{ name: "checkout", command: "actions/checkout@v4" }]).map((gate) => gate.name))
      .toEqual(["checkout"])
    // Nor is a prefix of a pinned reference.
    expect(missingGates(actions, [{ name: "node", command: "actions/setup-node@v" }]).map((gate) => gate.name))
      .toEqual(["node"])
    // An unversioned gate matches the same action at any version.
    expect(missingGates(actions, [{ name: "node", command: "actions/setup-node" }])).toEqual([])
  })

  /**
   * A conditional job or step is one GitHub may skip. Reading `if:` at all is
   * new: the scanner used to drop it, so `if: false` satisfied a required job
   * and a required gate while the pipeline ran neither.
   */
  it("refuses a conditional job or step as proof of an unconditional gate", () => {
    const conditional = parseWorkflow(
      [
        "jobs:",
        "  skipped:",
        "    runs-on: ubuntu-latest",
        "    if: false",
        "    steps:",
        "      - run: pnpm run check",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: Lint",
        "        if: ${{ github.event_name == 'push' }}",
        "        run: pnpm run lint",
        "      - name: Circular",
        "        if: true",
        "        run: pnpm run circular",
        ""
      ].join("\n")
    )
    expect(conditional.jobs[0]!.condition).toBe("false")
    expect(conditional.jobs[1]!.steps[0]!.condition).toBe("${{ github.event_name == 'push' }}")
    expect(
      missingGates(conditional, [
        { name: "typecheck", command: "pnpm run check" },
        { name: "lint", command: "pnpm run lint", job: "test" }
      ]).map((gate) => gate.name)
    ).toEqual(["typecheck", "lint"])
    // The one narrowly provable literal still counts.
    expect(missingGates(conditional, [{ name: "circular", command: "pnpm run circular", job: "test" }])).toEqual([])
  })

  /**
   * A backslash-newline is a line continuation: the shell joins the two lines
   * and reads the words after `&& \` as a command. Treating it as an ordinary
   * escape cancelled the pending command position, so this ordinary
   * multiline-script shape reported a gate the pipeline does run as missing.
   */
  it("follows a backslash line continuation to the command it starts", () => {
    const continued = parseWorkflow(
      [
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: |",
        "          corepack enable && \\",
        "            pnpm run check",
        "      - run: |",
        "          echo skipping \\",
        "            pnpm run lint",
        ""
      ].join("\n")
    )
    expect(missingGates(continued, [{ name: "typecheck", command: "pnpm run check" }])).toEqual([])
    // A continuation does not INVENT a command: the second script's words are
    // arguments to `echo`, so they still prove nothing runs.
    expect(missingGates(continued, [{ name: "lint", command: "pnpm run lint" }]).map((gate) => gate.name))
      .toEqual(["lint"])
  })

  it("keeps `continue-on-error` advisory, which the real pipeline's platform lanes rely on", () => {
    // A gate asserts that a command still RUNS, not that its failure blocks a
    // merge. Reading the value keeps it available without changing that.
    const advisory = parseWorkflow(
      [
        "jobs:",
        "  node-macos:",
        "    runs-on: macos-latest",
        "    continue-on-error: true",
        "    steps:",
        "      - run: pnpm test",
        ""
      ].join("\n")
    )
    expect(advisory.jobs[0]!.continueOnError).toBe("true")
    expect(missingGates(advisory, [{ name: "macOS node suite", command: "pnpm test", job: "node-macos" }]))
      .toEqual([])
  })
})

/**
 * A required job is required to RUN. The contract used to ask only whether the
 * id existed, so `if: false` on a required job satisfied it while GitHub
 * skipped the job entirely — the same defect the gate check had, one level up.
 */
describe("missingRequiredJobs", () => {
  const workflow = parseWorkflow(
    [
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: pnpm run check",
      "  browser:",
      "    runs-on: ubuntu-latest",
      "    if: false",
      "    steps:",
      "      - run: pnpm run browser",
      "  rust:",
      "    runs-on: ubuntu-latest",
      "    if: ${{ github.event_name == 'push' }}",
      "    steps:",
      "      - run: cargo test --locked",
      "  wasm-repro:",
      "    runs-on: ubuntu-latest",
      "    if: true",
      "    steps:",
      "      - run: cmp a b",
      ""
    ].join("\n")
  )

  it("reports nothing for an unconditional required job", () => {
    expect(missingRequiredJobs(workflow, ["test"])).toEqual([])
    // The one narrowly provable literal counts here too.
    expect(missingRequiredJobs(workflow, ["wasm-repro"])).toEqual([])
  })

  it("reports a required job that carries a condition, saying which it is", () => {
    expect(missingRequiredJobs(workflow, ["browser", "rust"]))
      .toEqual(["browser (conditional)", "rust (conditional)"])
  })

  it("still reports a required job the workflow never defines", () => {
    expect(missingRequiredJobs(workflow, ["bun"])).toEqual(["bun"])
  })

  it("keeps `continue-on-error` out of it, as the gate contract does", () => {
    const advisory = parseWorkflow(
      [
        "jobs:",
        "  node-macos:",
        "    runs-on: macos-latest",
        "    continue-on-error: true",
        "    steps:",
        "      - run: pnpm test",
        ""
      ].join("\n")
    )
    expect(missingRequiredJobs(advisory, ["node-macos"])).toEqual([])
  })
})

describe("supported lockfile installs", () => {
  it("accepts every documented lockfile install", () => {
    for (const command of supportedInstallCommands) expect(isSupportedInstall(command)).toBe(true)
  })

  it("accepts extra flags on a supported install", () => {
    expect(isSupportedInstall("pnpm install --frozen-lockfile --ignore-scripts")).toBe(true)
  })

  it("refuses installs that do not respect a lockfile", () => {
    expect(isSupportedInstall("pnpm install")).toBe(false)
    expect(isSupportedInstall("npm install")).toBe(false)
    // The shape the old generator emitted as its entire pipeline.
    expect(isSupportedInstall("pnpm dlx tsflows ci //...")).toBe(false)
    expect(isSupportedInstall("pnpm install --frozen-lockfile-ish")).toBe(false)
    expect(isSupportedInstall("pnpm install --frozen-lockfile && curl example.test")).toBe(false)
  })

  /**
   * Every command below is syntactically a lockfile install, and every one of
   * them leaves the workspace without the dev dependency the pinned tsflows CLI
   * lives in. They used to pass, so the install gate was satisfied by a job
   * whose next step could only fail.
   */
  it("refuses a flag that can omit the dependencies the lockfile pins", () => {
    for (
      const command of [
        // Writes a lockfile and installs nothing at all.
        "pnpm install --frozen-lockfile --lockfile-only",
        // Drop the dev dependencies, four spellings.
        "pnpm install --frozen-lockfile --prod",
        "pnpm install --frozen-lockfile --production",
        "npm ci --omit=dev",
        "bun install --frozen-lockfile --production",
        // Install a slice of the workspace instead of the workspace.
        "pnpm install --frozen-lockfile --filter=@scope/app",
        "npm ci --workspace=packages/app",
        "yarn install --immutable --mode=update-lockfile",
        // Skip optional dependencies a pinned tool may need.
        "pnpm install --frozen-lockfile --no-optional",
        // An unknown flag is refused rather than guessed at.
        "pnpm install --frozen-lockfile --some-future-flag"
      ]
    ) {
      expect({ command, supported: isSupportedInstall(command) }).toEqual({ command, supported: false })
    }
    // The flags the real pipeline uses, and their neighbours, still pass.
    for (
      const command of [
        "pnpm install --frozen-lockfile --ignore-scripts",
        "pnpm install --frozen-lockfile --ignore-scripts --prefer-offline",
        "pnpm install --frozen-lockfile --reporter=silent",
        "npm ci --ignore-scripts --no-audit --no-fund",
        "yarn install --immutable --immutable-cache",
        "bun install --frozen-lockfile --ignore-scripts"
      ]
    ) {
      expect({ command, supported: isSupportedInstall(command) }).toEqual({ command, supported: true })
    }
  })

  it("binds every supported install to a workspace-binary runner", () => {
    expect(workspaceExec("pnpm install --frozen-lockfile --ignore-scripts")).toBe("pnpm exec")
    expect(workspaceExec("npm ci")).toBe("npm exec --no-install --")
    expect(workspaceExec("yarn install --immutable")).toBe("yarn run")
    expect(workspaceExec("bun install --frozen-lockfile")).toBe("bun run")
    // None of them may fetch from a registry.
    for (const command of supportedInstallCommands) {
      expect(workspaceExec(command)).toBeDefined()
      expect(workspaceExec(command)).not.toMatch(/dlx|npx|bunx/)
    }
    expect(workspaceExec("pnpm install")).toBeUndefined()
  })
})

describe("performsInstall", () => {
  it("accepts the install as a command, alone or with extra flags", () => {
    expect(performsInstall("pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile")).toBe(true)
    expect(performsInstall("pnpm install --frozen-lockfile --ignore-scripts", "pnpm install --frozen-lockfile"))
      .toBe(true)
    expect(performsInstall("corepack enable\npnpm install --frozen-lockfile\n", "pnpm install --frozen-lockfile"))
      .toBe(true)
  })

  it("refuses text that never runs the install", () => {
    expect(performsInstall("# pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile")).toBe(false)
    expect(performsInstall("echo pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile")).toBe(false)
    expect(performsInstall("pnpm install", "pnpm install --frozen-lockfile")).toBe(false)
    expect(
      performsInstall("install() { pnpm install --frozen-lockfile; }", "pnpm install --frozen-lockfile")
    ).toBe(false)
  })

  it("holds the actual line to the same flag policy as the declared install", () => {
    // The line starts with the declared install, so a prefix check accepted it,
    // and it installs none of the dev dependencies the pinned CLI lives in.
    expect(performsInstall("pnpm install --frozen-lockfile --prod", "pnpm install --frozen-lockfile")).toBe(false)
    expect(performsInstall("pnpm install --frozen-lockfile --lockfile-only", "pnpm install --frozen-lockfile"))
      .toBe(false)
    expect(performsInstall("npm ci --omit=dev", "npm ci")).toBe(false)
    // A declared install that is itself unsupported is performed by nothing.
    expect(performsInstall("pnpm install --frozen-lockfile --prod", "pnpm install --frozen-lockfile --prod"))
      .toBe(false)
  })

  /**
   * The install has to be a command the shell RUNS, on the same boundary rule
   * a gate uses. Every script here has the install on a line of its own and
   * installs nothing: a here-document body and a quoted block are data another
   * command receives. They used to satisfy the install requirement, which is a
   * rendered pipeline whose next step can only fail.
   */
  it("refuses an install that is data rather than a command", () => {
    for (
      const script of [
        "cat <<'EOF' > notes.txt\npnpm install --frozen-lockfile\nEOF",
        "cat <<EOF\npnpm install --frozen-lockfile\nEOF",
        "echo \"\npnpm install --frozen-lockfile\n\"",
        "echo '\npnpm install --frozen-lockfile\n'"
      ]
    ) {
      expect({ script, performs: performsInstall(script, "pnpm install --frozen-lockfile") })
        .toEqual({ script, performs: false })
    }
  })

  it("accepts an install the shell runs beside another command", () => {
    for (
      const script of [
        "corepack enable; pnpm install --frozen-lockfile",
        "corepack enable && pnpm install --frozen-lockfile",
        "corepack enable && \\\n  pnpm install --frozen-lockfile --ignore-scripts",
        "pnpm install --frozen-lockfile && pnpm run check",
        "CI=1 pnpm install --frozen-lockfile",
        // A continuation INSIDE the install: the shell removes it before it
        // reads the words, so the flag policy reads the same words.
        "pnpm install --frozen-lockfile \\\n  --ignore-scripts"
      ]
    ) {
      expect({ script, performs: performsInstall(script, "pnpm install --frozen-lockfile") })
        .toEqual({ script, performs: true })
    }
    // The flag policy still applies to the whole command, wherever it starts
    // and however it is wrapped.
    expect(
      performsInstall("corepack enable && pnpm install --frozen-lockfile --prod", "pnpm install --frozen-lockfile")
    )
      .toBe(false)
    expect(performsInstall("pnpm install --frozen-lockfile \\\n  --prod", "pnpm install --frozen-lockfile"))
      .toBe(false)
  })
})

describe("stripShellComments", () => {
  it("removes comments without touching commands or expressions", () => {
    expect(stripShellComments("pnpm run check # typecheck")).toBe("pnpm run check ")
    expect(stripShellComments("echo \"a # b\"")).toBe("echo \"a # b\"")
    expect(stripShellComments("echo ${{ github.ref }}")).toBe("echo ${{ github.ref }}")
    expect(stripShellComments("echo $#")).toBe("echo $#")
    expect(stripShellComments("echo \"\\\"\" # after an escape")).toBe("echo \"\\\"\" ")
    expect(stripShellComments("a\n# b\nc")).toBe("a\n\nc")
  })
})

/** The golden pipeline `write` mode renders. */
const goldenAttrs = {
  workflowName: "CI",
  pushBranches: ["main"],
  pullRequest: true,
  workflowDispatch: true,
  cancelInProgress: true,
  install: "pnpm install --frozen-lockfile",
  requiredJobs: [],
  gates: [
    { name: "typecheck", command: "pnpm run check", job: "test" },
    { name: "lint", command: "pnpm run lint", job: "test" },
    { name: "circular", command: "pnpm run circular", job: "test" },
    { name: "browser", command: "pnpm run browser", job: "browser" },
    { name: "rust", command: "cargo test --locked", job: "rust" }
  ],
  jobs: [
    {
      id: "test",
      name: "check + test",
      runsOn: "ubuntu-latest",
      steps: [
        { uses: "actions/checkout@v4" },
        { uses: "actions/setup-node@v4", with: { "node-version": "22.19.0", cache: "pnpm" } },
        { run: "pnpm install --frozen-lockfile --ignore-scripts" },
        { name: "Typecheck all workspaces", run: "pnpm run check" },
        { name: "Lint all workspaces", run: "pnpm run lint" },
        { name: "Circular-dependency guard", run: "pnpm run circular" },
        {
          name: "Pack",
          run: "node scripts/pack-release.mjs \"$DIR\"\nnode scripts/smoke-release.mjs \"$DIR\"",
          env: { DIR: "/tmp/packs" }
        }
      ]
    },
    {
      id: "browser",
      runsOn: "ubuntu-latest",
      timeoutMinutes: 10,
      steps: [{ name: "Browser bundle guard", run: "pnpm run browser" }]
    },
    {
      id: "rust",
      runsOn: "ubuntu-latest",
      continueOnError: false,
      steps: [{ name: "Test", run: "cargo test --locked" }]
    }
  ],
  output: ".github/workflows/generated.yml",
  mode: "write" as const
}

const golden = `name: CI
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    name: check + test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22.19.0
          cache: pnpm
      - run: pnpm install --frozen-lockfile --ignore-scripts
      - name: Typecheck all workspaces
        run: pnpm run check
      - name: Lint all workspaces
        run: pnpm run lint
      - name: Circular-dependency guard
        run: pnpm run circular
      - name: Pack
        run: |
          node scripts/pack-release.mjs "$DIR"
          node scripts/smoke-release.mjs "$DIR"
        env:
          DIR: "/tmp/packs"
      - run: pnpm exec tsflows ci '//...'
  browser:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Browser bundle guard
        run: pnpm run browser
  rust:
    runs-on: ubuntu-latest
    continue-on-error: false
    steps:
      - name: Test
        run: cargo test --locked
`

describe("render", () => {
  it("matches the golden multi-job pipeline byte for byte", () => {
    expect(render(GithubCiGen(goldenAttrs)[Rule.TargetTypeId].attrs as never)).toBe(golden)
  })

  it("renders output this module can read back", () => {
    const workflow = parseWorkflow(golden)
    expect(workflow.jobs.map((job) => job.id)).toEqual(["test", "browser", "rust"])
    expect(missingGates(workflow, goldenAttrs.gates)).toEqual([])
  })

  it("refuses to render a pipeline that drops a declared gate", () => {
    const attrs = GithubCiGen({
      ...goldenAttrs,
      gates: [...goldenAttrs.gates, { name: "wasm reproducibility", command: "node crates/flows-jj/build-wasm.mjs" }]
    })[Rule.TargetTypeId].attrs as never
    expect(() => render(attrs)).toThrow(/does not run wasm reproducibility/)
  })

  it("refuses an install command that does not respect a lockfile", () => {
    const attrs = GithubCiGen({ ...goldenAttrs, install: "pnpm dlx tsflows ci //..." })[Rule.TargetTypeId]
      .attrs as never
    expect(() => render(attrs)).toThrow(/not a supported lockfile install/)
  })

  it("refuses to render with no jobs declared", () => {
    const attrs = GithubCiGen({ ...goldenAttrs, jobs: [], gates: [] })[Rule.TargetTypeId].attrs as never
    expect(() => render(attrs)).toThrow(/at least one declared job/)
  })

  it("refuses to render an inert workflow with no trigger", () => {
    const attrs = GithubCiGen({
      ...goldenAttrs,
      pushBranches: [],
      pullRequest: false,
      workflowDispatch: false
    })[Rule.TargetTypeId].attrs as never
    expect(() => render(attrs)).toThrow(/at least one workflow trigger/)
  })

  it("runs the workspace-pinned CLI the install put in the tree, never a fetched one", () => {
    const rendered = render(GithubCiGen(goldenAttrs)[Rule.TargetTypeId].attrs as never)
    expect(rendered).toContain("      - run: pnpm exec tsflows ci '//...'\n")
    expect(rendered).not.toContain("dlx")
    // The install the CLI depends on is in the same job, ahead of it.
    const test = parseWorkflow(rendered).jobs[0]!
    const commands = test.steps.map((step) => step.run ?? step.uses ?? "")
    expect(commands.findIndex((command) => command.startsWith("pnpm install --frozen-lockfile")))
      .toBeLessThan(commands.indexOf("pnpm exec tsflows ci '//...'"))
  })

  it("follows the declared package manager into its own workspace runner", () => {
    const attrs = GithubCiGen({
      ...goldenAttrs,
      install: "npm ci",
      jobs: goldenAttrs.jobs.map((job) =>
        job.id !== "test" ? job : {
          ...job,
          steps: job.steps.map((step) =>
            step.run === "pnpm install --frozen-lockfile --ignore-scripts" ? { run: "npm ci" } : step
          )
        }
      )
    })[Rule.TargetTypeId].attrs as never
    expect(render(attrs)).toContain("      - run: npm exec --no-install -- tsflows ci '//...'\n")
  })

  it("refuses a job that runs tsflows without performing the declared install", () => {
    const attrs = GithubCiGen({
      ...goldenAttrs,
      jobs: goldenAttrs.jobs.map((job) =>
        job.id !== "test" ? job : {
          ...job,
          // The install survives only as a comment, which installs nothing.
          steps: job.steps.map((step) =>
            step.run === "pnpm install --frozen-lockfile --ignore-scripts"
              ? { run: "# pnpm install --frozen-lockfile\ntrue" }
              : step
          )
        }
      )
    })[Rule.TargetTypeId].attrs as never
    expect(() => render(attrs)).toThrow(/no step runs the declared install/)
  })

  it("refuses to render a workflow missing a declared required job", () => {
    const attrs = GithubCiGen({ ...goldenAttrs, requiredJobs: ["test", "wasm-repro"] })[Rule.TargetTypeId]
      .attrs as never
    expect(() => render(attrs)).toThrow(/missing required jobs: wasm-repro/)
  })

  it("refuses duplicate job ids rather than emitting a shadowed job", () => {
    const attrs = GithubCiGen({ ...goldenAttrs, jobs: [...goldenAttrs.jobs, goldenAttrs.jobs[2]!] })[
      Rule.TargetTypeId
    ].attrs as never
    expect(() => render(attrs)).toThrow(/duplicate job id "rust"/)
  })

  it("refuses job and step shapes GitHub Actions rejects", () => {
    const withJobs = (jobs: unknown): never =>
      GithubCiGen({ ...goldenAttrs, jobs: jobs as typeof goldenAttrs.jobs, gates: [] })[Rule.TargetTypeId]
        .attrs as never
    const step = { run: "pnpm install --frozen-lockfile" }
    expect(() => render(withJobs([{ id: "test", runsOn: "ubuntu-latest", steps: [] }])))
      .toThrow(/declares no steps/)
    expect(() => render(withJobs([{ id: "a b", runsOn: "ubuntu-latest", steps: [step] }])))
      .toThrow(/is not a valid job id/)
    expect(() =>
      render(withJobs([{
        id: "test",
        runsOn: "ubuntu-latest",
        steps: [step, { uses: "actions/checkout@v4", run: "echo both" }]
      }]))
    ).toThrow(/declares both uses and run/)
    expect(() => render(withJobs([{ id: "test", runsOn: "ubuntu-latest", steps: [step, { name: "Nothing" }] }])))
      .toThrow(/declares neither uses nor run/)
    expect(() =>
      render(withJobs([{
        id: "test",
        runsOn: "ubuntu-latest",
        steps: [step, { run: "echo hi", with: { "node-version": "22" } }]
      }]))
    ).toThrow(/with: on a run step/)
    expect(() =>
      render(withJobs([{
        id: "test",
        runsOn: "ubuntu-latest",
        steps: [{ ...step, env: { "not a name": "1" } }]
      }]))
    ).toThrow(/is not a valid with:\/env: name/)
  })

  it("quotes values that would otherwise change the shape of the YAML", () => {
    const attrs = GithubCiGen({
      ...goldenAttrs,
      workflowName: "CI: main",
      pushBranches: ["main", "release: next"],
      jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, runsOn: "${{ matrix.os }}" })
    })[Rule.TargetTypeId].attrs as never
    const rendered = render(attrs)
    expect(rendered).toContain("name: \"CI: main\"\n")
    expect(rendered).toContain("    branches: [main, \"release: next\"]\n")
    expect(rendered).toContain("    runs-on: \"${{ matrix.os }}\"\n")
    // A label set is a YAML sequence GitHub reads, so it is not quoted into
    // one nonexistent label.
    expect(
      render(
        GithubCiGen({
          ...goldenAttrs,
          jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, runsOn: "[self-hosted, linux]" })
        })[Rule.TargetTypeId].attrs as never
      )
    ).toContain("    runs-on: [self-hosted, linux]\n")
    // The renderer's own output still parses as the workflow it declared.
    expect(parseWorkflow(rendered).name).toBe("CI: main")
  })

  /**
   * Every attribute here is declared a string. A plain scalar that YAML
   * resolves to a boolean, null, a number, or a timestamp is a workflow that no
   * longer carries the declared value: `name: true` is the boolean `true`,
   * `branches: [null]` is an empty branch, and `runs-on: false` is a `runs-on`
   * GitHub rejects outright.
   */
  it("keeps every declared string a YAML string", () => {
    const ambiguous = ["true", "false", "null", "yes", "no", "on", "off", "y", "n", "~", "NULL", "Off"]
    for (const value of ambiguous) {
      const rendered = render(
        GithubCiGen({ ...goldenAttrs, gates: [], workflowName: value })[Rule.TargetTypeId].attrs as never
      )
      expect({ value, line: rendered.split("\n")[0] }).toEqual({ value, line: `name: ${JSON.stringify(value)}` })
    }
    // Numeric-looking names, branches, and runners, in the spellings a YAML
    // parser resolves: decimal, float, exponent, hex, octal, sexagesimal, and
    // the timestamp form.
    for (const value of ["22", "1.5", "1e5", "0x1A", "0777", "12:30", "2026-08-14", ".inf", "-1"]) {
      const rendered = render(
        GithubCiGen({
          ...goldenAttrs,
          gates: [],
          pushBranches: [value],
          jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, name: value })
        })[Rule.TargetTypeId].attrs as never
      )
      expect({ value, rendered: rendered.includes(`    branches: [${JSON.stringify(value)}]\n`) })
        .toEqual({ value, rendered: true })
      expect({ value, rendered: rendered.includes(`    name: ${JSON.stringify(value)}\n`) })
        .toEqual({ value, rendered: true })
    }
    // A runner that resolves to a boolean is a `runs-on` GitHub rejects.
    expect(
      render(
        GithubCiGen({
          ...goldenAttrs,
          jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, runsOn: "false" })
        })[Rule.TargetTypeId].attrs as never
      )
    ).toContain("    runs-on: \"false\"\n")
    // A reserved label inside a label SET resolves the same way and silently
    // drops out of the set, so it is quoted while its neighbours stay plain.
    expect(
      render(
        GithubCiGen({
          ...goldenAttrs,
          jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, runsOn: "[self-hosted, null]" })
        })[Rule.TargetTypeId].attrs as never
      )
    ).toContain("    runs-on: [self-hosted, \"null\"]\n")
    // Unambiguous values keep their unquoted form, byte for byte.
    const plain = render(GithubCiGen(goldenAttrs)[Rule.TargetTypeId].attrs as never)
    for (
      const line of [
        "name: CI\n",
        "    branches: [main]\n",
        "    runs-on: ubuntu-latest\n",
        "          node-version: 22.19.0\n",
        "          cache: pnpm\n",
        "      - uses: actions/checkout@v4\n"
      ]
    ) expect(plain).toContain(line)
  })

  /**
   * A KEY is declared a string just as a value is, and YAML resolves a plain
   * `no:`, `on:`, or `Y:` to a boolean. An unquoted ambiguous key renders a job
   * whose id is the boolean `false` and an environment variable the runner
   * never exports, so keys go through the same quoting rule as values.
   */
  it("keeps every declared key a YAML string", () => {
    const rendered = render(
      GithubCiGen({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "no",
          runsOn: "ubuntu-latest",
          steps: [
            { run: "pnpm install --frozen-lockfile", env: { NO: "1", ON: "2", Y: "3", DIR: "/tmp" } },
            { uses: "actions/setup-node@v4", with: { on: "x", "node-version": "22" } }
          ]
        }]
      })[Rule.TargetTypeId].attrs as never
    )
    for (
      const line of [
        "  \"no\":\n",
        "          \"NO\": \"1\"\n",
        "          \"ON\": \"2\"\n",
        "          \"Y\": \"3\"\n"
      ]
    ) {
      expect({ line, present: rendered.includes(line) }).toEqual({ line, present: true })
    }
    expect(rendered).toContain("          \"on\": x\n")
    // Unambiguous keys keep their unquoted form, byte for byte.
    expect(rendered).toContain("          DIR: \"/tmp\"\n")
    expect(rendered).toContain("          node-version: \"22\"\n")
    // A quoted job id reads back as the id it declared, so a gate or a
    // required job pinned to it still matches the render.
    expect(parseWorkflow(rendered).jobs.map((job) => job.id)).toEqual(["no"])
  })

  /**
   * `runs-on` is the one attribute whose declared string may be a YAML
   * sequence. Quoting a collection the label-set form does not cover turned it
   * into a single label no runner carries — a job that never picks up — so it
   * is refused instead.
   */
  it("refuses a runs-on collection it cannot render as the label set it declares", () => {
    const withRunner = (runsOn: string): never =>
      GithubCiGen({
        ...goldenAttrs,
        gates: [],
        jobs: [{ id: "test", runsOn, steps: [{ run: "pnpm install --frozen-lockfile" }] }]
      })[Rule.TargetTypeId].attrs as never
    for (const runsOn of ["[self-hosted, my label]", "{group: ubuntu, labels: [x]}", "[self-hosted,]", "[]"]) {
      expect(() => render(withRunner(runsOn))).toThrow(/is not a runner label set/)
    }
    // The forms it can render still render, and an expression is still a
    // quoted scalar GitHub evaluates.
    expect(render(withRunner("[self-hosted, linux]"))).toContain("    runs-on: [self-hosted, linux]\n")
    expect(render(withRunner("${{ matrix.os }}"))).toContain("    runs-on: \"${{ matrix.os }}\"\n")
  })

  it("refuses a timeout GitHub Actions does not run", () => {
    const withTimeout = (timeoutMinutes: number): unknown => ({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "test",
        runsOn: "ubuntu-latest",
        timeoutMinutes,
        steps: [{ run: "pnpm install --frozen-lockfile" }]
      }]
    })
    // The schema rejects an out-of-range value at declaration time.
    for (const timeout of [0, -1, 361, 1440, 1.5]) {
      expect(() => GithubCiGen(withTimeout(timeout) as typeof goldenAttrs)).toThrow()
    }
    // `render` is exported, so it checks again rather than trusting its input.
    const constructed = GithubCiGen(withTimeout(10) as typeof goldenAttrs)[Rule.TargetTypeId].attrs as Record<
      string,
      unknown
    >
    for (const timeout of [0, -1, 361, 1.5]) {
      expect(() =>
        render({
          ...constructed,
          jobs: [{
            id: "test",
            runsOn: "ubuntu-latest",
            timeoutMinutes: timeout,
            steps: [{ run: "pnpm install --frozen-lockfile" }]
          }]
        } as never)
      ).toThrow(/timeout-minutes/)
    }
    // The boundaries themselves render.
    for (const timeout of [1, 360]) {
      expect(render(GithubCiGen(withTimeout(timeout) as typeof goldenAttrs)[Rule.TargetTypeId].attrs as never))
        .toContain(`    timeout-minutes: ${timeout}\n`)
    }
  })

  it("refuses a kind set that would emit no tsflows step at all", () => {
    const attrs = GithubCiGen({ ...goldenAttrs, kinds: [] })[Rule.TargetTypeId].attrs as never
    expect(() => render(attrs)).toThrow(/at least one kind/)
  })

  it("refuses a kind the CLI has no command for", () => {
    // `run` is a `Rule.Kind` but not a `tsflows` command, so the step it would
    // render fails with COMMAND_NOT_FOUND on every push.
    const attrs = GithubCiGen({ ...goldenAttrs, kinds: ["build", "run"] })[Rule.TargetTypeId].attrs as never
    expect(() => render(attrs)).toThrow(/no tsflows command runs the kind "run"/)
  })

  /**
   * The generated step's verb has to exist. This reads the CLI's own command
   * table, so adding a kind the CLI never gained fails here rather than in
   * somebody's pipeline.
   */
  it("emits only verbs the CLI actually defines", async () => {
    const cli = await Fs.readFile(NodePath.resolve(import.meta.dirname, "../../tsflows-cli/src/Cli.ts"), "utf8")
    const commands = new Set([...cli.matchAll(/\.command\("([\w-]+)"/g)].map((match) => match[1]!))
    expect(commands.size).toBeGreaterThan(0)
    expect(executableKinds.filter((kind) => !commands.has(kind))).toEqual([])
    // The compact form of the default kind set.
    expect(commands.has("ci")).toBe(true)

    const emitted = new Set<string>()
    for (const kind of executableKinds) {
      const rendered = render(
        GithubCiGen({ ...goldenAttrs, kinds: [kind], gates: [] })[Rule.TargetTypeId].attrs as never
      )
      for (const [, verb] of rendered.matchAll(/pnpm exec tsflows ([\w-]+) /g)) emitted.add(verb!)
    }
    const compact = render(GithubCiGen(goldenAttrs)[Rule.TargetTypeId].attrs as never)
    for (const [, verb] of compact.matchAll(/pnpm exec tsflows ([\w-]+) /g)) emitted.add(verb!)
    expect([...emitted].filter((verb) => !commands.has(verb))).toEqual([])
  })

  it("refuses a control character that the shell would choke on", () => {
    // A CRLF script renders `pnpm install --frozen-lockfile\r`, which no shell
    // runs — and the install check trims the line, so it would have passed.
    const attrs = GithubCiGen({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "test",
        runsOn: "ubuntu-latest",
        steps: [{ run: "pnpm install --frozen-lockfile\r\npnpm run check" }]
      }]
    })[Rule.TargetTypeId].attrs as never
    expect(() => render(attrs)).toThrow(/control character/)
    const named = GithubCiGen({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "test",
        runsOn: "ubuntu-latest",
        name: "check\rtest",
        steps: [{ run: "pnpm install --frozen-lockfile" }]
      }]
    })[Rule.TargetTypeId].attrs as never
    expect(() => render(named)).toThrow(/control character/)
  })

  it("renders a blank script line blank, leaving no trailing whitespace", () => {
    const rendered = render(
      GithubCiGen({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "test",
          runsOn: "ubuntu-latest",
          steps: [{ run: "pnpm install --frozen-lockfile\n\npnpm run check" }]
        }]
      })[Rule.TargetTypeId].attrs as never
    )
    expect(rendered.split("\n").filter((line) => /\s$/.test(line))).toEqual([])
    // The blank line is still inside the script the parser reads back.
    expect(parseWorkflow(rendered).jobs[0]!.steps[0]!.run)
      .toBe("pnpm install --frozen-lockfile\n\npnpm run check")
  })

  it("refuses a pattern that would not survive being pasted into a shell", () => {
    const attrs = GithubCiGen({ ...goldenAttrs, pattern: "//... && curl example.test" })[Rule.TargetTypeId]
      .attrs as never
    expect(() => render(attrs)).toThrow(/is not a target pattern/)
  })

  /**
   * The generated tsflows step is the only step that runs the workspace's own
   * targets. `--help` made it a usage message that exits 0 — a green pipeline
   * that built and tested nothing — and `*` reached the runner's shell to be
   * expanded against the checkout.
   */
  it("refuses a pattern that is not the CLI's label grammar", () => {
    for (
      const pattern of [
        "--help",
        "-h",
        "*",
        "//*",
        "//packages/*",
        "//packages/*:build",
        "...",
        "packages/core",
        "//",
        "//..",
        "//packages/../../etc",
        "//packages//core",
        "//packages/core:",
        "//packages/core:a:b",
        "//packages/core:--help",
        "//packages/core build",
        "//packages/core;rm -rf /",
        "//packages/core'"
      ]
    ) {
      const attrs = GithubCiGen({ ...goldenAttrs, pattern })[Rule.TargetTypeId].attrs as never
      const message = (() => {
        try {
          render(attrs)
          return "rendered"
        } catch (cause) {
          return (cause as Error).message
        }
      })()
      expect({ pattern, refused: message.includes("is not a target pattern") }).toEqual({ pattern, refused: true })
    }
  })

  it("renders every supported pattern as one quoted shell word", () => {
    for (
      const pattern of ["//...", "//packages/...", "//packages/core", "//packages/core:build", "//:ci"]
    ) {
      const rendered = render(
        GithubCiGen({ ...goldenAttrs, pattern })[Rule.TargetTypeId].attrs as never
      )
      expect(rendered).toContain(`      - run: pnpm exec tsflows ci '${pattern}'\n`)
      // The step reads back as the declared command, with the quotes intact.
      const commands = parseWorkflow(rendered).jobs[0]!.steps.map((step) => step.run)
      expect(commands).toContain(`pnpm exec tsflows ci '${pattern}'`)
    }
  })

  it("maps cache secrets onto the CLI environment override and token variable", () => {
    const attrs = GithubCiGen({
      ...goldenAttrs,
      cacheUrlSecret: "REMOTE_CACHE_URL",
      cacheTokenSecret: "REMOTE_CACHE_TOKEN",
      cacheTokenEnv: "PROJECT_CACHE_TOKEN"
    })[Rule.TargetTypeId].attrs as never
    const rendered = render(attrs)
    expect(rendered).toContain(
      "          TSFLOWS_CACHE_URL: \"${{ secrets.REMOTE_CACHE_URL }}\"\n" +
        "          PROJECT_CACHE_TOKEN: \"${{ secrets.REMOTE_CACHE_TOKEN }}\""
    )
  })
})

describe("readWorkflowSource", () => {
  const withWorkspace = async (run: (root: string) => Promise<void>): Promise<void> => {
    const root = await Fs.mkdtemp(NodePath.join(tmpdir(), "tsflows-workflow-read-"))
    try {
      await run(root)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  }

  it("reads a bounded regular UTF-8 workflow exactly", async () => {
    await withWorkspace(async (root) => {
      const source = "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: []\n"
      await Fs.writeFile(NodePath.join(root, "ci.yml"), source)
      await expect(readWorkflowSource(root, "ci.yml")).resolves.toBe(source)
    })
  })

  it("refuses symlinks, invalid UTF-8, oversized files, and path escapes", async () => {
    await withWorkspace(async (root) => {
      await Fs.writeFile(NodePath.join(root, "target.yml"), "jobs: {}\n")
      await Fs.symlink("target.yml", NodePath.join(root, "link.yml"))
      await Fs.writeFile(NodePath.join(root, "invalid.yml"), Buffer.from([0xc3, 0x28]))
      await Fs.writeFile(NodePath.join(root, "large.yml"), Buffer.alloc(workflowSourceByteLimit + 1, 0x20))

      await expect(readWorkflowSource(root, "link.yml")).rejects.toThrow(/symbolic link/)
      await expect(readWorkflowSource(root, "invalid.yml")).rejects.toThrow()
      await expect(readWorkflowSource(root, "large.yml")).rejects.toThrow(/larger than/)
      await expect(readWorkflowSource(root, "../outside.yml")).rejects.toThrow(/escapes the workspace/)
    })
  })

  it.skipIf(process.platform === "win32")("refuses a FIFO without waiting for a writer", async () => {
    await withWorkspace(async (root) => {
      const fifo = NodePath.join(root, "ci.yml")
      const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" })
      expect(made.status, made.stderr).toBe(0)
      await expect(readWorkflowSource(root, "ci.yml")).rejects.toThrow(/not a regular file/)
    })
  })
})

describe("GithubCiGen rule wiring", () => {
  const contractAttrs = {
    workflowName: "CI",
    pushBranches: ["main"],
    pullRequest: true,
    workflowDispatch: true,
    cancelInProgress: true,
    jobs: [],
    requiredJobs: ["test"],
    gates: [{ name: "typecheck", command: "pnpm run check", job: "test" }],
    output: ".github/workflows/ci.yml"
  }

  it("defaults to the non-mutating contract mode", () => {
    const metadata = Rule.metadata(GithubCiGen(contractAttrs) as never)
    expect((metadata.attrs as { readonly mode: string }).mode).toBe("contract")
    // The workflow file is a declared input, so editing it re-keys the target.
    expect(metadata.inputs.map((input) => (input as { readonly path: string }).path))
      .toContain("//.github/workflows/ci.yml")
    expect(metadata.cacheable).toBe(true)
  })

  it("maps the lint verb of a writing target to the checking form", () => {
    const metadata = Rule.metadata(GithubCiGen({ ...goldenAttrs }) as never)
    expect((metadata.attrs as { readonly mode: string }).mode).toBe("write")
    expect((metadata.forKind("lint").attrs as { readonly mode: string }).mode).toBe("check")
    // A writing target is not cacheable; its checking form is.
    expect(metadata.cacheable).toBe(false)
    expect(metadata.forKind("lint").cacheable).toBe(true)
  })
})
