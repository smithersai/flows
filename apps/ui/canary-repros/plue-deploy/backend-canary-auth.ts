#!/usr/bin/env bun
/**
 * Repro: production Sign-in-with-Key rejects the backend canary's identity, so
 * the `auth` probe in the smithers-backend-canary-cheap CronJob fails every run.
 *
 * Two independent defects stack here:
 *   1. .smithers/workflows/canary-runner.ts signed the EIP-4361 domain/URI
 *      derived from CANARY_API_BASE_URL (api.jjhub.tech). The API binds
 *      signatures to auth.key_auth_domain (smithers.sh), so verification failed
 *      with 401 {"message":"invalid signature"}.
 *   2. The canary wallet 0xBE00A86AD1490C7d78C12f8DdA3AD2eA3E75364f has no user
 *      and no `wallet` row in alpha_whitelist_entries, so once the signature
 *      does verify the API answers 403 closed-alpha.
 *
 * This script proves (1) with a throwaway key and a deliberately bogus nonce,
 * so it creates nothing: a domain the server accepts fails on the nonce, a
 * domain it rejects fails on the signature.
 *
 * Run:  bun backend-canary-auth.ts
 * Exits non-zero while the API host is not the accepted key-auth domain.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const API = process.env.CANARY_API_BASE_URL ?? "https://api.jjhub.tech";
const BOGUS_NONCE = "00000000000000000000000000000000";

function message(domain: string, uri: string, address: string, nonce: string): string {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to Smithers",
    "",
    `URI: ${uri}`,
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
}

async function verify(domain: string, uri: string): Promise<{ status: number; body: string }> {
  const account = privateKeyToAccount(generatePrivateKey());
  const signed = message(domain, uri, account.address, BOGUS_NONCE);
  const signature = await account.signMessage({ message: signed });
  const response = await fetch(`${API}/api/auth/key/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: signed, signature }),
  });
  return { status: response.status, body: (await response.text()).trim() };
}

const apiHost = new URL(API).host;
const asApiHost = await verify(apiHost, API);
const asSignInDomain = await verify("smithers.sh", "https://smithers.sh");

console.log(`domain=${apiHost} -> ${asApiHost.status} ${asApiHost.body}`);
console.log(`domain=smithers.sh -> ${asSignInDomain.status} ${asSignInDomain.body}`);

const rejectsApiHost = asApiHost.body.includes("invalid signature");
const acceptsSignInDomain = asSignInDomain.body.includes("nonce");

if (rejectsApiHost && acceptsSignInDomain) {
  console.error(
    `\nBUG PRESENT: the API accepts signatures over "smithers.sh" but the canary signs "${apiHost}".`,
  );
  process.exit(1);
}

console.log("\nNo mismatch: the API accepts the domain the canary derives from its API base URL.");
