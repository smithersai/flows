/**
 * Scripted deploy: `vite build` for the SPA (apps/ui), then `wrangler deploy`
 * for the Worker (apps/server), recording a receipt (git sha + timestamp +
 * wrangler version id) either way.
 *
 *   bun scripts/deploy.ts --dry-run
 *     Runs the real vite build, then `wrangler deploy --dry-run` — no
 *     Cloudflare credentials needed, nothing published. Receipt lands in
 *     deploy-receipts/dry-run/.
 *
 *   bun scripts/deploy.ts
 *     Real deploy. Requires CLOUDFLARE_API_TOKEN (or `wrangler login`).
 *     Receipt lands in deploy-receipts/.
 *
 * The Worker identity (name `smithers-mvp-web`, the canary.smithers.sh route)
 * is frozen — see apps/server/DEPLOY.md and wrangler.jsonc:1-9. This script
 * never changes wrangler.jsonc; it only builds and deploys what's there.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dryRun = process.argv.includes("--dry-run");

const serverDir = fileURLToPath(new URL("..", import.meta.url));
const uiDir = fileURLToPath(new URL("../../ui", import.meta.url));

const run = async (
	cmd: ReadonlyArray<string>,
	options: { cwd: string; capture?: boolean },
): Promise<{ exitCode: number; output: string }> => {
	const proc = Bun.spawn([...cmd], {
		cwd: options.cwd,
		stdout: options.capture === true ? "pipe" : "inherit",
		stderr: "inherit",
	});
	const output = options.capture === true ? await new Response(proc.stdout).text() : "";
	if (options.capture === true) process.stdout.write(output);
	const exitCode = await proc.exited;
	return { exitCode, output };
};

console.log(`[deploy] building the SPA (vite build) in ${uiDir}...`);
const build = await run(["bun", "run", "build"], { cwd: uiDir });
if (build.exitCode !== 0) {
	console.error("[deploy] vite build failed.");
	process.exit(build.exitCode);
}

console.log(`[deploy] ${dryRun ? "dry-run " : ""}wrangler deploy in ${serverDir}...`);
const deployArgs = ["bun", "x", "wrangler", "deploy", ...(dryRun ? ["--dry-run"] : [])];
const deploy = await run(deployArgs, { cwd: serverDir, capture: true });
if (deploy.exitCode !== 0) {
	console.error("[deploy] wrangler deploy failed.");
	process.exit(deploy.exitCode);
}

const gitSha = await run(["git", "rev-parse", "HEAD"], { cwd: serverDir, capture: true });
const versionIdMatch = /Current Version ID:\s*([0-9a-f-]{36})/i.exec(deploy.output);

const receipt = {
	worker: "smithers-mvp-web",
	dryRun,
	gitSha: gitSha.output.trim(),
	timestamp: new Date().toISOString(),
	wranglerVersionId: versionIdMatch?.[1] ?? null,
};

const receiptDir = dryRun ? `${serverDir}deploy-receipts/dry-run` : `${serverDir}deploy-receipts`;
mkdirSync(receiptDir, { recursive: true });
const receiptPath = `${receiptDir}/${receipt.timestamp.replace(/[:.]/g, "-")}.json`;
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, "\t")}\n`);
writeFileSync(`${receiptDir}/latest.json`, `${JSON.stringify(receipt, null, "\t")}\n`);

console.log(`[deploy] receipt written to ${receiptPath}`);
