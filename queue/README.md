# queue/

The intake of the software factory. One markdown file per requested change;
presence is registration. The design is in the spec vault:
`docs/specs/Concepts/Software Factory.md` (process),
`docs/specs/Concepts/Clean History.md` (the `vibe`/`main` branch model), and
`docs/specs/Concepts/Colocated Docs.md` (documentation planes).

## Item format

```markdown
---
status: queued          # queued | in-progress | landed | retold | blocked
anchor: narrative       # narrative | head
priority: p1            # p0 | p1 | p2
---

The prompt: what to change and why, in plain prose.
```

- `anchor: narrative` bases the work lane on the commit in `main`'s retold
  series that owns the affected subsystem; the retell folds the change into
  that span. `anchor: head` bases on the tip and defers the fold.
- The item's digest keys its run. Editing an item re-keys exactly its own
  work; re-running a processed item is a cache hit.
- Processing order: docs → gate → implement → verify → land on `vibe` →
  retell into `main`. The docs phase holds writes to `docs/**` and package
  READMEs only; the implement phase holds code writes; the retell holds
  `vcs:write`.

## Operating it today

Until the factory flow ships (item 0003), the smithers DDD pack is the
operator. Drive an item by starting a run whose prompt is the item file;
update `status` in the file as the phases complete.
