/*
 * Repro — checklist row 27.7 ("The updater path: confirm it is configured").
 *
 * It is not. `apps/ui/electrobun.config.ts` declares no `build.baseUrl`, so
 * `electrobun build --env=canary` skips patch generation and says so, and the
 * generated `update.json` points at nothing a running app can fetch. An
 * installed app therefore has no update channel.
 *
 *   bun 27.7.ts
 *   exit 1 while the updater is unconfigured, 0 once a baseUrl is set.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const UI = "/Users/williamcory/flows/flows/apps/ui";
const CONFIG = join(UI, "electrobun.config.ts");
const ARTIFACTS = join(UI, "artifacts");

const config = readFileSync(CONFIG, "utf8");
const hasBaseUrl = /baseUrl\s*:/.test(config);
console.log("electrobun.config.ts declares build.baseUrl:", hasBaseUrl);

const updateJson = join(ARTIFACTS, "canary-macos-arm64-update.json");
if (existsSync(updateJson)) {
	console.log("artifacts/update.json:", readFileSync(updateJson, "utf8").trim().slice(0, 400));
} else {
	console.log("artifacts/update.json: (absent — run bun run build:canary first)");
}

console.log(
	'build:canary said: "No baseUrl configured, skipping patch generation / To enable patch generation, configure baseUrl in your electrobun.config"',
);

if (hasBaseUrl) {
	console.log("PASS — the updater has a baseUrl.");
	process.exit(0);
}
console.error("FAIL: the updater is not configured — electrobun.config.ts sets no build.baseUrl, so the build skips patch generation and an installed app has no update channel.");
process.exit(1);
