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
 * One page: the chat. Auth is a conversation state, never a view — these pin
 * that a definitive signed-out or non-allowlisted answer renders THE CHAT
 * (transcript + composer) whose opening Smithers message carries the one
 * available action, that there is no second surface anywhere, and that the
 * composer's attempted send resolves to the calm one-line reply.
 */

GlobalRegistrator.register();

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

const mount = (controller: AppControllerType): { host: HTMLElement; markup: () => string } => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App controller={controller} />));
	mounted.push(() => {
		flushSync(() => root.unmount());
		host.remove();
	});
	return { host, markup: () => host.innerHTML };
};

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

const silentAgent: NativeAgent = {
	available: true,
	startTurn: async () => ({ status: "started" }),
	cancelTurn: async () => {},
	subscribe: () => () => {},
};

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const backend = (
	routes: Record<string, Response>,
): { fetchImpl: (input: unknown) => Promise<Response> } => ({
	fetchImpl: async (input) => {
		const url = typeof input === "string" ? input : String(input);
		const path = new URL(url, "https://app.test").pathname;
		return (routes[path] ?? json(404, { status: "error" })).clone();
	},
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("auth is a conversation state — the chat is the only page", () => {
	test("signed-out: the chat renders with the opening sign-in message riding the transcript", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			...backend({
				"/api/auth/session": json(401, { status: "error" }),
				"/api/auth/scopes": json(200, {
					scopes: [{ scope: "read:user", plain: "See your GitHub profile.", why: "Sign-in." }],
				}),
			}),
		});
		await controller.loadSession();
		await settled();

		const { host, markup } = mount(controller);
		const html = markup();
		// The chat surface — transcript AND composer — not a landing takeover.
		expect(host.querySelector(".smithers-transcript")).not.toBeNull();
		expect(host.querySelector(".smithers-composer")).not.toBeNull();
		expect(host.querySelector(".landing-surface")).toBeNull();
		// The opening Smithers message carries the sentence, the plain-words
		// scopes, and the sign-in action bound to the registered command.
		expect(html).toContain("Smithers is a design-partner preview — sign in with GitHub to continue.");
		expect(html).toContain("See your GitHub profile.");
		const signIn = host.querySelector<HTMLButtonElement>('[data-command="auth.sign-in"]');
		expect(signIn).not.toBeNull();
		expect(signIn?.textContent).toContain("Sign in with GitHub");
		expect(controller.commands.find("auth.sign-in")).toBeDefined();
		// The composer is honestly gated: the hint names the one needed step.
		expect(host.querySelector("textarea")?.placeholder).toContain("Sign in with GitHub first");
	});

	test("signed-out: an attempted send answers in the transcript, never the network", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			...backend({
				"/api/auth/session": json(401, { status: "error" }),
				"/api/auth/scopes": json(200, { scopes: [] }),
			}),
		});
		await controller.loadSession();
		const { markup } = mount(controller);
		controller.send("is anyone there?");
		await settled();
		flushSync(() => {});
		expect(markup()).toContain("Sign in with GitHub first — that's the one step");
	});

	test("signed-out shows ONLY the auth conversation — no welcome, no invitation under it (wave 12 §4)", async () => {
		/*
		 * Live earlier today: under the sign-in message the chat still rendered
		 * the seeded "Hey — I'm Smithers. Tell me what you're working on" — an
		 * invitation to a conversation this session cannot have. §2a″ says a
		 * state shows only itself.
		 */
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			...backend({
				"/api/auth/session": json(401, { status: "error" }),
				"/api/auth/scopes": json(200, { scopes: [] }),
			}),
		});
		await controller.loadSession();
		await settled();

		const { host, markup } = mount(controller);
		const html = markup();
		expect(html).toContain("sign in with GitHub to continue");
		expect(html).not.toContain("Tell me what you’re working on");
		expect(html).not.toContain("Tell me what you're working on");
		// ONE entry in the transcript: the auth state, nothing riding under it.
		expect(host.querySelectorAll(".smithers-transcript > *")).toHaveLength(1);
		// The one suggestion is the sign-in binding — the genuinely next step.
		const pills = [...host.querySelectorAll(".smithers-suggestion")].map((pill) => pill.textContent);
		expect(pills).toEqual(["Sign in with GitHub"]);
	});

	test("signed-in but not allowlisted: the same chat carries the request-access message", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			...backend({
				"/api/auth/session": json(200, { login: "newcomer", allowlisted: false, admin: false }),
			}),
		});
		await controller.loadSession();
		await settled();

		const { host, markup } = mount(controller);
		expect(host.querySelector(".smithers-transcript")).not.toBeNull();
		expect(host.querySelector(".smithers-composer")).not.toBeNull();
		expect(host.querySelector(".landing-surface")).toBeNull();
		expect(markup()).toContain("design partners only right now");
		const request = host.querySelector<HTMLButtonElement>('[data-command="auth.request-access"]');
		expect(request?.textContent).toContain("Request access");
		expect(host.querySelector("textarea")?.placeholder).toContain("Request access");
	});

	test("a definitive $0 keeps the composer live, and a healthy composer renders NO status text (§2g)", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			...backend({
				"/api/auth/session": json(200, { login: "will", allowlisted: true, admin: false }),
				"/api/billing/balance": json(200, {
					user: "will",
					balance: { totalUsd: "0", totalNanos: 0, lifetimeChargedUsd: "500", chargeCount: 3 },
					state: "empty",
					allowedToStartWork: false,
					credits: [],
				}),
			}),
		});
		await controller.loadSession();
		await settled();
		await settled();

		const { host, markup } = mount(controller);
		// The dollar chip stays; the composer is NOT paused.
		expect(markup()).toContain("$0");
		expect(host.querySelector("textarea")?.placeholder).toBe("Ask Smithers to work on something…");
		// Calm is the budget (§2g): the persistent status line is gone — no
		// "live" chrome when healthy, no standing free-chat sentence.
		expect(markup()).not.toContain("Smithers Cloud · live");
		expect(markup()).not.toContain("chat is on us during the alpha");
		expect(markup()).not.toContain("paused at a $0 balance");
	});

	test("a slow background flow renders on the shared toast stack", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		let release: (response: Response) => void = () => {};
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			fetchImpl: () =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
			toastDebounceMs: 0,
		});
		const { host } = mount(controller);
		const pending = controller.refreshBalance();
		await settled();
		flushSync(() => {});
		const stack = host.querySelector(".toast-stack");
		expect(stack).not.toBeNull();
		expect(stack?.textContent).toContain("Refreshing your balance…");
		release(json(503, { status: "error" }));
		await pending;
		await settled();
		flushSync(() => {});
		expect(host.querySelector(".toast-stack")?.textContent).toContain(
			"Your balance couldn't be refreshed right now.",
		);
	});
});
