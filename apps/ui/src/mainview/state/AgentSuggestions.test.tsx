import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { StorageApi } from "@tanstack/db";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "../App";
import { createAppController } from "./AppController";
import type { AppController as AppControllerType } from "./AppController";
import { createAppStore } from "./AppStore";
import type { AppStore } from "./AppStore";
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge";
import type { AgentTurnFrame, StartAgentTurnRequest } from "smithers-shared/NativeAgent";

/*
 * Directive 2 (will, 2026-08-19): "If it can predict what user might ask next
 * like this case 'What is a flow' smithers should display those as default
 * responses or the ability to trigger a flow as a / command".
 *
 * The agent proposes through one structured channel; the boundary validates
 * before anything is stored; the pills compose with the state-derived row and
 * leave when the conversation moves past the answer they belong to.
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

const silentAgent: NativeAgent = {
	available: true,
	startTurn: async () => ({ status: "started" }),
	cancelTurn: async () => {},
	subscribe: () => () => {},
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const mount = (controller: AppControllerType): { host: HTMLElement } => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App controller={controller} />));
	mounted.push(() => {
		flushSync(() => root.unmount());
		host.remove();
	});
	return { host };
};

const signedIn = async (store: AppStore): Promise<void> => {
	store.dispatch({
		type: "identity.session.loaded",
		actor: "system",
		state: "signed-in",
		login: "will",
		allowlisted: true,
		admin: false,
		scopesPlain: null,
	});
	store.dispatch({
		type: "watched.replaced",
		actor: "system",
		selected: ["will/flows"],
		selectedAt: "2026-08-19T09:00:00.000Z",
		via: "command",
	});
	await settled();
};

const propose = async (controller: AppControllerType, args: string) =>
	controller.commands.run("suggestions.propose", args);

const pills = (host: HTMLElement): Array<HTMLElement> => [
	...host.querySelectorAll<HTMLElement>(".smithers-suggestion"),
];

describe("the agent's predicted follow-ups (will, 2026-08-19)", () => {
	test("a question and a flow become pills: one submits the user's words, one runs the flow", async () => {
		const store = await webStore();
		const controller = createAppController(store, unavailableRepositories, silentAgent);
		await signedIn(store);
		const outcome = await propose(
			controller,
			JSON.stringify([
				{ kind: "question", label: "What is a flow" },
				{ kind: "flow", label: "See my repositories", flow: "github" },
			]),
		);
		expect(outcome.status).toBe("executed");
		await settled();

		expect(store.session().agentSuggestions).toEqual([
			{ kind: "question", label: "What is a flow" },
			{ kind: "flow", label: "See my repositories", flow: "github" },
		]);

		const { host } = mount(controller);
		const rendered = pills(host);
		expect(rendered).toHaveLength(2);
		// A question pill is still a BINDING: it submits the user's own message.
		expect(rendered[0]?.dataset.flow).toBe("send");
		expect(rendered[0]?.textContent).toContain("What is a flow");
		// A flow pill carries its registered flow, exactly like the derived row.
		expect(rendered[1]?.dataset.flow).toBe("github");
		// Neither is gold: the state-derived recommendation keeps that emphasis.
		expect(rendered[0]?.dataset.gold).toBe("false");
	});

	test("the proposal enters through the dispatcher with the agent recorded", async () => {
		const store = await webStore();
		const controller = createAppController(store, unavailableRepositories, silentAgent);
		await signedIn(store);
		await propose(controller, JSON.stringify([{ kind: "question", label: "What is a flow" }]));
		await settled();
		const record = [...store.collections.transitions.values()].find(
			(entry) => entry.type === "agent.suggestions.proposed",
		);
		expect(record?.actor).toBe("smithers");
		expect(record?.payload).toContain("What is a flow");
	});

	test("they compose with the state-derived pills instead of replacing them", async () => {
		const store = await webStore();
		const controller = createAppController(store, unavailableRepositories, silentAgent);
		store.dispatch({
			type: "identity.session.loaded",
			actor: "system",
			state: "signed-out",
			login: null,
			allowlisted: false,
			admin: false,
			scopesPlain: null,
		});
		await settled();
		await propose(controller, JSON.stringify([{ kind: "question", label: "What is Smithers" }]));
		await settled();
		const { host } = mount(controller);
		const rendered = pills(host);
		expect(rendered.map((pill) => pill.dataset.flow)).toEqual(["auth.sign-in", "send"]);
		// The state-derived step still leads, and still leads in gold.
		expect(rendered[0]?.dataset.gold).toBe("true");
	});

	test("pressing a question pill sends it as the user's own message", async () => {
		const store = await webStore();
		const controller = createAppController(store, unavailableRepositories, silentAgent);
		await signedIn(store);
		await propose(controller, JSON.stringify([{ kind: "question", label: "What is a flow" }]));
		await settled();
		const { host } = mount(controller);
		flushSync(() => pills(host)[0]?.click());
		await settled();
		const user = [...store.collections.messages.values()].find((message) => message.role === "user");
		expect(user?.text).toBe("What is a flow");
	});

	test("they belong to one answer: the next thing the user says clears them", async () => {
		const store = await webStore();
		const controller = createAppController(store, unavailableRepositories, silentAgent);
		await signedIn(store);
		await propose(controller, JSON.stringify([{ kind: "question", label: "What is a flow" }]));
		await settled();
		expect(store.session().agentSuggestions).toHaveLength(1);
		controller.send("something else entirely");
		await settled();
		expect(store.session().agentSuggestions).toEqual([]);
	});

	test("a fresh conversation carries none of them", async () => {
		const store = await webStore();
		const controller = createAppController(store, unavailableRepositories, silentAgent);
		await signedIn(store);
		await propose(controller, JSON.stringify([{ kind: "question", label: "What is a flow" }]));
		await settled();
		store.dispatch({ type: "conversation.reset", actor: "user" });
		await settled();
		expect(store.session().agentSuggestions).toEqual([]);
	});

	test("an empty proposal is a correct state: the row goes back to what state derives", async () => {
		const store = await webStore();
		const controller = createAppController(store, unavailableRepositories, silentAgent);
		await signedIn(store);
		await propose(controller, JSON.stringify([{ kind: "question", label: "What is a flow" }]));
		await settled();
		await propose(controller, "[]");
		await settled();
		expect(store.session().agentSuggestions).toEqual([]);
		const { host } = mount(controller);
		expect(pills(host)).toHaveLength(0);
	});

	test("at most three: a longer list is cut, never rendered as a menu", async () => {
		const store = await webStore();
		const controller = createAppController(store, unavailableRepositories, silentAgent);
		await signedIn(store);
		await propose(
			controller,
			JSON.stringify(
				["one", "two", "three", "four", "five"].map((label) => ({ kind: "question", label })),
			),
		);
		await settled();
		expect(store.session().agentSuggestions).toHaveLength(3);
	});

	describe("the boundary refuses by name, and nothing reaches the store", () => {
		const refuses = async (args: string, contains: string) => {
			const store = await webStore();
			const controller = createAppController(store, unavailableRepositories, silentAgent);
			await signedIn(store);
			const outcome = await propose(controller, args);
			expect(outcome.status).toBe("failed");
			if (outcome.status === "failed") expect(outcome.error).toContain(contains);
			await settled();
			expect(store.session().agentSuggestions ?? []).toEqual([]);
		};

		test("a flow the registry does not list", async () => {
			await refuses(
				JSON.stringify([{ kind: "flow", label: "Deploy it", flow: "deploy.production" }]),
				"no listed flow is named deploy.production",
			);
		});

		test("a hidden id-scoped action, which is not the human's pill to press", async () => {
			await refuses(
				JSON.stringify([{ kind: "flow", label: "Toggle it", flow: "repos.watch.toggle" }]),
				"no listed flow is named repos.watch.toggle",
			);
		});

		test("a command smuggled in as a question", async () => {
			await refuses(
				JSON.stringify([{ kind: "question", label: "/github" }]),
				"is a command, not a question",
			);
		});

		test("a kind that is neither", async () => {
			await refuses(
				JSON.stringify([{ kind: "prompt", label: "Tell me more" }]),
				'a suggestion\'s kind is "question" or "flow"',
			);
		});

		test("a label with nothing in it", async () => {
			await refuses(JSON.stringify([{ kind: "question", label: "   " }]), "needs a label");
		});

		test("arguments that are not the documented shape", async () => {
			await refuses("what is a flow", "suggestions.propose takes a JSON array");
		});
	});
});

/**
 * A scripted transport: the model asks for a command, the client executes it
 * through the registry and posts the continuation leg back.
 */
const scriptedToolAgent = (
	steps: ReadonlyArray<(request: StartAgentTurnRequest) => ReadonlyArray<Omit<AgentTurnFrame, "runId">>>,
): { agent: NativeAgent; requests: Array<StartAgentTurnRequest> } => {
	const requests: Array<StartAgentTurnRequest> = [];
	const listeners = new Set<(frame: AgentTurnFrame) => void>();
	const agent: NativeAgent = {
		available: true,
		startTurn: async (request) => {
			const step = steps[requests.length] ?? steps[steps.length - 1];
			requests.push(request);
			queueMicrotask(() => {
				for (const frame of step?.(request) ?? []) {
					for (const listener of listeners) listener({ ...frame, runId: request.runId } as AgentTurnFrame);
				}
			});
			return { status: "started" };
		},
		cancelTurn: async () => {},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return { agent, requests };
};

describe("the follow-up channel in a real turn", () => {
	test("the agent proposes mid-turn, and the transcript stays free of the plumbing", async () => {
		const store = await webStore();
		const { agent } = scriptedToolAgent([
			() => [
				{
					type: "tool_call" as const,
					call_id: "call_1",
					name: "commands",
					arguments: JSON.stringify({
						action: "execute",
						name: "suggestions.propose",
						args: JSON.stringify([{ kind: "question", label: "What is a flow" }]),
					}),
				},
				{ type: "done" as const, reason: "tool_call" as const },
			],
			() => [
				{ type: "delta" as const, kind: "text" as const, text: "I am Smithers." },
				{ type: "done" as const, reason: "stop" as const },
			],
		]);
		const controller = createAppController(store, unavailableRepositories, agent);
		await signedIn(store);

		controller.send("Who are you");
		await settled();
		await settled();
		await settled();

		expect(store.session().agentSuggestions).toEqual([{ kind: "question", label: "What is a flow" }]);
		// The proposal is not an act: the pills ARE what it did, and they are
		// already on screen. No "Smithers ran /suggestions.propose" marker row.
		const acts = [...store.collections.messages.values()].filter((message) => message.act !== undefined);
		expect(acts).toEqual([]);
		// The answer itself still landed.
		const answer = [...store.collections.messages.values()].find(
			(message) => message.role === "smithers" && message.act === undefined,
		);
		expect(answer?.text).toBe("I am Smithers.");
	});
});
