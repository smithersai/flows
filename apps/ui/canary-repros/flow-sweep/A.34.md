# A.34 — `/world.delete` deletes with no confirmation, and is silent on a bad id

## Steps

1. `cp -R ~/.multi-e2e-profile /tmp/canary-flow-sweep-profile`
2. Open <https://canary.smithers.sh> signed in as `codeplanesmithers`.
3. `/chat`, then `/world`, then `/world.new-note` (the repro records the id the
   new note is minted with by wrapping `crypto.randomUUID` and filtering on the
   `createWorldDocument` stack frame).
4. `/world.delete not-a-document-id`
5. `/world.delete <the real id>`

## Expected

§10.6 — the confirm dialog names the note's title, cancel is clean, delete only
happens on confirm; and an unknown document id is refused out loud.

## Actual

- Step 4 renders nothing at all.
- Step 5 removes the note immediately. `[role="dialog"]` count is 0 — there is
  no confirmation at any point. The note count drops by one (10 → 9).

## Selector / route

- Registry name `world.delete` (hidden) in `[data-flows]`.
- Surface: the World pane (`/world`), file tree entries `Untitled <n>`.
- Local only — no `/api/` traffic.

## Screenshot

`/tmp/canary-flow-sweep-shots/A.34.png`

## Repro

`apps/ui/canary-repros/flow-sweep/A.34.ts`

```
$ bun apps/ui/canary-repros/flow-sweep/A.34.ts
document id: 0c676547-e966-4c25-ad34-f6db0ac02625
bogus id added: []
dialogs: 0 notes before: 10 after: 9
FAIL: /world.delete with an unknown document id rendered nothing
FAIL: /world.delete showed no confirmation dialog before deleting
exit=1
```
