import { describe, expect, test } from "bun:test";
import type { StorageApi } from "@tanstack/db";
import { createAppController } from "./AppController";
import type { AppServices } from "./AppController";
import { createAppStore } from "./AppStore";
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge";
import type { StartAgentTurnRequest } from "smithers-shared/NativeAgent";

const memoryStorage = (): StorageApi => {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key),
	};
};

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() });

const unavailableRepositories: NativeRepositories = {
	available: false,
	pickLocalRepository: async () => ({
		status: "error",
		code: "native-required",
		message: "Local repositories can only be connected from the Smithers native app.",
	}),
};

const silentAgent = (): NativeAgent => ({
	available: true,
	startTurn: async () => ({ status: "started" }),
	cancelTurn: async () => {},
	subscribe: () => () => {},
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A test-double backend: routes answers by path, recording request bodies. */
const backend = (
	routes: Record<string, Response | ((request: Request) => Response | Promise<Response>)>,
	posts: Array<{ path: string; body: unknown }> = [],
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

describe("the reco seam's first-run answer", () => {
	test("a grounded digest replaces the welcome as the first Smithers message and lands the one recommendation card", async () => {
		const store = await webStore();
		const controller = createAppController(store, unavailableRepositories, silentAgent(), {
			...backend({ "/api/reco/first-run": json(200, GROUNDED) }),
		});
		await controller.loadFirstRunReco();

		const messages = [...store.collections.messages.values()].sort((a, b) => a.ordinal - b.ordinal);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.id).toBe("message-reco-digest");
		expect(messages[0]?.role).toBe("smithers");
		expect(messages[0]?.text).toBe(GROUNDED.digest.sentence);
		// The filler welcome is gone — the digest IS the first message.
		expect(messages.some((message) => message.text.startsWith("Hey — I’m Smithers"))).toBe(false);

		const card = store.collections.cards.get("reco-current");
		expect(card?.kind).toBe("reco");
		if (card?.kind === "reco") {
			expect(card.payload.digest.reposConsidered).toBe(12);
			expect(card.payload.digest.mostActiveRepo).toBe("will/flows");
			expect(card.payload.digest.oldestWaiting?.label).toContain("will/flows#12");
			expect(card.payload.recommendation?.id).toBe("review-pr:will/flows#12");
			expect(card.payload.recommendation?.evidenceKey).toBe("0123456789abcdef");
			expect(card.payload.recommendation?.whatHappens).toContain("nothing is merged");
		}
	});

	test("a degraded answer renders the honestMessage as the first message — never a fake digest", async () => {
		const store = await webStore();
		const controller = createAppController(store, unavailableRepositories, silentAgent(), {
			...backend({
				"/api/reco/first-run": json(200, {
					degraded: true,
					reason: "missing_scope",
					honestMessage:
						"I can't read your repositories yet — sign-in didn't include the repo scope.",
				}),
			}),
		});
		await controller.loadFirstRunReco();
		const messages = [...store.collections.messages.values()];
		expect(messages).toHaveLength(1);
		expect(messages[0]?.text).toContain("repo scope");
		expect(store.collections.cards.get("reco-current")).toBeUndefined();
	});

	test("an unset seam answers honestly, still without a card", async () => {
		const store = await webStore();
		const controller = createAppController(store, unavailableRepositories, silentAgent(), {
			...backend({
				"/api/reco/first-run": json(501, {
					status: "error",
					message: "The recommendations seam is not configured on this deployment (RECO_UPSTREAM_URL is unset).",
				}),
			}),
		});
		await controller.loadFirstRunReco();
		const messages = [...store.collections.messages.values()];
		expect(messages).toHaveLength(1);
		expect(messages[0]?.text).toContain("RECO_UPSTREAM_URL");
		expect(store.collections.cards.get("reco-current")).toBeUndefined();
	});

	test("dismiss posts feedback with the evidenceKey and removes the card without argument", async () => {
		const store = await webStore();
		const posts: Array<{ path: string; body: unknown }> = [];
		const controller = createAppController(store, unavailableRepositories, silentAgent(), {
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

		const result = await controller.dismissRecommendation();
		expect(result).toBeUndefined();
		expect(store.collections.cards.get("reco-current")).toBeUndefined();
		const feedback = posts.find((post) => post.path === "/api/reco/feedback");
		expect(feedback?.body).toEqual({
			recommendationId: "review-pr:will/flows#12",
			action: "dismiss",
			evidenceKey: "0123456789abcdef",
		});
		// The digest sentence stays — only the card leaves.
		expect(store.collections.messages.get("message-reco-digest")?.text).toBe(GROUNDED.digest.sentence);
	});

	test("a failed dismiss post keeps the card, honestly in error, and a retry works", async () => {
		const store = await webStore();
		let fail = true;
		const controller = createAppController(store, unavailableRepositories, silentAgent(), {
			...backend({
				"/api/reco/first-run": json(200, GROUNDED),
				"/api/reco/feedback": () => {
					if (fail) {
						fail = false;
						return json(500, { status: "error", message: "reco stub forced failure" });
					}
					return json(201, { recorded: true, action: "dismiss", recommendationId: "x" });
				},
			}),
		});
		await controller.loadFirstRunReco();
		await controller.dismissRecommendation();
		const failed = store.collections.cards.get("reco-current");
		expect(failed?.status).toBe("error");
		if (failed?.kind === "reco") expect(failed.payload.error).toContain("forced failure");

		await controller.dismissRecommendation();
		expect(store.collections.cards.get("reco-current")).toBeUndefined();
	});

	test("accept posts feedback, freezes the card, and runs the proposal as an ordinary turn", async () => {
		const store = await webStore();
		const turns: Array<StartAgentTurnRequest> = [];
		const recordingAgent: NativeAgent = {
			available: true,
			startTurn: async (request) => {
				turns.push(request);
				return { status: "started" };
			},
			cancelTurn: async () => {},
			subscribe: () => () => {},
		};
		const posts: Array<{ path: string; body: unknown }> = [];
		const controller = createAppController(store, unavailableRepositories, recordingAgent, {
			...backend(
				{
					"/api/reco/first-run": json(200, GROUNDED),
					"/api/reco/feedback": json(201, { recorded: true, action: "accept", recommendationId: "x" }),
				},
				posts,
			),
		});
		await controller.loadFirstRunReco();
		await controller.acceptRecommendation();

		const card = store.collections.cards.get("reco-current");
		expect(card?.status).toBe("acted");
		expect(posts.find((post) => post.path === "/api/reco/feedback")?.body).toMatchObject({
			action: "accept",
		});
		// The affordance runs as a command: the proposal went out as a real turn.
		expect(turns).toHaveLength(1);
		expect(turns[0]?.messages.some((m) => "content" in m && m.content === GROUNDED.recommendation!.proposes)).toBe(
			true,
		);
		expect(
			[...store.collections.messages.values()].some(
				(m) => m.role === "user" && m.text === GROUNDED.recommendation!.proposes,
			),
		).toBe(true);
	});

	test("edit posts feedback and opens the composer prefilled with the proposal", async () => {
		const store = await webStore();
		const posts: Array<{ path: string; body: unknown }> = [];
		const controller = createAppController(store, unavailableRepositories, silentAgent(), {
			...backend(
				{
					"/api/reco/first-run": json(200, GROUNDED),
					"/api/reco/feedback": json(201, { recorded: true, action: "edit", recommendationId: "x" }),
				},
				posts,
			),
		});
		await controller.loadFirstRunReco();
		await controller.editRecommendation();
		expect(store.session().draft).toBe(GROUNDED.recommendation!.proposes);
		expect(store.collections.cards.get("reco-current")?.status).toBe("acted");
		expect(posts.find((post) => post.path === "/api/reco/feedback")?.body).toMatchObject({
			action: "edit",
		});
	});

	test("the / surface lists the current recommendation FIRST; bare / + Enter runs it", async () => {
		const store = await webStore();
		const controller = createAppController(store, unavailableRepositories, silentAgent(), {
			...backend({ "/api/reco/first-run": json(200, GROUNDED) }),
		});
		await controller.loadFirstRunReco();
		const items = controller.slashItems("");
		expect(items[0]?.command.name).toBe("reco.accept");
		expect(items[0]?.recommended).toBe(true);
		// The bare listing is CAPPED (SLASH_MENU_CAP) — the reco verbs stay
		// reachable by typing, which is the filter path.
		expect(controller.slashItems("reco").map((item) => item.command.name)).toContain("reco.refresh");
	});

	test("reco commands answer honestly when there is no recommendation", async () => {
		const store = await webStore();
		const controller = createAppController(store, unavailableRepositories, silentAgent());
		expect(await controller.commands.run("reco.accept")).toEqual({
			status: "failed",
			error: "There is no current recommendation to accept.",
		});
	});

	test("entering chat signed-in and allowlisted reads the first-run answer (loadSession chains it)", async () => {
		const store = await webStore();
		const controller = createAppController(store, unavailableRepositories, silentAgent(), {
			...backend({
				"/api/auth/session": json(200, { login: "will", allowlisted: true, admin: false }),
				"/api/reco/first-run": json(200, GROUNDED),
			}),
		});
		await controller.loadSession();
		await settled();
		expect(store.collections.messages.get("message-reco-digest")?.text).toBe(GROUNDED.digest.sentence);
		expect(store.collections.cards.get("reco-current")?.kind).toBe("reco");
	});
});
