# Rulings on the stage-2 open questions

Six of eight are answerable from the code and are ruled on here. Two are the maintainer's
call and are marked PENDING; implementation takes the stated default and stays reversible.

## Q1 — Does sandboxing cover a SPAWNED agent CLI, or only in-process actions?

**RULING: unknown, and it must stay unknown until measured.** Run the Wave 4.1 experiment
before committing Agent to a tier. Execute an Agent inside the projection primitive with a
deliberately under-declared read set and a prompt that induces a read outside it. If the read
fails, spawned coverage is real and Agent can become `sealed`. If it succeeds, Agent stays
`compensable` forever and shared caching of agent runs is off the table.

Do not design Wave 3 around either answer. Ship Agent `compensable` with `cache: false`, which
is correct under both outcomes.

## Q2 — Is `Input.Produced` already in D1-D15 scope?

**RULING: net-new and compatible.** D1-D15 contains nothing about output-keyed edges. It is
adjacent to the W3-E artifact-CAS lane, which stores output blobs by the digest
`ToolBuild.captureOutputs` already computes, so the two share a concept and must agree on it.
Build `Input.Produced` immediately after W3-E and reuse its digest, not a second one.

## Q3 — May a model-driven gate fail CI?

**RULING: no, not by calling a model.** Copy `PackageJson`: `check` and `write` never call a
model, `refresh` is a `run` verb a person invokes. CI gates on a committed findings artifact,
so a fresh checkout with a cold cache and no model CLI still checks green and CI never depends
on a network call.

This changes behaviour for the three existing LlmLint targets
(`//lint:docsReferenceSync`, `//lint:durableIdentityGuard`, `//lint:jsdocTruthfulness`).
Their findings become committed artifacts. Say so in the commit message; do not let it be a
surprise.

## Q4 — Should flows subsume Smithers workflow EXECUTION? **PENDING**

**DEFAULT: artifact boundary only.** `Workflow` stays a narrow sealed-batch rule; interactive
runs stay outside the graph as `Exec` targets under the `run` verb. This is reversible and does
not foreclose convergence. Convergence is a much larger project and is the maintainer's call.

## Q5 — Extend `Runtime`, or add a parallel `Toolchain`?

**RULING: a separate `Toolchain` namespace.** `Runtime.Name` is `Literals(["node","bun","deno"])`
and its documented meaning is "the interpreter every tool runs under". Rust and Zig are not
interpreters and Foundry is not a runtime. Widening the union corrupts a precise concept to save
one declaration. `Toolchain` carries the same measure-and-refuse contract; `Runtime` stays the
interpreter that executes the workspace's own code.

## Q6 — Is an Agent's `context` subject to visibility?

**RULING: yes, normal visibility applies.** A producer that wants to be readable by an agent
exports a `Filegroup` and gives it visibility, exactly as it would for any other consumer. An
exemption would make D6 advisory the moment agentic targets became common, and the whole value
of D6 is that it is not advisory.

## Q7 — Is a coarsened cache key acceptable?

**RULING: allowed, with a mandatory docstring section naming the ignored change class.**
`PackageJson.ts:766-772` already does this — it keys a description on the file listing rather
than source bytes, deliberately, to avoid a model call per commit. The technique is what makes
nonhermetic values affordable. The requirement is that a rule states in prose what it declines
to look at, so the staleness it accepts is a documented decision rather than an accident.

## Q8 — Do we need a freshness marker distinct from `cache: false`?

**RULING: defer to Wave 5.** Ship `EvalSample` and `Bench` with `cache: false` and accept a
later migration. `cache: false` and "must be resampled even when the key is unchanged" do read
identically and the distinction is real, but nothing in the first four waves depends on telling
them apart.
