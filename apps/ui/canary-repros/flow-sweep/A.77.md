# A.77 — `/debug.net` renders nothing for the human

## Steps

1. `cp -R ~/.multi-e2e-profile /tmp/canary-flow-sweep-profile`
2. Open <https://canary.smithers.sh> signed in as an ADMIN
   (`/api/auth/session` must answer `"admin":true`; the `debug.*` plugin does
   not register otherwise).
3. `/admin.devtools` to open the dev-tools panel, so "it renders in the panel"
   is ruled out.
4. `/debug.net`

## Expected

§26.2–§26.5 — the flow "reads" its surface for the human: the app-state
snapshot, the transition journal tail, the chain journal x-ray, the network tap.

## Actual

Nothing renders. Not in the transcript, not as a card, not as a toast, and not
in the open dev-tools panel. The only trace is the `command.ran` row the
transition log gains.

The handler returns a `value` payload
(`apps/ui/src/mainview/state/AppController.ts:2516`, `:2543`, `:2556`, `:2564`)
— what the agent boundary hands to the model. Values never render in the
transcript (§2b), so a human typing the flow gets a silent no-op. The sibling
`debug.seams` is the counter-example: it renders the `admin-health` card first
and returns the value second, so it IS observable.

## Selector / route

- Registry name `debug.net` in `[data-flows]` (admin session only).
- Dev-tools panel opened with `/admin.devtools`.
- No `/api/` traffic — these are local reads.

## Screenshot

`/tmp/canary-flow-sweep-shots/A.74.png`

## Repro

`apps/ui/canary-repros/flow-sweep/A.77.ts` (A.75/A.76/A.77 re-export A.74; one
run covers all four).

```
$ bun apps/ui/canary-repros/flow-sweep/A.74.ts
/debug.snapshot -> []
/debug.events -> []
/debug.chain -> []
/debug.net -> []
FAIL: /debug.snapshot rendered no reading at all
FAIL: /debug.events rendered no reading at all
FAIL: /debug.chain rendered no reading at all
FAIL: /debug.net rendered no reading at all
exit=1
```
