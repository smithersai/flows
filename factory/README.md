# factory/

The software factory: everything that turns queued prompts into landed,
documented commits, and everything that turns a GitHub issue into a queued
prompt. The process design lives in the spec vault:
`docs/specs/Concepts/Software Factory.md` (process),
`docs/specs/Concepts/Github Automation.md` (the GitHub side),
`docs/specs/Concepts/Clean History.md` (the `vibe`/`main` branch model), and
`docs/specs/Concepts/Colocated Docs.md` (documentation planes).

## Contents

- `queue/` — the intake. One markdown file per requested change; presence is
  registration. See `queue/README.md`.
- `automation/` — the GitHub automation entries, and the modules they are built
  from. See `automation/README.md`.
- `repros/` — proof-of-concept pairs, one directory per issue. See
  `repros/README.md`.
- `memory/` — the triaged-issue corpus intake reads for duplicates. See
  `memory/README.md`.

## The two halves

The queue is the inside: a maintainer, or the factory itself, writes a prompt
and a lane implements it. The automation is the outside: an issue arrives, gets
decoded and deduped, gets a proof of concept the reporter is asked to confirm,
and — once confirmed and verified — becomes a queue item like any other.

They meet at `factory/automation/fix.ts`, which renders a `factory/queue/` item
from a verified report. Everything downstream of that point is the queue's
existing process; nothing about the GitHub side is a second, parallel pipeline.

## The workflows are generated

`.github/workflows/gen.*.yml` are rendered from declarations in the root
`BUILD.ts` by `Smithers.GithubAutomation`. Do not edit them: each carries a
marker header naming the target that owns it, and `smthrs ci` byte-compares
them. Regenerate one with `smthrs run //:<target>`.

`ci.yml` and `release.yml` stay hand-written; they are verified in place by
`Smithers.GithubCiGen` in contract mode, which fails when a declared gate stops
running.

## Planned

Factory tooling consolidates here over time. The queue-driver workflow
(`.smithers/workflows/queue-driver.tsx`, untracked today) and the factory flow
that replaces it (queue item `0003-factory-flow`) move under this directory
when they become tracked code.
