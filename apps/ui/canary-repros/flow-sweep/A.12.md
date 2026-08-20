# A.12 — `/repos.watch.toggle` accepts a repository that is not in the chooser

## Steps

1. `cp -R ~/.multi-e2e-profile /tmp/canary-flow-sweep-profile`
2. Open <https://canary.smithers.sh> signed in as `codeplanesmithers`.
3. `/repos.watch` — the chooser card lists the three real repositories.
4. `/repos.watch.none` — the confirm button reads "Watch 0 repositories".
5. `/repos.watch.toggle no-such/repo`

## Expected

An unknown full name is refused. The sibling flow already does exactly this:
`/repos.watch no-such/repo` answers

> I couldn't find no-such/repo among your repositories — the chooser is open
> with the ones I can see.

## Actual

The confirm button goes to "Watch 1 repository". A repository the account does
not have is now in the selection, and nothing is said. Confirming would persist
it through `PUT /api/reco/watched`.

## Selector / route

- Registry name `repos.watch.toggle` (hidden, user-only) in `[data-flows]`.
- Card: `repo-chooser`; confirm control text `Watch <n> repositor(y|ies)`.
- No network call — the toggle is local chooser state.

## Screenshot

`/tmp/canary-flow-sweep-shots/A.12.png`

## Repro

`apps/ui/canary-repros/flow-sweep/A.12.ts`

```
$ bun apps/ui/canary-repros/flow-sweep/A.12.ts
selected before: 0 after: 1 added: ["Watch 1 repository"]
FAIL: /repos.watch.toggle no-such/repo raised the selection from 0 to 1
FAIL: /repos.watch.toggle no-such/repo never named the repository it could not find
exit=1
```
