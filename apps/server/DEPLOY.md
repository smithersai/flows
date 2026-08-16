# Deploying `smithers-mvp-web`

The deployable is one Cloudflare Worker, `smithers-mvp-web`, serving the
`smithers-ui` Vite build as static assets and the `/api`, `/v1`, `/workflows`
seams. The only live deployment today is the canary Worker on
`canary.smithers.sh`.

## Frozen identity — read this before touching `wrangler.jsonc`

The Worker's `name` (`smithers-mvp-web`) and its `routes` binding to
`canary.smithers.sh` (`wrangler.jsonc:1-9`) are deliberately frozen:

- Two Durable Objects (`TURN_CANCELS`, `GATEWAY_SESSIONS`) hold state keyed to
  this Worker's identity. Renaming it, or deploying under a different name,
  creates a **fresh** Worker with **fresh, empty** Durable Object storage —
  the existing state is orphaned, not migrated.
- The `canary.smithers.sh` custom-domain binding follows the `routes` entry
  in whichever Worker config declares it. Changing or removing that entry
  detaches the domain from this Worker.

Never edit `wrangler.jsonc`'s `name` or `routes` as part of a routine deploy.
If the identity or domain genuinely needs to change, that is a separate,
deliberate decision — not a side effect of a deploy.

## Scripted deploy (this repo's one repeatable path)

`scripts/deploy.ts` builds the SPA (`vite build` in `apps/ui`), then runs
`wrangler deploy` for this Worker, and writes a receipt (git sha + UTC
timestamp + wrangler version id) to `deploy-receipts/`.

```sh
# Dry run — real vite build, `wrangler deploy --dry-run`, no credentials
# needed, nothing published. Receipt lands in deploy-receipts/dry-run/.
pnpm run deploy:dry            # from the repo root
# or, equivalently:
pnpm --filter smithers-server run deploy:dry

# Real deploy — requires a Cloudflare credential (see below). Receipt lands
# in deploy-receipts/.
pnpm --filter smithers-server run deploy
```

## Credentialed human run

1. **Secret required:** `CLOUDFLARE_API_TOKEN` (a Cloudflare API token scoped
   to the `dd3525a4132493566aeb38de533c8827` account, Workers Scripts + Workers
   Routes edit permissions). Export it in the shell running the deploy, or
   `wrangler login` interactively — either satisfies `wrangler`'s auth.
2. **Build + deploy:**
   ```sh
   CLOUDFLARE_API_TOKEN=<token> pnpm --filter smithers-server run deploy
   ```
3. **Verify:** the command prints the new Version ID and the receipt file's
   path (`apps/server/deploy-receipts/latest.json`). Confirm
   `https://canary.smithers.sh` serves the new build (check a UI string you
   just changed, or the Worker's `Current Version ID` against the receipt).

### CI (tag-triggered)

`.github/workflows/apps-deploy.yml` runs the same script on push of a tag
matching `apps-v*` (e.g. `apps-v0.1.0`). It only attempts a real deploy when
the `CLOUDFLARE_API_TOKEN` repository secret is configured; otherwise (and
always for a manual `workflow_dispatch` run) it runs the dry-run path. Set the
secret in the repo's Settings → Secrets and variables → Actions before
cutting a tag that should actually publish.

## Rollback

Cloudflare Workers keep prior versions. To roll back to the version recorded
in an older receipt:

```sh
bun x wrangler rollback --message "rollback to <git sha from receipt>"
```

run from `apps/server`, with the same `CLOUDFLARE_API_TOKEN` set. This
targets the immediately-prior version; for a specific historical version, use
`bun x wrangler deployments list` to find its Version ID and
`bun x wrangler rollback <version-id>`. Rollback does not touch Durable
Object state — `TURN_CANCELS` and `GATEWAY_SESSIONS` storage is unaffected
either way, since it is keyed to the (unchanged) Worker identity, not to a
version.
