import { createClientErrorReporter, errorMessage } from "./state/ClientErrors";
import type { ClientErrorReporter } from "./state/ClientErrors";

export interface StartupWatchdogOptions {
	readonly timeoutMs: number;
	readonly document?: Document;
	readonly window?: Window;
	readonly clientErrors?: ClientErrorReporter;
}

export interface StartupWatchdog {
	readonly reportFailure: (error: unknown) => void;
	readonly stop: () => void;
}

const renderStartupError = (documentTarget: Document, error: unknown): void => {
	const root = documentTarget.getElementById("root");
	if (root === null) return;
	root.textContent = "";
	const panel = documentTarget.createElement("main");
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
	const heading = documentTarget.createElement("h1");
	heading.textContent = "Smithers failed to start";
	const detail = documentTarget.createElement("pre");
	detail.setAttribute(
		"style",
		"white-space: pre-wrap; word-break: break-word; background: #f4f1ea; padding: 1rem; border-radius: 8px",
	);
	detail.textContent = errorMessage(error);
	const hint = documentTarget.createElement("p");
	hint.textContent = "Reload to try again. If this persists, share the error above with the team.";
	panel.append(heading, detail, hint);
	root.append(panel);
};

/** Guard the failure mode where React never mounts; this intentionally lives outside React. */
export const startStartupWatchdog = (options: StartupWatchdogOptions): StartupWatchdog => {
	const documentTarget = options.document ?? document;
	const windowTarget = options.window ?? window;
	const clientErrors = options.clientErrors ?? createClientErrorReporter();
	let firstBootError: unknown;
	const rootIsEmpty = (): boolean => {
		const root = documentTarget.getElementById("root");
		return root !== null && root.childElementCount === 0;
	};
	const remember = (error: unknown): void => {
		if (firstBootError !== undefined || !rootIsEmpty()) return;
		firstBootError = error;
	};
	const reportFailure = (reason: unknown): void => {
		if (!rootIsEmpty()) return;
		console.error("Smithers failed to start", reason, firstBootError);
		renderStartupError(
			documentTarget,
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
	const onError = (event: ErrorEvent): void => {
		const error = event.error ?? event.message;
		remember(error);
		clientErrors.report("error", error);
	};
	const onRejection = (event: PromiseRejectionEvent): void => {
		remember(event.reason);
		clientErrors.report("unhandledrejection", event.reason);
	};
	windowTarget.addEventListener("error", onError);
	windowTarget.addEventListener("unhandledrejection", onRejection);
	const timer = windowTarget.setTimeout(() => {
		reportFailure(new Error(`Smithers did not finish starting within ${options.timeoutMs}ms.`));
	}, options.timeoutMs);
	return {
		reportFailure,
		stop: () => {
			windowTarget.clearTimeout(timer);
			windowTarget.removeEventListener("error", onError);
			windowTarget.removeEventListener("unhandledrejection", onRejection);
		},
	};
};
