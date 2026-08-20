/*
 * Repro — checklist row 1.5 ("A non-allowlisted account cannot reach admin
 * flows. `/admin.*` is unregistered for them — the flow is absent, not
 * present-and-refusing.") against https://canary.smithers.sh.
 *
 * The app gates the admin plugin on the session's `admin` claim, and identity
 * derives `admin` from the ADMIN_LOGINS env var, NOT from the allowlist
 * (workers/identity/src/index.ts, sessionAnswer). Removing a login from the
 * closed-alpha allowlist therefore does not revoke anything: the session comes
 * back `allowlisted: false, admin: true`, the shell still lists all ten
 * `admin.*` flows in `data-flows`, and GET /api/admin/requests still answers
 * 200 with the real queue.
 *
 * The repro drives that with the product's OWN audited door: it removes the
 * login from the allowlist through POST /api/admin/allowlist, reads the state,
 * and restores the row in a `finally` block. It leaves the allowlist exactly
 * as it found it.
 *
 *   bun 1.5.ts        exit 1 while the bug is present, 0 once it is fixed.
 */
import { chromium } from "playwright";
import { withVerifiedRestoration } from "../../scripts/canary-restoration";
import { BASE, ensureSignedIn, PROFILE, registry, report, session } from "./_lib";

const LOGIN = process.env.CANARY_LOGIN ?? "codeplanesmithers";

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1280, height: 1000 } });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
await ensureSignedIn(page);

const allowlist = (action: "add" | "remove"): Promise<{ status: number; body: string }> =>
	page.evaluate(async ([login, act]: Array<string>) => {
		const response = await fetch("/api/admin/allowlist", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ login, action: act }),
		});
		return { status: response.status, body: (await response.text()).slice(0, 300) };
	}, [LOGIN, action]);

const before = await session(page);
console.log("session before:", JSON.stringify(before));
if (!JSON.stringify(before).includes('"admin":true')) {
	console.error("precondition failed: this repro needs the admin session that owns the allowlist door");
	process.exit(2);
}

const failures: Array<string> = [];
const removed = await allowlist("remove");
console.log("remove:", JSON.stringify(removed));
if (removed.status < 200 || removed.status >= 300) {
	await context.close();
	throw new Error(`precondition failed: removing ${LOGIN} answered HTTP ${removed.status}: ${removed.body}`);
}

await withVerifiedRestoration(
	async () => {
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForTimeout(8000);

		const during = await session(page);
		console.log("session while NOT allowlisted:", JSON.stringify(during));
		if (!JSON.stringify(during).includes('"allowlisted":false')) {
			throw new Error("precondition failed: the session is still allowlisted after a successful removal");
		}

		const adminFlows = (await registry(page)).filter((name) => name.startsWith("admin."));
		console.log("admin.* still registered:", JSON.stringify(adminFlows));
		if (adminFlows.length > 0) {
			failures.push(`a non-allowlisted session still has ${adminFlows.length} admin flows registered: ${adminFlows.join(", ")}`);
		}

		const requests = await page.evaluate(async () => {
			const response = await fetch("/api/admin/requests");
			return { status: response.status, body: (await response.text()).slice(0, 200) };
		});
		console.log("GET /api/admin/requests while NOT allowlisted:", JSON.stringify(requests));
		if (requests.status === 200) {
			failures.push("a non-allowlisted session still reads GET /api/admin/requests (HTTP 200), instead of the canonical 404");
		}
	},
	async () => {
		const restored = await allowlist("add");
		console.log("restore:", JSON.stringify(restored));
		if (restored.status < 200 || restored.status >= 300) {
			throw new Error(`allowlist add answered HTTP ${restored.status}: ${restored.body}`);
		}
	},
	async () => {
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForTimeout(5000);
		const restored = await session(page);
		console.log("session restored:", JSON.stringify(restored));
		if (!JSON.stringify(restored).includes('"allowlisted":true')) {
			throw new Error(`session still is not allowlisted: ${JSON.stringify(restored)}`);
		}
	},
	`re-add ${LOGIN} through the identity admin service credential`,
);

await context.close();
report(failures);
