# Hosted remote cache

This directory deploys the hosted tsflows remote cache to Cloudflare with
[Alchemy](https://alchemy.run). Production serves
`https://tsflows.smithers.sh`. The Worker stores action-cache JSON in D1 and
content-addressed blobs in R2.

The hosted service and the self-hosted service under [`../terraform/`](../terraform/)
serve the same HTTP protocol. A client can switch between them by changing the
endpoint and bearer token; cache keys and payloads do not change.

## Before you begin

Use Node.js 22 or later and install the pinned dependencies without running
package lifecycle scripts:

```sh
cd infra
npm ci --ignore-scripts
```

Provide these credentials in the deploying shell:

- `TSFLOWS_CACHE_TOKEN`: The bearer token used to derive the Worker's
  Cloudflare `secret_text` verifier. Use at least 32 random bytes. The Worker
  receives only its SHA-256 digest; do not put the bearer value in an `.env`
  file or source control.
- Cloudflare authentication: Set `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` for non-interactive deployments, or authenticate
  interactively with Cloudflare OAuth. You can use `wrangler whoami` to check
  an existing Wrangler OAuth login. Alchemy currently keeps its own OAuth
  profile, so run `npx alchemy login --configure` and choose OAuth on the first
  Alchemy deployment if you do not set an API token.

Generate a bearer token in the current shell without writing it to disk:

```sh
export TSFLOWS_CACHE_TOKEN="$(openssl rand -hex 32)"
```

The Cloudflare account must already contain the `smithers.sh` zone. The API
token or OAuth grant needs permission to manage Workers, D1, R2, and the
Worker custom domain in that zone.

The stack uses Alchemy's local state backend under `.alchemy/`. Keep that
ignored directory available to the deployment operator so later plans can
compare against the resources already deployed. This avoids requiring the
account-wide Cloudflare Secrets Store permissions needed by
`Cloudflare.state()`. The repository's deploy scripts also run
`scripts/redact-state.ts`, including after a failed Alchemy command, to scrub
any legacy state that contains the raw bearer value. Current state contains
only the one-way verifier. Use the scripts instead of calling `alchemy deploy`
directly.

## Deploy production

Preview the production plan:

```sh
CI=1 npx alchemy plan alchemy.run.ts --stage prod
```

Apply it:

```sh
CI=1 npm run deploy -- --yes
```

The `CI=1` prefix is for the environment-token path. Omit it when you use an
interactive Alchemy OAuth profile.

Alchemy creates a stage-specific D1 database and R2 bucket, applies
`worker/migrations/0001_initial.sql`, deploys the Worker with the three
bindings, and attaches `tsflows.smithers.sh` as its custom domain. The
production Worker does not expose a `workers.dev` URL.

## Deploy a development stage

Run the development script without `--stage`:

```sh
npm run deploy:dev
```

Alchemy uses its default `dev_$USER` stage. Development stages get independent
D1, R2, and Worker resources and use a `workers.dev` URL instead of claiming
the production custom domain.

## Verify the service

Every route, including `/healthz`, requires the bearer token:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $TSFLOWS_CACHE_TOKEN" \
  https://tsflows.smithers.sh/healthz
```

Run the unit tests and TypeScript check locally:

```sh
npm test
npm run check
```

## Protocol

All artifact digests are 64 lowercase hexadecimal SHA-256 values. Action-cache
keys are the CLI's sanitized, non-empty path segments.

| Request                  | Success response       | Behavior                                                                                                            |
| ------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /ac/{keyDigest}`    | `200` JSON             | Returns the original JSON bytes and updates D1 access metadata in the same statement. Missing entries return `404`. |
| `PUT /ac/{keyDigest}`    | `201`, `200`, or `409` | First writer wins. A new entry returns `201`; an identical result returns `200`; a different result returns `409`.  |
| `DELETE /ac/{keyDigest}` | `200`                  | Deletes an entry, or returns `404`. Supply `recordedRunId` and `recordedEventSeq` together for a fenced delete.     |
| `GET /cas/{digest}`      | `200` bytes            | Streams an R2 object as `application/octet-stream`; missing objects return `404`.                                   |
| `PUT /cas/{digest}`      | `201` or `200`         | Hashes the complete upload before an atomic R2 publication. A digest mismatch returns `400`.                        |
| `HEAD /cas/{digest}`     | `200`                  | Checks R2 without returning a body; missing objects return `404`.                                                   |
| `POST /cas/findMissing`  | `200` JSON             | Accepts `{"digests":[...]}` and returns unique missing digests in request order.                                    |

The `/ac` body can be the CLI's `CachedResult` JSON verbatim; the Worker does
not require the richer self-hosted table shape. For compatibility with the
existing cache protocol, an object containing a `result` member uses that
member for conflict classification. Other JSON bodies, including
`CachedResult`, use the whole value. Object keys are canonicalized before the
comparison, while the first writer's original JSON text is preserved for
reads.

Requests use these bounds:

- `/ac` JSON body: 1 MiB.
- `/cas` upload: 64 MiB and `application/octet-stream`.
- `/cas/findMissing`: 256 KiB, at most 1,000 digests, and
  `application/json`.

Malformed input returns `400`, unsupported content types return `415`, and
oversized input returns `413`. Unsupported methods return `405`. An internal
storage refusal returns `503`, which clients treat as retryable rather than as
a cache miss.

## Self-host instead

Use [`../terraform/`](../terraform/) when cache data must remain on
self-managed Docker, Postgres, and local storage. That stack remains supported
and independent of these Cloudflare resources. It exposes the same `/ac` and
`/cas` routes, so no cache-data or client-protocol migration is required.
