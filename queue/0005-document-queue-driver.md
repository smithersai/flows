---
status: queued
anchor: head
priority: p2
---

# Document the queue-driver operator

Docs-only item (also the queue driver's smoke test). The interim operator
now exists as the untracked local workflow
`.smithers/workflows/queue-driver.tsx` (UI at `.smithers/ui/queue-driver.tsx`):
pick → docs → implement → verify → land in an isolated worktree lane, landing
on `main`+`vibe` together.

- Update the "Cutover, honestly" section of
  `docs/specs/Concepts/Software Factory.md` (outer repo) to name the
  queue-driver workflow as the operator implementation that drives the queue
  until the flows-native factory flow (item 0003) ships.
- Update `queue/README.md`'s "Operating it today" section to say: run
  `smithers workflow run queue-driver` (optionally `--input item=<slug>`)
  instead of the hand-driven DDD pack instructions.
- No source-code changes. The implement phase should report no code needed;
  the verify phase checks the docs match the workflow's real behavior.
