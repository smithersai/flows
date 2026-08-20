import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import {
	buildStamp,
	crossOriginIsolationHeaders,
	resolveBuildSha,
	smithersAgentApi,
} from "./vite.config";

export default defineConfig({
	publicDir: "src/mainview/public",
	plugins: [
		/*
		 * No `experimental` key: `experimental.types` does not exist in
		 * @cloudflare/vite-plugin 1.x (the type-generation switch lives under
		 * experimental.newConfig, which is incompatible with configPath and
		 * generates types only in that mode), so the old key was inert and
		 * failed typecheck the moment this file joined the tsconfig include.
		 */
		cloudflare({
			configPath: "../server/wrangler.jsonc",
			viteEnvironment: { name: "ssr" },
		}),
		tanstackStart({ srcDirectory: "src/mainview" }),
		react(),
		smithersAgentApi(),
		buildStamp(),
	],
	define: {
		__SMITHERS_START__: "true",
		__SMITHERS_BUILD_SHA__: JSON.stringify(resolveBuildSha()),
		__VUE_OPTIONS_API__: "true",
		__VUE_PROD_DEVTOOLS__: "false",
		__VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
	},
	server: {
		port: 5173,
		strictPort: true,
		headers: crossOriginIsolationHeaders,
	},
	preview: { headers: crossOriginIsolationHeaders },
});
