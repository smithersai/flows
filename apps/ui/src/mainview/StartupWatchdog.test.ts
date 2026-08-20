import { afterAll, afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ClientErrorKind, ClientErrorReporter } from "./state/ClientErrors";
import { startStartupWatchdog } from "./StartupWatchdog";

GlobalRegistrator.register();

afterAll(async () => {
	await GlobalRegistrator.unregister();
});

beforeEach(() => {
	document.body.innerHTML = '<div id="root"></div>';
	jest.useFakeTimers();
});

afterEach(() => {
	jest.useRealTimers();
	document.body.textContent = "";
});

const reporter = (): { readonly reports: Array<readonly [ClientErrorKind, unknown]>; readonly value: ClientErrorReporter } => {
	const reports: Array<readonly [ClientErrorKind, unknown]> = [];
	return {
		reports,
		value: {
			report: (kind, error) => void reports.push([kind, error]),
			reported: () => reports.length,
		},
	};
};

describe("the startup watchdog outside React", () => {
	test("uses its configured timeout and renders a visible failure when the root stays blank", () => {
		const errors = reporter();
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const watchdog = startStartupWatchdog({ timeoutMs: 73, clientErrors: errors.value });
		jest.advanceTimersByTime(72);
		expect(document.getElementById("root")?.textContent).toBe("");
		jest.advanceTimersByTime(1);
		expect(document.getElementById("root")?.textContent).toContain("Smithers failed to start");
		expect(document.getElementById("root")?.textContent).toContain("within 73ms");
		watchdog.stop();
		consoleError.mockRestore();
	});

	test("reports both browser error channels and never clobbers an app that mounted", () => {
		const errors = reporter();
		const watchdog = startStartupWatchdog({ timeoutMs: 10, clientErrors: errors.value });
		window.dispatchEvent(new ErrorEvent("error", { error: new Error("first") }));
		window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "second" }));
		document.getElementById("root")?.append(document.createElement("main"));
		jest.advanceTimersByTime(10);
		expect(errors.reports.map(([kind]) => kind)).toEqual(["error", "unhandledrejection"]);
		expect(document.getElementById("root")?.querySelector("main")?.textContent).toBe("");
		watchdog.stop();
	});
});
