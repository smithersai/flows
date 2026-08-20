# A.59 — `/keys.list` has no success path: the platform answers 404

## Steps

1. `cp -R ~/.multi-e2e-profile /tmp/canary-flow-sweep-profile`
2. Open <https://canary.smithers.sh> signed in as `codeplanesmithers`.
3. `/keys.list`

## Expected

§18.1 — the `keys` card lists the account's provider API keys, masked.

## Actual

`GET /api/user/byok-keys` answers `404`. The product Worker claims the path and
proxies it to the Smithers Cloud platform (`api.jjhub.tech`), which has no such
route, so the Go router's plain body comes back. The UI is honest that the flow
did not run — the toast reads `/keys.list didn't run` over `404 page not found`
— but the detail is a raw upstream body, not a next step, and there is no
working success path for this flow on canary. `/keys.remove <provider>` (A.60)
fails the same way with `404 DELETE /api/user/byok-keys/<provider>`, silently,
because it carries arguments.

## Selector / route

- Registry name `keys.list` in `[data-flows]`.
- Route: `GET /api/user/byok-keys` — on the product Worker's platform-proxy
  allowlist (`apps/server/src/index.test.ts:1641`), forwarded with the user's
  cloud bearer.

## Screenshot

`/tmp/canary-flow-sweep-shots/A.59.png`

## Repro

`apps/ui/canary-repros/flow-sweep/A.59.ts`

```
$ bun apps/ui/canary-repros/flow-sweep/A.59.ts
added: ["/keys.list didn't run","404 page not found"]
net: 404 GET /api/user/byok-keys
FAIL: GET /api/user/byok-keys answers 404 — /keys.list has no success path on canary
FAIL: the refusal shows the upstream body "404 page not found" instead of a next step
exit=1
```
