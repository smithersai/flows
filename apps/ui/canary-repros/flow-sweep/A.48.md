# A.48 — `/issues.create`: a failing invocation with arguments is silent

## Steps

1. `cp -R ~/.multi-e2e-profile /tmp/canary-flow-sweep-profile`
2. Open <https://canary.smithers.sh> in that profile, signed in as
   `codeplanesmithers`.
3. Type `/issues.create flow-sweep repro probe codeplanesmithers/no-such-repo-zz` into the composer and press Enter.

## Expected

creating in a repository the account cannot write is refused, never silently dropped (§13.7).

## Actual

Nothing renders. No card, no chat message, no toast. The seam runs (see the
network line below) and its refusal never reaches the screen.

## Selector / route

- Composer: `textarea` (the app's only one), submitted with Enter.
- Registry name: `issues.create` — present in the app shell's `data-flows`
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

`/tmp/canary-flow-sweep-shots/A.48.png`

## Repro

`apps/ui/canary-repros/flow-sweep/A.48.ts`

```
$ bun apps/ui/canary-repros/flow-sweep/A.48.ts
net: 404 POST /api/repos/codeplanesmithers/no-such-repo-zz/issues
added lines: []
honest lines: []
FAIL: /issues.create with a failing argument rendered no honest response — expected creating in an unwritable repository is refused, never silently dropped
exit=1
```
