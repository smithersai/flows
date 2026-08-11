# @smthrs/platform-browser

## [Unreleased]

### Added

- Added `BrowserHost` and `BrowserHttpTransport`, moved out of `@smthrs/host`
  when that package dissolved. `BrowserHost.layer({ bash, fs })` is the complete
  closed six-tag Host bundle for a tab; the spawner is provided _over_ the
  filesystem and path layers, the way `NodeChildProcessSpawner` is, so the
  interpreter and the `FileSystem` service agree about what exists.

### Changed

- `BrowserChildProcessSpawner` now renders a command with
  `@smthrs/kernel`'s `CommandLine.render` instead of its own always-quoting
  helper. The two had to agree and did not: the kernel writes the rendered line
  as the `proc:spawn` capability resource, so a grant read `ls` while the tab
  ran `'ls'`.

### Added (initial extraction)

- Added `BrowserFileSystem`, moved out of `@smthrs/host`
  (`browser/BrowserFileSystem`): a `FileSystem` over a ZenFS-shaped promises
  API, taken as a structural slice so no `@zenfs/core` dependency is
  introduced. Two gaps in the host version are closed on the way across:
  `readFileString` and `writeFileString` are now wired up (`FileSystem.makeNoop`
  hardcodes both to `NotFound` instead of deriving them from
  `readFile`/`writeFile` the way `make` does, so they failed on files that
  plainly existed), and `writeFile`'s `flag`/`mode` are forwarded to the backend
  instead of dropped, so `{ flag: "a" }` appends rather than silently
  truncating.
- Added `BrowserChildProcessSpawner`, an implementation of `effect`'s
  `ChildProcessSpawner` over a just-bash interpreter instance. It carries over
  `JustBashShell`'s semantics — the serialized uninterruptible boundary, the
  refusal to accept stdin — and reports every capability just-bash lacks
  (signals, streaming output, process pipelines) as a `PlatformError` rather
  than as silence. The `stdout`/`stderr` dispositions keep their Node meaning:
  `"inherit"`/`"ignore"` yield an empty stream and a `Sink` is transduced
  through.
- Added `BrowserServices`, the aggregate layer mirroring `NodeServices`:
  `ChildProcessSpawner`, `FileSystem`, and `Path` from one call.
