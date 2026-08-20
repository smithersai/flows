# factory/memory/

One markdown file per triaged issue. Presence is registration; the file name is
the issue number. `factory/automation/intake.ts` reads this corpus for duplicates
and neighbours before it searches GitHub, because the corpus holds the judgment a
previous triage made and a search result does not.

This page is generated. `factory/automation/memory.ts` rewrites it from the
directory on every write, so do not edit it by hand; edit the renderer.

## An entry

```markdown
---
issue: 42
title: "Edit blocks: locating a block fails when the file uses CRLF"
labels: ["repro:verified", "poc:confirmed"]
state: open
reproKey: "issue-42"
related: [7]
---

# Edit blocks: locating a block fails when the file uses CRLF

Applying an edit block to a CRLF file reports no match. The locator normalises
the search text but not the haystack.
```

| Field | Means |
| ----- | ----- |
| `issue` | The issue number. It is also the file name. |
| `title` | The issue title at the time of the last triage. |
| `labels` | The labels the issue carried after the triage that wrote this entry. |
| `state` | `open` or `closed`. |
| `reproKey` | `issue-<n>`, present once the issue has a proof of concept. |
| `related` | Issue numbers linked in either direction, including a confirmed duplicate. |

Every scalar is JSON-quoted, because issue titles carry colons routinely and
unquoted frontmatter would not survive one.

The body is a compact summary in prose: what breaks, and under what conditions.
It is not a transcript of the issue, and it does not speculate about the cause.
Automation runs append to it rather than replacing it, so an entry reads as the
history of what triage learned.

## Who writes here

Only trusted, gated jobs. `intake.ts` writes the first entry, `poc-publish.ts`
records the PoC outcome, and `reverify.ts` records a sweep's closure. Each commits
its own change with a `📝 docs(factory):` message. The sandbox job that runs
reporter-derived code holds no write permission and cannot reach this directory.

## Entries

No issues have been triaged yet.
