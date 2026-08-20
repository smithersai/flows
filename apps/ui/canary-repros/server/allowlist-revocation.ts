/*
 * Repro — removing a login from the closed-alpha allowlist revokes nothing at
 * the seams, and an admin can revoke itself through the only door that could
 * undo it.
 *
 * The server half of checklist row 1.5 (../access/1.5.md). Three defects, one
 * chain:
 *
 *  1. identity derives the session's `admin` claim from its ADMIN_LOGINS var
 *     alone, so a de-allowlisted login comes back
 *     `allowlisted: false, admin: true`;
 *  2. the product Worker's /api/admin/* gate reads only `admin`, so that
 *     session keeps the whole admin surface — the allowlist editor included;
 *  3. the recommendations worker never reads the allowlist at all, so it serves
 *     the full non-degraded digest to an account the alpha just removed.
 *
 * Fixing (1) and (2) makes a self-removal a ONE-WAY door: it revokes the
 * caller's own admin claim, and this route is the only door that could restore
 * it. So the product refuses a self-removal outright, and THAT is what this
 * repro drives — it is the one clause of the chain a single test login can
 * observe live without locking itself out of the alpha.
 *
 * The cross-account clauses (a DIFFERENT login's session going
 * allowlisted:false -> admin:false, its /api/admin/* going 404, its
 * /api/reco/first-run going 403) need a second GitHub account — checklist §0.4
 * names that gap. They are covered by unit tests instead:
 *   apps/server/src/invite-mechanics.test.ts
 *   ~/flows/ui/workers/identity/src/index.test.ts
 *   ~/flows/ui/workers/recommendations/src/index.test.ts
 *
 * This repro NEVER de-allowlists anyone. It leaves the allowlist untouched.
 *
 *   bun allowlist-revocation.ts   exit 1 while the bug is present, 0 once it is fixed.
 */
import { chromium } from "playwright";
import { withVerifiedRestoration } from "../../scripts/canary-restoration";
import { BASE, ensureSignedIn, PROFILE, report, seam, session } from "./_lib";

const LOGIN = process.env.CANARY_LOGIN ?? "codeplanesmithers";
const IDENTITY = process.env.IDENTITY_UPSTREAM_URL ?? "https://smithers-cloud-identity.willcory10.workers.dev";
const ADMIN_TOKEN = process.env.IDENTITY_ADMIN_TOKEN ?? "";
if (ADMIN_TOKEN === "") {
	throw new Error("IDENTITY_ADMIN_TOKEN is required so restoration is independent of the session being revoked");
}

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1280, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const before = (await ensureSignedIn(page)) as { allowlisted?: boolean; admin?: boolean } | null;
console.log("session:", JSON.stringify(before));

const failures: Array<string> = [];
if (before?.admin !== true || before?.allowlisted !== true) {
	console.error(
		`this repro needs an allowlisted admin session for ${LOGIN}; got ${JSON.stringify(before)} — not run`,
	);
	await context.close();
	process.exit(2);
}

const selfRemove = await seam(page, "POST", "/api/admin/allowlist", { login: LOGIN, action: "remove" });
console.log(`POST /api/admin/allowlist {"login":"${LOGIN}","action":"remove"} -> ${selfRemove.status} ${selfRemove.body}`);
if (selfRemove.status === 201 || selfRemove.status === 200) {
	await withVerifiedRestoration(
		async () => {
			failures.push(
				`an admin removed its OWN login from the allowlist (HTTP ${selfRemove.status}) — the one write that revokes the door that could undo it`,
			);
		},
		async () => {
			const restore = await fetch(new URL("/api/identity/admin/allowlist", IDENTITY), {
				method: "POST",
				headers: { "content-type": "application/json", "x-smithers-admin-token": ADMIN_TOKEN },
				body: JSON.stringify({
					login: LOGIN,
					action: "add",
					requester: "uicanaries-allowlist-recovery",
					timestamp: new Date().toISOString(),
				}),
			});
			const body = await restore.text();
			console.log(`out-of-band restore: ${restore.status} ${body.slice(0, 200)}`);
			if (!restore.ok) throw new Error(`identity restore answered HTTP ${restore.status}: ${body.slice(0, 200)}`);
		},
		async () => {
			await page.reload({ waitUntil: "domcontentloaded" });
			const restored = (await session(page)) as { allowlisted?: boolean; admin?: boolean } | null;
			if (restored?.allowlisted !== true || restored?.admin !== true) {
				throw new Error(`session still has the wrong claims: ${JSON.stringify(restored)}`);
			}
		},
		`POST ${IDENTITY}/api/identity/admin/allowlist for ${LOGIN} with an identity ADMIN_SERVICE_TOKEN`,
	);
} else if (selfRemove.status !== 409) {
	failures.push(`the self-removal answered HTTP ${selfRemove.status}; the honest refusal is a 409 that names why`);
} else if (!selfRemove.body.includes("your own login")) {
	failures.push(`the 409 does not name what was refused: ${selfRemove.body}`);
}

const after = (await session(page)) as { allowlisted?: boolean; admin?: boolean } | null;
console.log("session after:", JSON.stringify(after));
if (after?.allowlisted !== true || after?.admin !== true) {
	failures.push(`the run changed the caller's own standing: ${JSON.stringify(after)} — restore ${LOGIN} by hand`);
}

/* The surface is still there for a login that IS allowlisted. */
const health = await seam(page, "GET", "/api/admin/health");
console.log(`GET /api/admin/health -> ${health.status}`);
if (health.status !== 200) failures.push(`an allowlisted admin lost the admin surface (HTTP ${health.status})`);

await context.close();
report(failures);
