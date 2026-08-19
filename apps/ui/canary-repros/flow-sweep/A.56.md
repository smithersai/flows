# A.56 — `/prs.review`: a failing invocation with arguments is silent

## Steps

1. `cp -R ~/.multi-e2e-profile /tmp/canary-flow-sweep-profile`
2. Open <https://canary.smithers.sh> in that profile, signed in as
   `codeplanesmithers`.
3. Type `/prs.review 99999 comment flow-sweep repro codeplanesmithers/canary-sandbox` into the composer and press Enter.

## Expected

reviewing a missing pull request is refused by number.

## Actual

Nothing renders. No card, no chat message, no toast. The seam runs (see the
network line below) and its refusal never reaches the screen.

## Selector / route

- Composer: `textarea` (the app's only one), submitted with Enter.
- Registry name: `prs.review` — present in the app shell's `data-flows`
  manifest (`[data-flows]`, 88 names on an admin session, 70 on a
  non-admin one).
- Route exercised: see the `net:` line in the repro output.

## Root cause

`send()` in `apps/ui/src/mainview/state/AppController.ts:2317` runs a typed
slash flow as

```ts
void commands.run(parsed.name, parsed.args);
```

and discards the `CommandOutcome`. The BUTTON path in the same file
(`runCommand` / `runCommandArgs`, ~lines 4363 and 4369) attaches
`surfaceCommandFailure`, which raises the toast `"/<name> didn't run"` over the
seam's honest reason. `apps/ui/src/mainview/App.tsx:625` routes Enter to
`runSlashCommand` only while the slash menu is open, and the menu matches a
BARE name only (`slashItems` filters on the whole draft). So `/name` bare is
honest and `/name <args>` is silent — the same flow, the same seam, two
different outcomes.

Proof of the split, observed live on the same session:

| typed | rendered |
| --- | --- |
| `/issues.view` | toast `/issues.view didn't run` + `issues.view needs an issue number` |
| `/issues.view 999999 codeplanesmithers/canary-sandbox` | nothing |

## Screenshot

`/tmp/canary-flow-sweep-shots/A.56.png`

## Repro

`apps/ui/canary-repros/flow-sweep/A.56.ts`

```
$ bun apps/ui/canary-repros/flow-sweep/A.56.ts
net: 404 POST /api/repos/codeplanesmithers/canary-sandbox/landings/99999/reviews
added lines: []
honest lines: []
FAIL: /prs.review with a failing argument rendered no honest response — expected reviewing a missing pull request is refused by number
exit=1
```
