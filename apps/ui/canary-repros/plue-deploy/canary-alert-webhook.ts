#!/usr/bin/env bun
/**
 * Repro: canary failure alerts never reach the receiver.
 *
 * Both canaries POST to CANARY_ALERT_WEBHOOK_URL, which carries HTTP basic-auth
 * credentials as `https://user:pass@host/path`. `fetch` drops URL userinfo
 * instead of sending it, so /api/internal/alerts/incident sees an anonymous
 * request and answers 401 — every failure notification since the receiver was
 * introduced has been silently lost.
 *
 * Run:
 *   CANARY_ALERT_WEBHOOK_URL="$(kubectl get secret smithers-secrets -n smithers \
 *     -o jsonpath='{.data.CANARY_ALERT_WEBHOOK_URL}' | base64 -d)" \
 *     bun canary-alert-webhook.ts
 *
 * Exits non-zero while the credential-in-URL form is rejected. Prints only
 * status codes and the URL host — never the credentials.
 */
const raw = process.env.CANARY_ALERT_WEBHOOK_URL?.trim() ?? "";
if (!raw || !URL.canParse(raw)) {
  console.error("CANARY_ALERT_WEBHOOK_URL must be set to the real webhook URL");
  process.exit(2);
}

const parsed = new URL(raw);
if (!parsed.username && !parsed.password) {
  console.error("This webhook URL carries no userinfo; the defect does not apply to it");
  process.exit(2);
}

const body = JSON.stringify({
  text: "canary-repro probe (no incident payload, expected to be rejected)",
  run_id: "canary-repro",
  workflow: "Production Canary",
});

// 1. What the shipped code does: hand the credential-bearing URL to fetch.
const asShipped = await fetch(raw, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
});

// 2. The same request with the credentials moved into an Authorization header.
const credentials = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
parsed.username = "";
parsed.password = "";
const withHeader = await fetch(parsed.toString(), {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Basic ${btoa(credentials)}`,
  },
  body,
});

console.log(`host=${parsed.host}`);
console.log(`credentials in URL      -> ${asShipped.status}`);
console.log(`credentials in header   -> ${withHeader.status}`);

if (asShipped.status === 401 && withHeader.status !== 401) {
  console.error(
    "\nBUG PRESENT: fetch drops the URL userinfo, so the receiver rejects every notification as anonymous.",
  );
  process.exit(1);
}

console.log("\nNo difference: the deployed code authenticates against this webhook.");
