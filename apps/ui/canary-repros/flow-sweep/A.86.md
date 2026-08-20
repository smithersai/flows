# A.86 — `/admin.queue.approve` says nothing and leaves the entry queued

## Steps

1. `cp -R ~/.multi-e2e-profile /tmp/canary-flow-sweep-profile`
2. Open <https://canary.smithers.sh> signed in as an ADMIN
   (`/api/auth/session` must answer `"admin":true`; the flow does not register
   otherwise).
3. `/admin.requests` — the card reads `Request-access queue — 1 waiting` with
   `codeplanesmithers` on it.
4. `/admin.queue.approve codeplanesmithers`
5. `/admin.queue.approve nosuchlogin-zzz`

## Expected

§25.2 — the entry is approved, leaves the queue, and the card says so. A login
that is not in the queue is refused by name.

## Actual

- Step 4: `POST /api/admin/allowlist` → 200 and `GET /api/admin/requests` → 200,
  but nothing renders and `GET /api/admin/requests` still returns the same
  entry. The queue card still reads `Request-access queue — 1 waiting`. Only
  `updatedAt` moves.
- Step 5: nothing renders, and the unqueued login is added to the allowlist
  anyway.

## Selector / route

- Registry name `admin.queue.approve` (hidden) in `[data-flows]` — present only
  on an admin session (88 names) and absent on a non-admin one (70 names).
- Routes: `POST /api/admin/allowlist`, `GET /api/admin/requests`.
- Card: `request-queue`.

## Screenshot

`/tmp/canary-flow-sweep-shots/A.86.png`

## Repro

`apps/ui/canary-repros/flow-sweep/A.86.ts`

```
$ bun apps/ui/canary-repros/flow-sweep/A.86.ts
queue: codeplanesmithers
added: ["Request-access queue — 1 waiting","PENDING","request-queue · 03:31 AM","codeplanesmithers2026-08-19Approve"] net: 200 POST /api/admin/allowlist | 200 GET /api/admin/requests
FAIL: codeplanesmithers is still in the request-access queue after being approved
FAIL: /admin.queue.approve with an unqueued login rendered nothing
exit=1
```
