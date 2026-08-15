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
 * Wave 14 §1 — the OPENING message is never filler.
 *
 * The launch checklist reads `smithersMessages(page).first()`: whatever renders
 * FIRST in the transcript is the message the product is judged by. A seeded
 * "Hey — I'm Smithers. Tell me what you're working on" satisfied nothing and
 * displaced everything, so it is gone. These pin the replacement in the DOM,
 * at the harness's own altitude:
 *
 *   signed out — the opening (and only) message IS the auth conversation state;
 *   signed in  — the FIRST message IS the digest (or its honest degraded state);
 *   loading    — the transcript is EMPTY, and the 300ms toast says what runs.
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

/*
 * The launch harness's own selector, verbatim (flows/ui e2e/launch-checklist/
 * checks.ts `sel.smithersMessages`). It accepts BOTH role spellings; this app
 * only ever renders "assistant", but copying the harness's narrower half would
 * make the empty-transcript assertion below pass vacuously if that ever changed.
 */
const SMITHERS_MESSAGES =
	'[data-slot="chat-message"][data-role="assistant"], [data-slot="chat-message"][data-role="smithers"]';

/** The harness's `smithersMessages(page).first()`: the first rendered message. */
const openingMessage = (host: HTMLElement): string =>
	(host.querySelector(SMITHERS_MESSAGES)?.textContent ?? "").replace(/\s+/g, " ").trim();

const FILLER = /Tell me what you[’']re working on/;

const GROUNDED = {
	digest: {
		sentence:
			"Across 12 repos you have 7 open issues and 2 open pull requests; will/flows is the busiest.",
		computedAt: "2026-08-10T09:00:00.000Z",
		reposConsidered: 12,
		openIssues: 7,
		openPullRequests: 2,
		staleCount: 3,
		mostActiveRepo: "will/flows",
		untriagedInMostActive: 4,
		oldestWaiting: {
			label: "will/flows#12",
			url: "https://github.com/will/flows/pull/12",
			waitingDays: 13,
		},
	},
	recommendation: {
		id: "review-pr:will/flows#12",
		title: "Review will/flows#12",
		proposes: "Read the diff and leave a review.",
		whyNow: "It has been waiting 13 days.",
		whatHappens: "I draft the review; nothing is merged.",
		subject: { kind: "pull_request", url: "https://github.com/will/flows/pull/12" },
		evidenceKey: "0123456789abcdef",
	},
};

describe("wave 14 §1 — the opening message is never filler", () => {
	test("signed out: the opening (and only) message IS the auth conversation state", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			...backend({
				"/api/auth/session": json(401, { status: "error" }),
				"/api/auth/scopes": json(200, {
					scopes: [{ scope: "repo", plain: "Read your repositories.", why: "To see your work." }],
				}),
			}),
		});
		await controller.loadSession();
		await settled();

		const { host, markup } = mount(controller);
		expect(host.querySelectorAll(SMITHERS_MESSAGES)).toHaveLength(1);
		expect(openingMessage(host)).toMatch(/sign in with github/i);
		expect(FILLER.test(markup())).toBe(false);
	});

	test("signed in: the FIRST message IS the digest — nothing is seeded ahead of it", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			...backend({
				"/api/auth/session": json(200, { login: "will", allowlisted: true, admin: false }),
				"/api/reco/first-run": json(200, GROUNDED),
			}),
		});
		await controller.loadSession();
		await controller.loadFirstRunReco();
		await settled();

		const { host, markup } = mount(controller);
		expect(openingMessage(host)).toContain(GROUNDED.digest.sentence);
		expect(openingMessage(host)).not.toMatch(/^Hey/);
		expect(FILLER.test(markup())).toBe(false);
	});

	test("signed in, degraded: the FIRST message is the honest degraded state, still not filler", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		const honestMessage = "I can't read your repositories yet — sign-in didn't include the repo scope.";
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			...backend({
				"/api/auth/session": json(200, { login: "will", allowlisted: true, admin: false }),
				"/api/reco/first-run": json(200, { degraded: true, reason: "missing_scope", honestMessage }),
			}),
		});
		await controller.loadSession();
		await controller.loadFirstRunReco();
		await settled();

		const { host, markup } = mount(controller);
		expect(openingMessage(host)).toContain(honestMessage);
		expect(FILLER.test(markup())).toBe(false);
	});

	test("signed in, still loading: the transcript is empty — the toast carries the wait, not a filler line", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		// The reco read is genuinely in flight: this route never answers, so the
		// boot is observed mid-wait rather than after it.
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			fetchImpl: async (input: unknown) => {
				const path = new URL(String(input), "https://app.test").pathname;
				if (path === "/api/auth/session") {
					return json(200, { login: "will", allowlisted: true, admin: false });
				}
				if (path === "/api/reco/first-run") return new Promise<Response>(() => {});
				return json(404, { status: "error" });
			},
		});
		void controller.loadSession();
		await settled();

		const { host, markup } = mount(controller);
		// Empty-while-loading is a valid state: nothing is claimed before the
		// reco read answers. The 300ms toast law (AppController) is what speaks.
		expect(host.querySelectorAll(SMITHERS_MESSAGES)).toHaveLength(0);
		expect(FILLER.test(markup())).toBe(false);
	});
});
