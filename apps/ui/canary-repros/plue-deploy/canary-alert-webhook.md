# Canary failure alerts are dropped with 401

- **Lane:** plue-deploy
- **Target:** `https://api.jjhub.tech/api/internal/alerts/incident`
- **Workloads:** CronJobs `smithers-backend-canary-cheap` and `smithers-playwright-canary`
- **Repro script:** `canary-alert-webhook.ts`

## Steps

1. `kubectl logs -n smithers <canary pod> --tail=20`
2. Observe the notification failure at the end of every failing run.
3. Reproduce in isolation:

```
CANARY_ALERT_WEBHOOK_URL="$(kubectl get secret smithers-secrets -n smithers \
  -o jsonpath='{.data.CANARY_ALERT_WEBHOOK_URL}' | base64 -d)" \
  bun canary-alert-webhook.ts
```

## Expected

A failing canary run posts a notification the alert receiver accepts.

## Actual

```
[canary] failure notification failed: warn: failure notification returned 401
```

and from the Playwright canary (`e2e/scripts/run-canary.ts:220`):

```
error: failure notification returned 401
```

Repro output:

```
host=api.jjhub.tech
credentials in URL      -> 401
credentials in header   -> 400

BUG PRESENT: fetch drops the URL userinfo, so the receiver rejects every notification as anonymous.
```

## Root cause

`CANARY_ALERT_WEBHOOK_URL` is `https://<user>:<pass>@api.jjhub.tech/api/internal/alerts/incident`.
`internal/routes/alert_webhook.go` `Receive` requires HTTP basic auth
(`r.BasicAuth()`), but `fetch` does not send URL userinfo as an `Authorization`
header — verified against a local Bun server, which received `authorization: null`.
Both `sendFailureNotification` in `.smithers/workflows/canary-runner.ts` and
`notifyFailure` in `e2e/scripts/run-canary.ts` passed the credential-bearing URL
straight to `fetch`, so the receiver always saw an anonymous request.

Fixed in `~/plue` commit `a1cdd3de`: the userinfo moves into an
`Authorization: Basic` header and is stripped from the request URL. Unit
coverage added in `.smithers/workflows/canary-runner.test.ts` (28 tests pass).

## Still open after the fix — needs a human decision

Authentication now succeeds and the receiver answers **400** instead: it parses
a GCP-monitoring incident envelope
(`{"incident":{"incident_id":…,"policy_name":…,"state":…,"summary":…,"url":…}}`,
`internal/routes/alert_webhook.go:64`) while both canaries post
`{"text":…,"run_id":…,"workflow":…}`. Either

- repoint `CANARY_ALERT_WEBHOOK_URL` at a chat webhook that accepts the
  `{text,…}` shape, or
- make the canaries emit an incident envelope for this receiver.

Guessing between those would have shipped synthetic incidents into the
production alert pipeline, so it was left for the owner.
