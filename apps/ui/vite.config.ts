import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { installAgentApi } from "./src/dev/AgentApi";

/*
 * Every vite invocation in package.json passes `--configLoader runner`. This
 * config reaches the `smithers-shared` workspace package (through AgentApi),
 * which ships TypeScript source; the default `bundle` loader hands bare
 * specifiers to node's ESM loader, which cannot resolve that package's
 * extensionless relative imports. The runner loader resolves the config
 * through Vite itself, so the workspace source loads the same way it does in
 * the app graph.
 */

const crossOriginIsolationHeaders = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
};

/**
 * Pure-web Smithers chat boundary. The browser posts turns to the same-origin
 * `/api/agent` routes and reads the same NDJSON AgentTurnFrame stream the native app
 * renders; the upstream chat.smithers.sh URL/origin stay server-side via
 * SMITHERS_CHAT_URL / SMITHERS_CHAT_ORIGIN (defaults match the native CloudAgent).
 */
const smithersAgentApi = (): Plugin => {
	const options = {
		chatUrl: process.env.SMITHERS_CHAT_URL,
		origin: process.env.SMITHERS_CHAT_ORIGIN,
	};
	return {
		name: "smithers-agent-api",
		configureServer: (server) => installAgentApi(server.middlewares, options),
		configurePreviewServer: (server) => installAgentApi(server.middlewares, options),
	};
};

/*
 * Resolved against this file, not the shell's working directory: `vite
 * --config apps/ui/vite.config.ts` from the repository root used to serve 404s
 * because a bare "src/mainview" resolved under the root instead. Every path
 * below is absolute for the same reason.
 */
const here = fileURLToPath(new URL(".", import.meta.url));

/** The deployed seams dev rides. */
const devUpstream = process.env.SMITHERS_DEV_UPSTREAM ?? "https://canary.smithers.sh";

/** The subset of node's ClientRequest the proxy hook touches. */
interface ProxyRequest {
	readonly getHeader: (name: string) => unknown;
	readonly setHeader: (name: string, value: string) => void;
}

/*
 * CN-1: the build stamp. The deployed SPA is the artifact that goes stale, so
 * it must be able to state which commit it was built from. The stamp is
 * written by the build and travels inside the bundle: a meta tag on the served
 * HTML and a `__build.json` asset next to the hashed chunks. Nothing computes
 * it at request time, so a stale bundle cannot claim to be fresh — serving a
 * fresh stamp means serving a fresh bundle.
 *
 * SMITHERS_BUILD_SHA wins so apps/server/scripts/deploy.ts stamps the same sha
 * it writes into the deploy receipt; GITHUB_SHA covers a CI build; otherwise
 * the local checkout is asked. A tree with no git answers "unknown", which the
 * canary probe reports as a failure rather than passing on a fabricated value.
 *
 * The reader is apps/server/scripts/canary/BuildStamp.ts. The two constants
 * below are duplicated there on purpose — apps/ui does not depend on
 * apps/server — and BuildStamp.test.ts reads this file to hold them equal.
 */
const BUILD_STAMP_ASSET = "__build.json";
const BUILD_STAMP_META = "smithers-build-sha";

const resolveBuildSha = (): string => {
	const fromEnv = process.env.SMITHERS_BUILD_SHA ?? process.env.GITHUB_SHA;
	if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
};

const buildStamp = (): Plugin => {
	const gitSha = resolveBuildSha();
	const builtAt = new Date().toISOString();
	return {
		name: "smithers-build-stamp",
		apply: "build",
		transformIndexHtml: () => [
			{ tag: "meta", attrs: { name: BUILD_STAMP_META, content: gitSha }, injectTo: "head" as const },
			{ tag: "meta", attrs: { name: "smithers-build-at", content: builtAt }, injectTo: "head" as const },
		],
		generateBundle() {
			this.emitFile({
				type: "asset",
				fileName: BUILD_STAMP_ASSET,
				source: `${JSON.stringify({ worker: "smithers-mvp-web", gitSha, builtAt }, null, "\t")}\n`,
			});
		},
	};
};

export default defineConfig({
	plugins: [react(), smithersAgentApi(), buildStamp()],
	root: `${here}src/mainview`,
	build: {
		outDir: `${here}dist`,
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		strictPort: true,
		headers: crossOriginIsolationHeaders,
		/*
		 * Dev rides the DEPLOYED seams: everything the product Worker proxies in
		 * production forwards to canary here, so the identity probe answers
		 * definitively (signed-out) instead of "unavailable", and reco/billing/
		 * platform reads work under HMR. The chat seam (/api/agent) stays local
		 * (the middleware above). Signed-in state still cannot exist on
		 * localhost — the session cookie and the GitHub OAuth callback are bound
		 * to the canary origin — so completing sign-in continues on canary.
		 */
		proxy: Object.fromEntries(
			[
				"/api/auth",
				"/api/identity",
				"/api/reco",
				"/api/billing",
				"/api/repos",
				"/api/github",
				"/api/user",
				"/api/notifications",
				"/api/workflow",
				"/api/client-errors",
				/*
				 * The admin plugin's seams and the browser tool. Without them a dev
				 * session answered the SPA's own HTML for `/api/admin/*`, so every
				 * admin read parsed `<!DOCTYPE` as JSON and the whole admin surface
				 * was unreachable outside a deploy.
				 */
				"/api/admin",
				"/api/tools",
			].map((path) => [
				path,
				{
					target: devUpstream,
					changeOrigin: true,
					/*
					 * The product Worker refuses a cross-origin write ("This API only
					 * answers requests from its own origin"), and a browser on
					 * localhost sends `Origin: http://localhost:5173` — so in dev
					 * EVERY mutation answered 403: sign-out, the allowlist, grants,
					 * request-access, checkout. The proxy hop is the request's real
					 * origin here, and `changeOrigin` already rewrites Host for
					 * exactly this reason; the Origin header follows it. This is
					 * server-side dev plumbing and ships in no build.
					 */
					configure: (proxy) => {
						proxy.on("proxyReq", (request: ProxyRequest) => {
							if (request.getHeader("origin") !== undefined) request.setHeader("origin", devUpstream);
						});
					},
				},
			]),
		),
	},
	preview: {
		headers: crossOriginIsolationHeaders,
	},
});
