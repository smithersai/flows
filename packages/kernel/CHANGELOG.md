# @smthrs/kernel

## [Unreleased]

### Added

- Added `CommandLine`, which renders an `effect/unstable/process` `Command` back
  to a POSIX command line. One renderer, two callers: the `proc:spawn`
  capability resource and the interpreter or remote sandbox that executes the
  line, so a grant and the thing it authorizes cannot drift apart.
- Added `ChildProcessSpawner`, the permission decorator over Effect's own
  spawner. The check is suspended inside `spawn`, so building a `Command` or a
  stream neither asks permission nor starts a process; the derived helpers
  (`exitCode`, `string`, `lines`, `stream*`) are rebuilt from the guarded
  `spawn` so none can route around it; and `layer` double-publishes onto
  Effect's tag, so a `Command` run as a plain `Effect` is checked too.
- Absorbed the dissolved `@smthrs/host`: `HostError`, `HttpTransport`, the
  closed `HostServices` list, the shared contract suite (now
  `@smthrs/kernel/test/contract`), and the deterministic `TestHost` bundle
  (`@smthrs/kernel/test/TestHost`, Node-only) live here.

### Removed

- Removed the `Pty` decorator, and with it the `flows/host/Pty` slot from the
  closed list, `PtyError` from `HostError`, and the `@smthrs/pty` package from
  the workspace. The contract had no production consumer and its Node
  implementation was piped stdio, not a pseudo-terminal. Interactive-terminal
  support belongs to a higher-level harness extension, not the closed Host
  surface — see D13 in `docs/pages/design-decisions.md` and
  `docs/specs/Concepts/No Pty In Core.md`.
- Removed the `Shell` decorator and the raw `Shell` port. Process execution is
  `effect/unstable/process`; the closed list's third slot now holds Effect's own
  tag and its id is `effect/process/ChildProcessSpawner`. That id change is
  deliberate and invalidates cached steps that ran a command: the service
  really is different, so the step really is different.
- Removed `ShellError`, `ShellErrorCode`, and `shellError` from `HostError`. A
  spawn fails with `PlatformError`, like the rest of `effect`'s platform
  surface.

## [0.1.0] - 2026-08-05

### Added

- Added the effect-aware capability model, monotone attenuation, journaled grant store, and mandatory decoration of the original Host and Effect service tags.
- Added tier-preserving grant validation, canonical filesystem confinement, single-hop HTTP transport enforcement, browser-bundle coverage, and dual ESM/CJS package artifacts.

### Fixed

- Switched Host integration to its current public service subpaths and made the browser root entrypoint Node-free.
- Corrected configured-policy last-match-wins evaluation, journaled one-call grants, and resumed every pending waiter covered by run grants.
- Added plan-digest-bound run and remembered envelopes, same-run grant replay, trusted journal envelope validation, and duplicate-free resume.
- Preserved grant-store lifecycle failures in the typed stable-code channel and emitted identity-safe non-bundled CJS modules.
