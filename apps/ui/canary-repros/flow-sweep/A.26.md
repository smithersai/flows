# A.26 — `/copy-message` fails with an unhandled rejection and says nothing

## Steps

1. `cp -R ~/.multi-e2e-profile /tmp/canary-flow-sweep-profile`
2. Open <https://canary.smithers.sh> signed in as `codeplanesmithers`.
3. `/copy-message flow-sweep A26 clipboard probe`

## Expected

Either the copy happens visibly, or it fails with an honest line naming the
next step.

## Actual

Nothing renders. The only trace is a `POST /api/client-errors` carrying an
`unhandledrejection` of
`NotAllowedError: Failed to execute 'writeText' on 'Clipboard': Write permission denied.`

The clipboard write is not caught, so a denied or unavailable clipboard becomes
an unhandled promise rejection with zero user-facing signal — success and
failure look identical.

## Selector / route

- Registry name `copy-message` (hidden, user-only) in `[data-flows]`.
- Button form: `button[data-flow="copy-message"][aria-label="Copy message"]`.
- Error sink: `POST /api/client-errors` (`apps/server/src/clientErrorLog.ts`).

## Screenshot

`/tmp/canary-flow-sweep-shots/A.26.png`

## Repro

`apps/ui/canary-repros/flow-sweep/A.26.ts`

```
$ bun apps/ui/canary-repros/flow-sweep/A.26.ts
added: []
client errors: [ "{\"kind\":\"unhandledrejection\",\"message\":\"NotAllowedError: Failed to execute 'writeText' on 'Clipboard': Write permission denied.\",\"url\":\"/\",\"at\":\"2026-08-19T10:29:23.239Z\"}" ]
FAIL: /copy-message raised an unhandled clipboard rejection
FAIL: /copy-message rendered nothing — success and failure look identical
exit=1
```
