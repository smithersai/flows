import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { StorageApi } from "@tanstack/db";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "../App";
import { createAppController } from "./AppController";
import type { AppController as AppControllerType } from "./AppController";
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge";
import { createAppStore } from "./AppStore";

/*
 * The composer hot path.
 *
 * The draft changes on every keystroke. It used to be read by the shell, so
 * one character re-rendered App — and App renders the whole transcript, every
 * message, every card. The shell now projects the session WITHOUT the draft
 * and the composer subscribes to the draft itself, so typing re-renders the
 * composer subtree and nothing above it.
 *
 * These tests pin that as a render COUNT, not a description: `data-flows` is
 * built from `controller.commands.all()` during App's render, so counting that
 * call counts App renders. Putting `draft` back into the shell's projection
 * fails here immediately.
 */

GlobalRegistrator.register();

/*
 * bun test shares one process across files, so the DOM globals registered
 * above would leak into every file that runs after this one. Registration is
 * confined to this file's run, exactly as ChatShell.test.tsx does it.
 */
afterAll(async () => {
	for (let tick = 0; tick < 3; tick += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	await GlobalRegistrator.unregister();
});

const mounted: Array<() => void> = [];

afterEach(() => {
	while (mounted.length > 0) mounted.pop()?.();
});

const memoryStorage = (): StorageApi => {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key),
	};
};

const unavailableRepositories: NativeRepositories = {
	available: false,
	pickLocalRepository: async () => ({
		status: "error",
		code: "native-required",
		message: "Local repositories can only be connected from the Smithers native app.",
	}),
};

const unavailableAgent: NativeAgent = {
	available: false,
	startTurn: async () => ({ status: "error", message: "unavailable" }),
	cancelTurn: async () => {},
	subscribe: () => () => {},
};

interface Counted {
	readonly controller: AppControllerType;
	/** How many times App has rendered since mount. */
	readonly renders: () => number;
	readonly host: HTMLElement;
	readonly act: (change: () => void) => Promise<void>;
}

/** Mount App behind a controller whose registry read counts the shell's renders. */
const mountCounted = async (): Promise<Counted> => {
	const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
	const real = createAppController(store, unavailableRepositories, unavailableAgent);
	let count = 0;
	const controller: AppControllerType = {
		...real,
		commands: {
			...real.commands,
			all: () => {
				count += 1;
				return real.commands.all();
			},
		},
	};
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App controller={controller} />));
	mounted.push(() => {
		flushSync(() => root.unmount());
		host.remove();
	});
	const act = async (change: () => void): Promise<void> => {
		flushSync(change);
		// Collection subscriptions land on a microtask; flush what they queued.
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync(() => {});
	};
	await act(() => {});
	return { controller, renders: () => count, host, act };
};

const textarea = (host: HTMLElement): HTMLTextAreaElement | null =>
	host.querySelector<HTMLTextAreaElement>("textarea");

describe("the composer hot path: typing never re-renders the transcript", () => {
	test("a run of keystrokes re-renders the shell zero times", async () => {
		const view = await mountCounted();
		const before = view.renders();

		for (const draft of ["w", "wr", "wri", "writ", "write"]) {
			await view.act(() => view.controller.changeDraft(draft));
		}

		// The composer took every character...
		expect(textarea(view.host)?.value).toBe("write");
		expect(view.controller.store.session().draft).toBe("write");
		// ...and the shell above it never rendered again.
		expect(view.renders()).toBe(before);
	});

	test("the shell still re-renders for the session state it does read", async () => {
		const view = await mountCounted();
		const before = view.renders();

		// A surface change is not the hot path: the shell reads `surface`, so it
		// must still project it. This is the other half of the projection —
		// dropping a field the shell needs has to fail as loudly as keeping the
		// draft it does not.
		await view.act(() => void view.controller.runCommand("world"));

		expect(view.renders()).toBeGreaterThan(before);
		expect(view.host.querySelector(".world-surface")).not.toBeNull();
	});

	test("typing leaves the transcript's rendered messages untouched", async () => {
		const view = await mountCounted();
		await view.act(() => view.controller.runCommandArgs("send", "a message worth keeping"));
		const before = view.host.querySelector(".smithers-transcript")?.innerHTML;
		const renders = view.renders();

		await view.act(() => view.controller.changeDraft("/"));
		await view.act(() => view.controller.changeDraft(""));

		expect(view.host.querySelector(".smithers-transcript")?.innerHTML).toBe(before);
		expect(view.renders()).toBe(renders);
	});

	test("Escape outside the connect menu closes its session state", async () => {
		const view = await mountCounted();
		const shell = view.host.querySelector<HTMLElement>(".app-shell");
		expect(shell).not.toBeNull();

		await view.act(() => view.controller.toggleConnectMenu());
		expect(view.controller.store.session().connectMenuOpen).toBe(true);

		document.body.focus();
		flushSync(() => {
			shell?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});
		await view.act(() => {});

		expect(view.controller.store.session().connectMenuOpen).toBe(false);
	});
});
