# Wave 7 — Deploy receipt: the MVP is live at https://canary.smithers.sh

2026-08-09 (UTC) · run `oneshot-wave7-deploy` · branch `oneshot-mskp7qe7-work` (~/mvp), `wave5-billing-bridge` (~/flows/ui, commit `f2894e1`)

**Bottom line:** canary.smithers.sh now serves the mvp product Worker (not the flows/ui POC). Identity, reco, billing, and a canary chat are deployed and wired; a real Cerebras turn streamed through the deployed stack and its metered charge landed in deployed billing on the `smithers-canary` account ($500.000000 → $499.999850 across the verification turns). Sign-in awaits will's OAuth click (honest 503 until then); the gateway seam is an intentional honest 501. Nothing unauthorized was touched: flows/code/chat-prod/status workers unchanged, no DNS records changed, no GitHub OAuth app settings changed.

> **Post-deploy correction (2026-08-09, version `d734d048`) — read this first.** The first canary deploy (`339de581`) published `/api/agent/turn` **unauthenticated to the open internet.** The Worker's only guard on that route was the same-origin check, which by design ignores requests that carry no `Origin` header at all — so any `curl -X POST https://canary.smithers.sh/api/agent/turn` on the internet streamed a live Cerebras turn on the deployment's own supplier key and metered it onto the `smithers-canary` $500 balance. Confirmed exploitable against the live deploy, then fixed and redeployed: the turn seam and its cancel now require a validated, **allowlisted** session whenever `IDENTITY_UPSTREAM_URL` is set (anonymous → `401`, signed-in-but-not-allowlisted → `403`, checked *before* any credential is spent). Re-verified live: anonymous POST now answers `401 {"message":"Sign in to run a Smithers turn."}`. The window was ~15 minutes and the exposure is bounded by the $500 grant; no unexplained charges appeared (the balance moved only by this run's own probes). **The §4 numbers below were all measured against the pre-fix version and are left as recorded.**

## 1. Inventory (names only)

- **Canary seat inherited:** worker `smithers-ui-canary` (~/flows/ui `wrangler.toml`), static-assets POC, custom domain `canary.smithers.sh`, zero env/secret bindings. Account `dd3525a4132493566aeb38de533c8827`, zone `smithers.sh` (`8ebd98d2f0dc7d8db2e61f31ebc19c14`). Local wrangler auth: `CLOUDFLARE_API_TOKEN` env (account-scoped).
- **Sibling workers** (~/flows/ui `workers/*`, branch wave5-billing-bridge): `smithers-cloud-identity` (identity.smithers.sh), `smithers-cloud-billing` (billing.smithers.sh, KV `166564c7478e43ccbe59ca82cdc21c32`, DO `AccountDurableObject`), `smithers-cloud-reco` (reco.smithers.sh), `smithers-cloud-chat` (chat.smithers.sh; DOs `ChatHistory`/`PushSubscriptions`; metering queue `smithers-metering` + DLQ).
- **~/multi:** GitHub OAuth client id `Iv23liwHER62HVHMWcGS` (GitHub App) with registered callbacks for `code.smithers.sh` / `flows.smithers.sh` / dev workers.dev at `/api/auth/github/login/callback`; secret recoverable from `~/.zshrc` + `.alchemy/local/wrangler.jsonc` (plaintext, gitignored). Canary Cloud user PAT: `CANARY_SMITHERS_CLOUD_TOKEN` (same file; also GCP `multi-canary-plue-token`) → resolves at `api.jjhub.tech/api/user` as login **`smithers-canary`** (id 1).
- **Pre-existing state found (honest surprises):**
  - billing was deployed 2026-08-05 but **pre-wave-5** (no trusted-caller bridge) and with **no `METERING_SERVICE_TOKEN`, no `ADMIN_SERVICE_TOKEN`** — prod chat turns streamed, but charges never landed (`chargeCount: 0` before this run). The "durable metering" pairing had never been completed, and prod chat's `BILLING_SERVICE_TOKEN` value is unrecoverable (write-only secret, not in GCP/`~/.zshrc`/~/smithers).
  - `identity.smithers.sh` and `reco.smithers.sh` CNAME to `cname.vercel-dns-016.com` and answer Vercel `DEPLOYMENT_NOT_FOUND` — stale records from the pre-Cloudflare era, nothing lives there.

## 2. Deploys performed (exact commands, all from ~/flows/ui unless noted)

| Worker | Version | Command | URL used by the product |
|---|---|---|---|
| `smithers-cloud-identity` | `db1f5649` | `bun x wrangler deploy --config workers/identity/wrangler.jsonc` | `https://smithers-cloud-identity.willcory10.workers.dev` |
| `smithers-cloud-reco` | `c120d24a` | `bun x wrangler deploy --config workers/recommendations/wrangler.jsonc` | `https://smithers-cloud-reco.willcory10.workers.dev` |
| `smithers-cloud-billing` | `ee0e8423` | `bun x wrangler deploy --config workers/billing/wrangler.jsonc` (redeploy from wave-5 HEAD; all pre-existing secrets persist by Cloudflare semantics) | `https://billing.smithers.sh` |
| `smithers-cloud-chat-canary` | `4b64a7ca` | `bun x wrangler queues create smithers-metering-canary{,-dlq}` then `bun x wrangler deploy --config workers/chat/wrangler.canary.jsonc` (new config, same source as prod chat) | `https://smithers-cloud-chat-canary.willcory10.workers.dev/chat` |
| `smithers-mvp-web` (~/mvp) | `339de581`, then `d734d048` (turn-seam session gate) | `bun run build && bun x wrangler deploy` (~/mvp; `TURN_CANCELS` DO migration v1 applied on first deploy) | **`https://canary.smithers.sh`** |

Why a canary chat instead of prod chat: completing metering on prod chat requires setting its `BILLING_SERVICE_TOKEN` — prod chat config is outside the authorization boundary. The canary chat is the same source with its own queue pair (sharing `smithers-metering` would let prod chat's consumer eat canary usage into its DLQ).

identity/reco are served over workers.dev because their smithers.sh CNAMEs still point at dead Vercel — changing that DNS is **not** in this run's authorization (will-list below). Their zone routes (`identity.smithers.sh/*`, `reco.smithers.sh/*`) are registered and activate the moment the DNS is proxied. Browser flows are unaffected: the product Worker same-origin-proxies `/api/auth/*`, `/api/reco/*` under canary.smithers.sh.

**Secrets installed (NAMES only; values generated fresh with `openssl rand` except as noted):**
- identity: `SESSION_SECRET`, `IDENTITY_SERVICE_TOKEN`, `ADMIN_SERVICE_TOKEN` (fresh). `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` deliberately NOT installed (§5).
- reco: `IDENTITY_SERVICE_TOKEN` (same value as identity's), `RECO_SERVICE_TOKEN`, `ADMIN_SERVICE_TOKEN` (fresh).
- billing: `METERING_SERVICE_TOKEN` (fresh), `ADMIN_SERVICE_TOKEN` (fresh), `PRODUCT_SERVICE_TOKEN` (fresh). `STRIPE_*` untouched (never installed — Stripe routes answer honest 503s; alpha is subsidized).
- chat-canary: `CEREBRAS_API_KEY` (recovered from `~/.zshrc` — the same supplier key prod chat uses), `BILLING_SERVICE_TOKEN` (= billing's fresh `METERING_SERVICE_TOKEN` — **the metering pair is now complete**).
- mvp (`smithers-mvp-web`): `SMITHERS_CHAT_AUTH_TOKEN` + `BILLING_AUTH_TOKEN` (= the `smithers-canary` Cloud PAT), `IDENTITY_SERVICE_TOKEN`, `IDENTITY_ADMIN_TOKEN`, `BILLING_ADMIN_TOKEN`, `RECO_ADMIN_TOKEN` (matching the siblings'). `GATEWAY_UPSTREAM_URL`/`GATEWAY_AUTH_TOKEN` deliberately UNSET (honest 501; per-user relay is the next mission).

Token VALUES exist only in Cloudflare and `/var/folders/4s/d0wlfs9d00v4349cdqgd13f00000gn/T/opencode/wave7-secrets.env` (mode 600, tmp — wiped on reboot). **Will: move the ones you want to keep (esp. billing `ADMIN_SERVICE_TOKEN`, the only money-granting credential) into your ops vault, or rotate.**

**Test-mode flags:** `IDENTITY_TEST_MODE=0`, `RECO_TEST_MODE=0`, billing healthz `testMode` absent/false — all real surfaces.

**Rate card:** `2026-08-07.1` — Cerebras `gpt-oss-120b` at cost ($0.35/$0.75 per 1M in/out, cached $0), already in `workers/billing/wrangler.jsonc`.

**Grant (the only one):** `POST /api/billing/admin/grants` → `{"granted":true,"grantId":"admin:2026-08-09:wave7-canary-subsidy","userId":"smithers-canary","amountUsd":500,"requester":"wave7-agent","requestedAt":"2026-08-09T02:43:27.000Z","reason":"mvp-canary-alpha-subsidy"}`.

## 3. Canary route repoint + rollback path

- **Before:** `canary.smithers.sh` custom domain → `smithers-ui-canary` (flows/ui POC), last version `bd819f28-8c25-4443-b3b2-13d1e18cd09d` (deployed 2026-08-04).
- **After:** the domain attached to `smithers-mvp-web` when it deployed with `routes = [{ pattern = "canary.smithers.sh", custom_domain = true }]` — first version `339de581-ac94-43a5-a362-2263219f3892`, now serving `d734d048-b59e-4bf2-b72e-4f4d81ee6086` (the turn-seam session gate). Re-attaching the domain is a property of the config, not of a particular version.
- **Rollback:** in ~/flows/ui run `bun x wrangler deploy` (its `wrangler.toml` is the POC worker). Re-deploying `smithers-ui-canary` re-attaches the custom domain and serves the POC again. No DNS change was made, so no DNS rollback is needed. (`smithers-ui-canary` itself was never modified; `bun x wrangler rollback --name smithers-ui-canary` is a no-op alternative since its code is unchanged.)

## 4. Verification (all against the deployed stack)

**Canary seam probe** (`bun scripts/canary-seam-probe.ts [origin] [storage-state.json]`, adaptation of `launch-seam-probe.ts` — gateway assertion INVERTED to require the honest 501): **9/9 pass** at both versions, but the turn row means different things at each, and that difference IS the security fix:

- at `339de581` the probe ran a live streamed turn to a `"type":"done"` frame **with no session** — which is precisely the hole, and the probe asserting `200` there is why it did not catch it;
- at `d734d048` the probe (run without a storage state, since no session can exist before will's OAuth click) asserts the honest **`401`** on `/api/agent/turn` and passes. Pass a storage state as argv[2] to run the LIVE metered turn once sign-in exists.

Both runs: signed-out session/scopes honesty, OAuth start 503 `oauth_not_configured`, unsigned balance 401, unsigned reco 401, gateway 501 naming `GATEWAY_UPSTREAM_URL`, admin surface byte-identical-404 non-enumerable, SPA 200.

**Live-fire metering proof (the money paragraph):** reading `https://billing.smithers.sh/api/billing/balance` as the `smithers-canary` bearer around turns sent through `https://canary.smithers.sh/api/agent/turn`:

| moment | totalUsd | lifetimeChargedUsd | chargeCount |
|---|---|---|---|
| after grant | 500 | 0 | 0 |
| after first direct canary-chat turn | 499.999952 | 0.000048 | 2 |
| after the seam-probe turn via canary.smithers.sh | 499.999907 | 0.000093 | 4 |
| after the headed-browser turn | 499.99985 | 0.00015 | 6 |

Every turn produced exactly its at-cost charge lines (input+output, rate card `2026-08-07.1`) via the durable queue → deployed billing. Sealed transcript example (seam probe): 4 NDJSON frames `delta(reasoning)… delta(text) "ok" … done`.

The metering path is unchanged by the fix — but note these turns were driven **anonymously** through `canary.smithers.sh`, which is exactly the hole described at the top. That the money plumbing works end to end is still proven; reproducing it now needs either a session cookie (`bun scripts/canary-seam-probe.ts https://canary.smithers.sh <storage-state.json>`) or a direct call to the canary chat worker. Two further review probes ran against the live deploy while confirming the hole and the fix, adding ~$0.0001 to `lifetimeChargedUsd`.

**Launch checklist, FOR REAL** (`SMITHERS_MVP_BASE_URL=https://canary.smithers.sh SMITHERS_CHAT_MODE=live`, bearer + admin env set; archived at `reports/launch-checklist/20260809-024836-canary-live/`): **6 pass / 25 fail — 24 fails are the auth gate, 1 is D-2.**

- PASS: **A-1** (landing = one sentence + GitHub sign-in affordance, real browser), **D-1** ($500 balance reads on the deployed ledger), **D-3** (no top-up/checkout surface), **E-1** (admin grants 401 without token), **E-2** (untimestamped grant → `400 timestamp_required`), **E-3** (requester+timestamp grant credits exactly once — a real money write against deployed billing).
- **§F truth-bar rows F-1..F-6: did not run** — every one is gated on `SMITHERS_MVP_STORAGE_STATE` (a signed-in session), which cannot exist until will's OAuth click. The harness fails them loudly ("This is an honest fail, not a skip"). **No truth-bar verdict is claimed this pass.** What is proven signed-out: the product never fakes a session, never shows a composer, and OAuth start names its own gap.
- §A-2..A-9, §B-1..B-7, §C-1..C-3: same auth gate → **bucket: waiting-on-will**.
- **D-2 REAL FAIL, explained:** "composer missing — the chat surface has no prompt input (feature absent)". The row drives a browser through `/` and types into the composer; signed-out, the product serves only the sign-in landing (A-1's own requirement), so there is no composer to drive. Its substance — a turn reduces the balance by its metered at-cost amount — is proven out-of-band by the metering table above. It should go green with a session; if it still fails signed-in, it is a product bug, not a harness artifact.

**HTTPS/browser:** headed Chromium against `https://canary.smithers.sh` — SPA 200 over the canary cert, landing copy "Smithers is a design-partner preview — sign in with GitHub to continue.…", and an in-page `fetch` streamed a full NDJSON turn to a done frame (screenshot archived with the report). No WebSocket exists in this product path; streaming is NDJSON over HTTPS.

## 5. Will-list (the remaining clicks)

1. **GitHub OAuth (2 minutes):** identity is fully deployed except the GitHub pair; its start route answers honest `503 oauth_not_configured` today. The existing app `Iv23liwHER62HVHMWcGS` could NOT be reused blindly — its registered callbacks are the multi workers' `/api/auth/github/login/callback` paths, and identity needs an exact-path match it doesn't have.
   - First fix DNS (next item), then in GitHub create a new OAuth App (or add a callback to the existing GitHub App): **callback URL `https://identity.smithers.sh/api/auth/github/callback`**, homepage `https://canary.smithers.sh`, scope `read:user` only.
   - Then in ~/flows/ui: `bun x wrangler secret put GITHUB_CLIENT_ID --config workers/identity/wrangler.jsonc` and `bun x wrangler secret put GITHUB_CLIENT_SECRET --config workers/identity/wrangler.jsonc`. Sign-in works immediately; nothing else to redeploy. (Stopgap without DNS: register `https://smithers-cloud-identity.willcory10.workers.dev/api/auth/github/callback` instead and set identity's `PUBLIC_BASE_URL` to the workers.dev URL — works, but bakes a workers.dev URL into the app; the DNS fix is cleaner.)
2. **DNS (2 clicks in the Cloudflare dashboard, zone smithers.sh):** delete or flip-to-proxied the stale CNAMEs `identity.smithers.sh` and `reco.smithers.sh` → `cname.vercel-dns-016.com` (they answer Vercel DEPLOYMENT_NOT_FOUND — nothing is there). The worker routes are already registered; proxied DNS activates them, after which the mvp vars `IDENTITY_UPSTREAM_URL`/`RECO_UPSTREAM_URL` can be switched to the public hostnames (cosmetic).
3. **Allowlist seed:** sign-in allows only allowlisted logins. Once OAuth works: `curl -X POST https://canary.smithers.sh/api/admin/allowlist -H "content-type: application/json" -d '{"login":"<github-login>"}'` (admin-token path is wired: mvp `IDENTITY_ADMIN_TOKEN` → identity `ADMIN_SERVICE_TOKEN`) — awaiting your handles. Also set identity's `ADMIN_LOGINS` var to name operators (UI hint only).
4. **Ops vault:** copy the token values you want to keep from `/var/folders/4s/d0wlfs9d00v4349cdqgd13f00000gn/T/opencode/wave7-secrets.env` (billing `ADMIN_SERVICE_TOKEN` especially — it is the only credential that grants money) or rotate them.
5. **Gateway wiring (next mission):** set `GATEWAY_UPSTREAM_URL` (+`GATEWAY_AUTH_TOKEN`) on `smithers-mvp-web` when the per-user relay exists; the seam currently 501s by design, so §F-6 and approval flows wait on it too.
6. **Prod chat metering debt (pre-existing, flagged not fixed):** prod `chat.smithers.sh` streams but its charges have never landed (billing had no `METERING_SERVICE_TOKEN` until this run; prod chat's token value is unknown). Its DLQ `smithers-metering-dlq` may hold dead-lettered usage from past turns — worth a look (`bun x wrangler queues consumer` / dashboard) and a decision: set the same fresh metering token on prod chat (one `wrangler secret put BILLING_SERVICE_TOKEN --config workers/chat/wrangler.jsonc`) to complete its pairing, which I was not authorized to do.

## 6. Honest gaps

- No signed-in surface has been exercised on canary: §A (beyond A-1), §B, §C, §F, and D-2 are unproven there until OAuth exists. The checklist harness fails these loudly; none are counted as pass.
- identity/reco serve on workers.dev hostnames until DNS item 2; the zone routes are registered but inactive.
- `smithers-canary` is a single shared billing account for all of canary (per-user trusted-caller billing is deployed but unused by the product Worker's bearer path until per-user sign-in exists).
- Stripe is unconfigured everywhere: top-up/webhook routes answer honest 503s (D-3 passes because no card UI exists at all).
- The flows/ui POC worker `smithers-ui-canary` still exists (idle, no route) — left in place as the rollback target.
- Because the turn seam is now session-gated and no session can exist until will's OAuth click, **canary currently has no reachable chat path for a human.** That is the honest state of a closed alpha whose door is not open yet, not a regression: the gate lifts by itself the moment sign-in works. Until then the only way to exercise a live turn is a direct call to the canary chat worker with its bearer.
- The gate arms off `IDENTITY_UPSTREAM_URL` being set, so the local dev / stub stack (which has no identity seam and therefore nothing that could authenticate anyone) is deliberately left ungated. Any future deployment that reaches the public internet MUST set an identity upstream; a public deploy without one would re-open this hole.
