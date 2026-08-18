# apps

The deployable applications of the Smithers product, as pnpm workspace
members (`apps/*` in `pnpm-workspace.yaml`). Formerly one package,
`apps/mvp`; split 2026-08-15.

| Package  | Name             | What it is                                                                                                                                       |
| -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ui/`    | `smithers-ui`    | The Electrobun + React native app and pure-web UI. Vite builds to `ui/dist`. `src/dev/` is the vite dev/preview AgentApi middleware (not a deployable). |
| `server/`| `smithers-server`| The Cloudflare Worker deployable (`smithers-mvp-web`, canary.smithers.sh). Serves `../ui/dist` assets and the `/api`, `/v1`, `/workflows` seams.   |
| `shared/`| `smithers-shared`| The agent contract both sides import (`AgentContext`, `AgentApiRoutes`, `NativeAgent` frames, `Cards`, ...). Import as `smithers-shared/<Module>`. |
| `tui/`   | `smithers-tui`   | The opentui (React) terminal chat client: a TUI clone of the app's chat against the same turn contract. Default transport is the chat upstream (CloudAgent semantics); `--origin`/`SMITHERS_TUI_ORIGIN` attaches through the Worker boundary. |

Deploy identity: the Worker's wrangler `name` stays `smithers-mvp-web`.
Renaming it would deploy a fresh Worker and orphan the Durable Object
state and the canary.smithers.sh custom-domain binding.

`@smthrs/*` dependencies resolve as workspace links into `packages/`
(the vendored copies under `vendor/smthrs` are gone). `@smthrs/chain`
had no living source elsewhere and was promoted to `packages/chain`
(`@smthrs/chain`).

Product-level docs (`DESIGN.md`, `MIGRATION.md`, `WAVE*-RECEIPT.md`,
`reports/`) live at this level because they cover UI and Worker waves
alike.

## Running it locally

| Command | From | What runs |
| --- | --- | --- |
| `pnpm dev` | repository root | The UI on `http://localhost:5173`. Forwards to `pnpm --filter smithers-ui run web`, so the `--configLoader runner` flag lives in one place. |
| `pnpm --filter smithers-ui run serve:local` | anywhere | The UI built and served by `wrangler dev`, i.e. the UI **and** the product Worker together. Use this to exercise the `/api` seams. |
| `pnpm --filter smithers-ui run build` | anywhere | The production bundle into `apps/ui/dist`, which the Worker serves as static assets. |

Dev rides the deployed seams. Everything the product Worker proxies in
production (`/api/auth`, `/api/identity`, `/api/reco`, `/api/billing`,
`/api/repos`, `/api/github`, `/api/user`, `/api/notifications`,
`/api/workflow`, `/api/client-errors`) forwards to
`https://canary.smithers.sh`, so the identity probe answers definitively
instead of "unavailable". Point that elsewhere with **`SMITHERS_DEV_UPSTREAM`**:

```sh
SMITHERS_DEV_UPSTREAM=http://127.0.0.1:8787 pnpm dev
```

The chat seam (`/api/agent`) stays local — `apps/ui/src/dev/AgentApi.ts` serves
it, with `SMITHERS_CHAT_URL` and `SMITHERS_CHAT_ORIGIN` naming the upstream it
relays to. Signed-in state cannot exist on `localhost` whatever you point at:
the session cookie and the GitHub OAuth callback are bound to the canary
origin, so completing a sign-in continues there.
