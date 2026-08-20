import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { createAgentSwitch, createChainRuntime } from "./chain/ChainRuntime";
import { nativeAgent, nativeOpenExternal, nativeRepositories } from "./native/NativeBridge";
import { createAppController } from "./state/AppController";
import { createAppStore } from "./state/AppStore";
import { createClientErrorReporter, errorMessage } from "./state/ClientErrors";

export const renderStartupError = (error: unknown): void => {
	const root = document.getElementById("root");
	if (root === null) return;
	root.textContent = "";
	const panel = document.createElement("main");
	panel.setAttribute(
		"style",
		[
			"font-family: ui-monospace, SFMono-Regular, Menlo, monospace",
			"max-width: 44rem",
			"margin: 4rem auto",
			"padding: 2rem",
			"color: #1a1a1a",
		].join(";"),
	);
	const heading = document.createElement("h1");
	heading.textContent = "Smithers failed to start";
	const detail = document.createElement("pre");
	detail.setAttribute(
		"style",
		"white-space: pre-wrap; word-break: break-word; background: #f4f1ea; padding: 1rem; border-radius: 8px",
	);
	detail.textContent = errorMessage(error);
	const hint = document.createElement("p");
	hint.textContent = "Reload to try again. If this persists, share the error above with the team.";
	panel.append(heading, detail, hint);
	root.append(panel);
};

const rootIsEmpty = (): boolean => {
	const root = document.getElementById("root");
	return root !== null && root.childElementCount === 0;
};

const BOOT_WATCHDOG_MS = 15_000;

let firstBootError: unknown;

/**
 * Boot is expected to survive some errors — a dying OPFS worker is recovered by the
 * localStorage fallback — so stray errors are only remembered, never rendered on arrival.
 * Only errors seen while the root is still blank can explain a blank root.
 */
const rememberBootError = (error: unknown): void => {
	if (firstBootError !== undefined || !rootIsEmpty()) return;
	firstBootError = error;
};

/**
 * Last line of defence against a silent blank page: if the root never received content
 * — a hung boot, or an async failure after `main` resolved — surface something visible.
 * A mounted app is never clobbered, because a rendered root is not empty.
 */
const reportBlankRoot = (reason: Error): void => {
	if (!rootIsEmpty()) return;
	console.error("Smithers failed to start", reason, firstBootError);
	renderStartupError(
		firstBootError === undefined
			? reason
			: [
					errorMessage(reason),
					"",
					"Earliest error while the page was blank (some are recovered, so this may not be the cause):",
					errorMessage(firstBootError),
				].join("\n"),
	);
};

/*
 * Runtime error ingest (multi's client-errors discipline, minimal form):
 * crashes and unhandled rejections POST to the Worker's /api/client-errors —
 * bounded, fire-and-forget, capped per page — so alpha client failures reach
 * the worker tail instead of dying in the user's console.
 *
 * The reporter itself, and the bounds it holds the body to, live in
 * state/ClientErrors.ts: they are a contract with the Worker route and are
 * tested against it. main.tsx only subscribes the two window events, so there
 * is one reporter in the app and the tested one is the shipped one.
 */
const clientErrors = createClientErrorReporter();

const watchForSilentBootFailure = (): void => {
	window.addEventListener("error", (event) => {
		rememberBootError(event.error ?? event.message);
		clientErrors.report("error", event.error ?? event.message);
	});
	window.addEventListener("unhandledrejection", (event) => {
		rememberBootError(event.reason);
		clientErrors.report("unhandledrejection", event.reason);
	});
	setTimeout(() => {
		reportBlankRoot(new Error(`Smithers did not finish starting within ${BOOT_WATCHDOG_MS}ms.`));
	}, BOOT_WATCHDOG_MS);
};

const main = async (): Promise<void> => {
	watchForSilentBootFailure();
	try {
		const store = await createAppStore();
		/*
		 * DESIGN.md §14: one agent seam, two backends. The switch delegates each
		 * turn by the session flag; the chain runtime binds after the controller
		 * exists because its catalog IS the controller's command registry.
		 */
		const agent = createAgentSwitch(store, nativeAgent);
		const controller = createAppController(store, nativeRepositories, agent, {
			// The native shell's system-browser door: sign-in runs the handoff
			// (OAuth outside the webview, where passkeys work). Absent on web.
			...(nativeOpenExternal === undefined ? {} : { openExternal: nativeOpenExternal }),
		});
		// The tapped fetch routes the model relay's traffic into the same
		// debug ring as every controller seam.
		agent.bindChain(
			createChainRuntime({ store, commands: controller.commands, fetchImpl: controller.tappedFetch }),
		);
		// Boot-time backend check: the identity session record is driven by the
		// real seam answer, recorded as a system transition. The balance read
		// follows from that answer (loadSession fires it on sign-in) — firing it
		// blind here, signed out, could only 401, and the browser logs even an
		// expected 401 as a console error.
		void controller.loadSession();
		// Returning from a failed OAuth redirect (?auth=failed) is a Smithers
		// message in the chat — honest error plus a retry action — never a bare
		// page. The query is consumed so a reload doesn't repeat it.
		if (controller.handleAuthReturn(window.location.search)) {
			window.history.replaceState(null, "", window.location.pathname);
		}
		createRoot(document.getElementById("root")!).render(
			<StrictMode>
				<App controller={controller} />
			</StrictMode>,
		);
	} catch (error) {
		console.error("Smithers failed to start", error);
		renderStartupError(error);
	}
};

void main();
