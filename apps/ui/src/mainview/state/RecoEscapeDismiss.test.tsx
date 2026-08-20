import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { StorageApi } from "@tanstack/db";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "../App";
import { ControllerTestProvider } from "../ControllerContext";
import { createAppController } from "./AppController";
import type { AppController as AppControllerType, AppServices } from "./AppController";
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge";
import { createAppStore } from "./AppStore";

/*
 * Launch checklist A-9: Escape must dismiss the recommendation card in one
 * keypress, even when focus sits elsewhere (the composer autofocuses on
 * load, so that's the common case, not tabbing into the card first). The
 * dismissal has to route through the same reco.dismiss flow the "Not now"
 * button uses, so the feedback POST fires and the same recommendation
 * doesn't come back unchanged.
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

const mount = (controller: AppControllerType): { host: HTMLElement } => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>));
	mounted.push(() => {
		flushSync(() => root.unmount());
		host.remove();
	});
	return { host };
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
	routes: Record<string, Response | ((request: Request) => Response | Promise<Response>)>,
	posts: Array<{ path: string; body: unknown }>,
): AppServices => ({
	fetchImpl: async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const absolute = new URL(url, "https://app.test");
		const path = absolute.pathname + absolute.search;
		if (init?.method === "POST" && typeof init.body === "string") {
			posts.push({ path, body: JSON.parse(init.body) });
		}
		for (const [route, answer] of Object.entries(routes)) {
			if (path === route || path.startsWith(`${route}?`)) {
				return typeof answer === "function"
					? answer(new Request(absolute.toString(), init))
					: answer.clone();
			}
		}
		return json(404, { status: "error", message: `no stub for ${path}` });
	},
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const GROUNDED = {
	degraded: false,
	cached: false,
	digest: {
		login: "will",
		computedAt: "2026-08-08T09:00:00.000Z",
		reposConsidered: 12,
		openIssues: 7,
		openPullRequests: 2,
		staleCount: 3,
		mostActiveRepo: { name: "will/flows", pushedAt: "2026-08-07T12:00:00.000Z" },
		oldestWaiting: {
			kind: "pr",
			repo: "will/flows",
			number: 12,
			title: "Wire the sync adapter",
			url: "https://github.com/will/flows/pull/12",
			updatedAt: "2026-07-28T10:00:00.000Z",
			waitingDays: 11,
		},
		untriagedInMostActive: 4,
		sentence: "You have 7 open issues and 2 open PRs across 12 repos; the oldest is waiting 11 days.",
	},
	recommendation: {
		id: "review-pr:will/flows#12",
		type: "review-pr",
		rank: 1,
		title: 'Review "Wire the sync adapter" in will/flows',
		proposes: 'Open pull request #12 ("Wire the sync adapter") in will/flows for review.',
		whyNow: "It is the oldest pull request waiting on you — untouched for 11 days.",
		whatHappens: "Smithers opens the diff and walks it with you; nothing is merged until you say so.",
		subject: {
			kind: "pr",
			repo: "will/flows",
			number: 12,
			title: "Wire the sync adapter",
			url: "https://github.com/will/flows/pull/12",
			updatedAt: "2026-07-28T10:00:00.000Z",
		},
		evidence: {
			subjectUpdatedAt: "2026-07-28T10:00:00.000Z",
			openIssues: 7,
			openPullRequests: 2,
			staleCount: 3,
			untriagedInMostActive: 4,
		},
		evidenceKey: "0123456789abcdef",
		affordances: {
			accept: { label: "Do it", command: "reco.feedback accept review-pr:will/flows#12" },
			edit: { label: "Edit first", command: "reco.feedback edit review-pr:will/flows#12" },
			dismiss: { label: "Not now", command: "reco.feedback dismiss review-pr:will/flows#12" },
		},
	},
};

describe("A-9: Escape dismisses the recommendation card in one keypress", () => {
	test("Escape fired outside the card (composer focus) removes the card through the reco.dismiss flow", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		const posts: Array<{ path: string; body: unknown }> = [];
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			...backend(
				{
					"/api/reco/first-run": json(200, GROUNDED),
					"/api/reco/feedback": json(201, {
						recorded: true,
						action: "dismiss",
						recommendationId: "review-pr:will/flows#12",
					}),
				},
				posts,
			),
		});
		await controller.loadFirstRunReco();
		expect(store.collections.cards.get("reco-current")).toBeDefined();

		const { host } = mount(controller);
		expect(host.querySelector(".reco-card")).not.toBeNull();

		// The composer is where focus actually sits (it autofocuses on load) —
		// not the card. A-9's failure was that Escape only worked once the
		// card itself had been explicitly focused.
		const composer = host.querySelector("textarea");
		expect(composer).not.toBeNull();
		flushSync(() => {
			composer?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});
		await settled();
		await settled();

		expect(store.collections.cards.get("reco-current")).toBeUndefined();
		expect(host.querySelector(".reco-card")).toBeNull();

		const feedback = posts.find((post) => post.path === "/api/reco/feedback");
		expect(feedback?.body).toEqual({
			recommendationId: "review-pr:will/flows#12",
			action: "dismiss",
			evidenceKey: "0123456789abcdef",
		});
	});

	test("Escape that closes the slash menu leaves the reco card in place", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		const posts: Array<{ path: string; body: unknown }> = [];
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			...backend(
				{
					"/api/reco/first-run": json(200, GROUNDED),
					"/api/reco/feedback": json(201, {
						recorded: true,
						action: "dismiss",
						recommendationId: "review-pr:will/flows#12",
					}),
				},
				posts,
			),
		});
		await controller.loadFirstRunReco();
		expect(store.collections.cards.get("reco-current")).toBeDefined();

		const { host } = mount(controller);
		expect(host.querySelector(".reco-card")).not.toBeNull();

		flushSync(() => controller.changeDraft("/"));
		expect(host.querySelector(".slash-menu")).not.toBeNull();

		const composer = host.querySelector("textarea");
		expect(composer).not.toBeNull();
		flushSync(() => {
			composer?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});
		await settled();
		await settled();

		// The composer's own Escape handler closed the slash menu and called
		// preventDefault(); the app-shell fallback must see that and not also
		// dismiss the reco card underneath it.
		expect(host.querySelector(".slash-menu")).toBeNull();
		expect(store.collections.cards.get("reco-current")).toBeDefined();
		expect(host.querySelector(".reco-card")).not.toBeNull();
		expect(posts.find((post) => post.path === "/api/reco/feedback")).toBeUndefined();
	});
});
