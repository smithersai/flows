import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { installAgentApi } from "./src/dev/AgentApi";

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

export default defineConfig({
	plugins: [react(), smithersAgentApi()],
	root: "src/mainview",
	build: {
		outDir: "../../dist",
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
			].map((path) => [
				path,
				{ target: process.env.SMITHERS_DEV_UPSTREAM ?? "https://canary.smithers.sh", changeOrigin: true },
			]),
		),
	},
	preview: {
		headers: crossOriginIsolationHeaders,
	},
});
