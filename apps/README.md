# apps

The deployable applications of the Smithers product, as pnpm workspace
members (`apps/*` in `pnpm-workspace.yaml`). Formerly one package,
`apps/mvp`; split 2026-08-15.

| Package  | Name             | What it is                                                                                                                                       |
| -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ui/`    | `smithers-ui`    | The Electrobun + React native app and pure-web UI. Vite builds to `ui/dist`. `src/dev/` is the vite dev/preview AgentApi middleware (not a deployable). |
| `server/`| `smithers-server`| The Cloudflare Worker deployable (`smithers-mvp-web`, canary.smithers.sh). Serves `../ui/dist` assets and the `/api`, `/v1`, `/workflows` seams.   |
| `shared/`| `smithers-shared`| The agent contract both sides import (`AgentContext`, `AgentApiRoutes`, `NativeAgent` frames, `Cards`, ...). Import as `smithers-shared/<Module>`. |

Deploy identity: the Worker's wrangler `name` stays `smithers-mvp-web`.
Renaming it would deploy a fresh Worker and orphan the Durable Object
state and the canary.smithers.sh custom-domain binding.

`@smthrs/*` dependencies resolve as workspace links into `packages/`
(the vendored copies under `vendor/smthrs` are gone). `@smthrs/chain`
had no living source elsewhere and was promoted to `packages/chain`
(`@smthrs/chain-next`).

Product-level docs (`DESIGN.md`, `MIGRATION.md`, `WAVE*-RECEIPT.md`,
`reports/`) live at this level because they cover UI and Worker waves
alike.
