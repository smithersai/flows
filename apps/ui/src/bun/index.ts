import { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun";
import type { AgentTurnFrame } from "smithers-shared/NativeAgent";
import type { SmithersNativeRPC } from "smithers-shared/NativeRPC";
import { createCloudAgent } from "./CloudAgent";
import { inspectLocalRepository } from "./LocalRepository";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

/**
 * The deployed origin each release channel talks to.
 *
 * §27.1: `build:canary` produced a launchable app with NO BACKEND. The window
 * loaded `views://mainview/index.html`, so every relative `/api/*` fetch in
 * the renderer resolved against the `views://` scheme and failed on startup —
 * the app could not read a session, let alone sign in. A channel build is a
 * build FOR a deployment, so it loads that deployment. The seams the native
 * shell owns (the local repo picker, the native agent) bind to the window and
 * not the URL, so they keep working against the deployed page — this is the
 * same arrangement `start:canary` already used through SMITHERS_APP_URL.
 *
 * `stable` is deliberately absent: no production origin is declared anywhere
 * in this repo yet, and guessing one would ship an app pointed at a host that
 * may not be ours. A channel with no origin keeps the bundled view.
 */
const CHANNEL_ORIGINS: Readonly<Record<string, string>> = {
	canary: "https://canary.smithers.sh",
};

// Check if Vite dev server is running for HMR
async function getMainViewUrl(): Promise<string> {
	/*
	 * SMITHERS_APP_URL loads the window from a DEPLOYED origin instead of the
	 * local build — the signed-in dev loop: the GitHub OAuth callback and the
	 * session cookie are bound to the deployed origin, so a native window
	 * pointed there completes sign-in for real (a localhost page never can).
	 * The native RPC seams (local repo picker, native agent) bind to the
	 * window, not the URL, so they keep working against the deployed page.
	 */
	const override = Bun.env.SMITHERS_APP_URL?.trim();
	if (override !== undefined && override !== "") {
		console.log(`Loading the app from SMITHERS_APP_URL: ${override}`);
		return override;
	}
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
			return DEV_SERVER_URL;
		} catch {
			console.log(
				"Vite dev server not running. Run 'bun run dev:hmr' for HMR support.",
			);
		}
		return "views://mainview/index.html";
	}
	const origin = CHANNEL_ORIGINS[channel];
	if (origin !== undefined) {
		console.log(`Loading the ${channel} channel from ${origin}`);
		return origin;
	}
	return "views://mainview/index.html";
}

// Create the main application window
const url = await getMainViewUrl();

let publishAgentFrame = (_frame: AgentTurnFrame): void => {};
const cloudAgent = createCloudAgent((frame) => publishAgentFrame(frame), {
	chatUrl: Bun.env.SMITHERS_CHAT_URL,
	origin: Bun.env.SMITHERS_CHAT_ORIGIN,
});

const rpc = BrowserView.defineRPC<SmithersNativeRPC>({
	handlers: {
		requests: {
			pickLocalRepository: async ({ access }) => {
				const selectedPaths = await Utils.openFileDialog({
					canChooseFiles: false,
					canChooseDirectory: true,
					allowsMultipleSelection: false,
				});
				const selectedPath = selectedPaths.find((path) => path.trim() !== "");
				if (selectedPath === undefined) return { status: "cancelled" } as const;
				return inspectLocalRepository(selectedPath, access);
			},
			startAgentTurn: (request) => cloudAgent.start(request),
			cancelAgentTurn: ({ runId }) => cloudAgent.cancel(runId),
			openExternal: async ({ url }) => {
				// https only: the renderer must not be able to launch arbitrary
				// local schemes through the privileged side.
				let parsed: URL;
				try {
					parsed = new URL(url);
				} catch {
					return { opened: false };
				}
				if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
					return { opened: false };
				}
				return { opened: Utils.openExternal(parsed.toString()) };
			},
		},
		messages: {},
	},
});
publishAgentFrame = rpc.proxy.send.agentFrame;

new BrowserWindow({
	title: "Smithers",
	url,
	rpc,
	frame: {
		width: 1180,
		height: 800,
		x: 100,
		y: 60,
	},
});

console.log("Smithers app started!");
