/*
 * Repro — checklist row 27.1 ("`bun run build:canary` produces a launchable
 * app") for the Electrobun desktop build.
 *
 * The build SUCCEEDS and the app LAUNCHES, but the app it produces has no
 * backend: `apps/ui/src/bun/index.ts` falls back to `views://mainview/index.html`
 * for any channel other than `dev` unless `SMITHERS_APP_URL` is set, and
 * `build:canary` sets nothing. Every relative `/api/*` fetch in the renderer
 * then resolves against the `views://` scheme and returns empty — the first one
 * the app makes fails on startup:
 *
 *   ERROR ========== empty response for URL: views://mainview/api/auth/session
 *
 * So the shipped canary app opens a window that can never sign in.
 *
 * This repro drives the LOCAL build, not the canary origin — the desktop app is
 * a native WKWebView with no CDP endpoint, so Playwright cannot attach to it.
 * It asserts on the build output and the launcher's own stdout.
 *
 *   bun 27.1.ts
 *   exit 1 while the bug is present, 0 once the built app reaches a backend.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const UI = "/Users/williamcory/flows/flows/apps/ui";
const APP = join(UI, "build/canary-macos-arm64/Smithers-canary.app");
const LAUNCHER = join(APP, "Contents/MacOS/launcher");

if (!existsSync(LAUNCHER)) {
	console.error(`SETUP: no build at ${APP}. Run: cd ${UI} && bun run build:canary`);
	process.exit(2);
}
console.log("app bundle:", APP);

const log = await new Promise<string>((resolve) => {
	const child = spawn(LAUNCHER, [], { cwd: join(APP, "Contents/MacOS"), env: { ...process.env, SMITHERS_APP_URL: "" } });
	let out = "";
	child.stdout.on("data", (chunk) => (out += String(chunk)));
	child.stderr.on("data", (chunk) => (out += String(chunk)));
	setTimeout(() => {
		child.kill("SIGTERM");
		resolve(out);
	}, 20_000);
});
console.log("--- launcher output ---");
console.log(log.trim());
console.log("-----------------------");

const launched = log.includes("Smithers app started!");
const noBackend = log.includes("empty response for URL: views://mainview/api/");
console.log("launched:", launched, "| api calls resolve against views:// :", noBackend);

if (launched && !noBackend) {
	console.log("PASS — the built app launches and reaches a backend.");
	process.exit(0);
}
if (!launched) console.error("FAIL: the built app did not launch.");
if (noBackend) {
	console.error(
		"FAIL: the built canary app loads views://mainview/index.html, so every /api/* call resolves against the views:// scheme and returns empty — the app can never sign in.",
	);
}
process.exit(1);
