/*
 * The hermetic e2e harness — the real client, in process.
 *
 * A suite drives the product's own AppStore, AppController and WebAgent, wired
 * with an injected fetch that attaches the session cookie and records every
 * call. Nothing here assigns globalThis.fetch: AppController and createWebAgent
 * both accept a fetchImpl, and no other module under src/mainview touches the
 * global, so injection is complete. A suite that patched the global would
 * corrupt the stack for every other suite sharing it.
 */
import type { StorageApi } from "@tanstack/db";
import type { FetchLike } from "smithers-shared/NativeAgent";
import type { Card } from "smithers-shared/Cards";
import { createAppController, type AppController } from "../src/mainview/state/AppController.ts";
import { createAppStore, type AppStore } from "../src/mainview/state/AppStore.ts";
import type { Message, WorldDocument } from "../src/mainview/state/AppState.ts";
// Type-only: NativeBridge.ts reads window.__electrobun at module scope and throws under bun.
import type { NativeRepositories } from "../src/mainview/native/NativeBridge.ts";
import { createWebAgent } from "../src/mainview/native/WebAgent.ts";

export interface ClientOptions {
	readonly origin: string;
	/** Attached to every same-origin request, exactly as a browser would. */
	readonly cookie?: string;
	readonly workflowPollMs?: number;
	readonly workflowQuietMs?: number;
	readonly toastDebounceMs?: number;
	readonly toastAutoDismissMs?: number;
	readonly handoffPollMs?: number;
	readonly openExternal?: (url: string) => Promise<boolean>;
	/** Defaults to NO_NATIVE_REPOSITORIES. */
	readonly repositories?: NativeRepositories;
}

export interface ClientCall {
	readonly method: string;
	readonly url: string;
	readonly path: string;
	readonly status: number | "error";
}

export interface Client {
	readonly store: AppStore;
	readonly controller: AppController;
	/** Every request this client made, oldest first. */
	readonly calls: () => ReadonlyArray<ClientCall>;
	readonly countCalls: (method: string, path: string) => number;
	/** All transcript messages joined by "\n" in ordinal order. */
	readonly transcript: () => string;
	readonly messages: () => ReadonlyArray<Message>;
	readonly cards: () => ReadonlyArray<Card>;
	readonly worldDocuments: () => ReadonlyArray<WorldDocument>;
	/** Poll until `predicate()` or throw after `timeoutMs` (default 12000). */
	readonly settle: (what: string, predicate: () => boolean, timeoutMs?: number) => Promise<void>;
	/** Wait for session().phase === "idle". */
	readonly idle: (timeoutMs?: number) => Promise<void>;
}

/** An in-memory StorageApi so no two clients share persisted state. */
export const memoryStorage = (): StorageApi => {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key),
	};
};

/** There is no native bridge in a headless e2e, and saying so is not a failure. */
export const NO_NATIVE_REPOSITORIES: NativeRepositories = {
	available: false,
	pickLocalRepository: async () => ({
		status: "error",
		code: "native-required",
		message: "no native bridge in the e2e",
	}),
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const openClient = async (options: ClientOptions): Promise<Client> => {
	const { origin, cookie } = options;
	const tracked: Array<ClientCall> = [];

	const clientFetch: FetchLike = async (input, init) => {
		const base =
			typeof input === "string" || input instanceof URL ? new Request(input, init) : (input as Request);
		const url = new URL(base.url);
		/*
		 * A browser attaches the session cookie to every SAME-ORIGIN request and
		 * to nothing else. The doubles are other origins and would never see it,
		 * so neither does the harness.
		 */
		const request =
			cookie === undefined || url.origin !== origin || base.headers.has("cookie")
				? base
				: new Request(base, { headers: new Headers([...base.headers, ["cookie", cookie]]) });
		try {
			const response = await fetch(request);
			tracked.push({ method: request.method, url: request.url, path: url.pathname, status: response.status });
			return response;
		} catch (error) {
			tracked.push({ method: request.method, url: request.url, path: url.pathname, status: "error" });
			throw error;
		}
	};

	const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
	// createWebAgent binds its fetch at construction, so clientFetch exists first.
	const controller = createAppController(
		store,
		options.repositories ?? NO_NATIVE_REPOSITORIES,
		createWebAgent({ baseUrl: origin, fetchImpl: clientFetch }),
		{
			baseUrl: origin,
			fetchImpl: clientFetch,
			workflowPollMs: options.workflowPollMs ?? 150,
			...(options.workflowQuietMs === undefined ? {} : { workflowQuietMs: options.workflowQuietMs }),
			...(options.toastDebounceMs === undefined ? {} : { toastDebounceMs: options.toastDebounceMs }),
			...(options.toastAutoDismissMs === undefined ? {} : { toastAutoDismissMs: options.toastAutoDismissMs }),
			...(options.handoffPollMs === undefined ? {} : { handoffPollMs: options.handoffPollMs }),
			...(options.openExternal === undefined ? {} : { openExternal: options.openExternal }),
		},
	);

	const messages = (): ReadonlyArray<Message> =>
		[...store.collections.messages.values()].sort((left, right) => left.ordinal - right.ordinal);

	const settle = async (what: string, predicate: () => boolean, timeoutMs = 12_000): Promise<void> => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (predicate()) return;
			if (Date.now() >= deadline) throw new Error(`${what} (waited ${timeoutMs}ms)`);
			await wait(50);
		}
	};

	return {
		store,
		controller,
		calls: () => tracked,
		countCalls: (method, path) =>
			tracked.filter((call) => call.method.toUpperCase() === method.toUpperCase() && call.path === path).length,
		transcript: () =>
			messages()
				.map((message) => message.text)
				.join("\n"),
		messages,
		cards: () => [...store.collections.cards.values()],
		worldDocuments: () => [...store.collections.worldDocuments.values()],
		settle,
		idle: (timeoutMs = 12_000) =>
			settle("the composer never returned to idle", () => store.session().phase === "idle", timeoutMs),
	};
};
