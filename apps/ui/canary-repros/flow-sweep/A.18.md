# A.18 — `/flow.create` never reaches a terminal state

## Steps

1. `cp -R ~/.multi-e2e-profile /tmp/canary-flow-sweep-profile`
2. Open <https://canary.smithers.sh> signed in as `codeplanesmithers`
   (`repos-selected` is satisfied — three repositories are watched).
3. `/flow.create nightly open issue digest codeplanesmithers/canary-sandbox`
4. Wait 90 seconds.

## Expected

§16.1 — a workflow is produced and is real on the workspace, or an honest
failure names what stopped it.

## Actual

The transcript shows `Preparing your codeplanesmithers/canary-sandbox
workspace…` and stops there. After 90s there is still no workflow card, no
failure, and no toast. `POST /api/workflow/provision` is never called — even
though `/flow.list` on the same account does call it and succeeds, so the
gateway seam itself is reachable.

Reproduced three times (60s, 90s, 90s waits).

## Selector / route

- Registry name `flow.create` in `[data-flows]`.
- Expected route: `POST /api/workflow/provision`, then `POST /api/workflow/rpc`.
- Observed: no `/api/` traffic at all after the message renders.

## Screenshot

`/tmp/canary-flow-sweep-shots/A.18.png`

## Repro

`apps/ui/canary-repros/flow-sweep/A.18.ts`

```
$ bun apps/ui/canary-repros/flow-sweep/A.18.ts
added: ["Preparing your codeplanesmithers/canary-sandbox workspace…"]
net: (no /api/ traffic)
FAIL: /flow.create still says "Preparing your … workspace…" after 90s
FAIL: /flow.create never called POST /api/workflow/provision
exit=1
```
