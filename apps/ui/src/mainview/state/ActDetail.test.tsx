import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { StorageApi } from "@tanstack/db";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "../App";
import { createAppController } from "./AppController";
import type { AppController as AppControllerType } from "./AppController";
import { createAppStore } from "./AppStore";
import { actDetail, actDetailField, MAX_ACT_DETAIL } from "./MessageScrub";
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge";
import type { AgentTurnFrame, StartAgentTurnRequest } from "smithers-shared/NativeAgent";

/*
 * Directive 7 (will, 2026-08-19), about the transcript's act rows — "Smithers
 * ran /repos.watch", "Smithers adjusted its approach": "This is cool but I
 * can't click on it or hover to see more".
 *
 * The row now carries what it did. Hover states it, pressing it opens the SAME
 * row in place, and the scrub still holds: the visible line never carries a
 * payload, and the detail is cleaned and bounded.
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

/** A scripted transport: the model calls one command, then answers. */
const scriptedToolAgent = (
	steps: ReadonlyArray<(request: StartAgentTurnRequest) => ReadonlyArray<Omit<AgentTurnFrame, "runId">>>,
): NativeAgent => {
	const listeners = new Set<(frame: AgentTurnFrame) => void>();
	let turn = 0;
	return {
		available: true,
		startTurn: async (request) => {
			const step = steps[turn] ?? steps[steps.length - 1];
			turn += 1;
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
};

const callFor = (name: string, args?: string) => ({
	type: "tool_call" as const,
	call_id: "call_1",
	name: "commands",
	arguments: JSON.stringify({ action: "execute", name, ...(args === undefined ? {} : { args })}),
});

const actRow = (store: Awaited<ReturnType<typeof webStore>>) =>
	[...store.collections.messages.values()].find((message) => message.act !== undefined);

describe("the act row's detail is scrubbed and bounded", () => {
	test("prose survives; a payload is not pasted into the detail", () => {
		expect(actDetailField("open will/flows")).toBe("open will/flows");
		// A JSON object keeps its plain fields as words, never as a blob.
		expect(actDetailField('{"filter":"open","repo":"will/flows"}')).toBe("filter open, repo will/flows");
		// Anything that is only structure states nothing rather than a fragment.
		expect(actDetailField("[1,2,3]")).toBe("");
	});

	test("whitespace collapses to one line and the whole detail is bounded", () => {
		expect(actDetailField("a\n\n  b\tc")).toBe("a b c");
		const long = actDetail(["x".repeat(500)]) ?? "";
		expect(long.length).toBeLessThanOrEqual(MAX_ACT_DETAIL);
		expect(long.endsWith("…")).toBe(true);
	});

	test("an act with nothing to add carries no detail at all", () => {
		expect(actDetail([])).toBeUndefined();
		expect(actDetail(["", "   "])).toBeUndefined();
	});
});

describe("an act row carries what it did (will, 2026-08-19)", () => {
	test("the tool loop records the flow, its arguments and what came back", async () => {
		const store = await webStore();
		const agent = scriptedToolAgent([
			() => [callFor("issues.list", "open will/flows"), { type: "done" as const, reason: "tool_call" as const }],
			() => [
				{ type: "delta" as const, kind: "text" as const, text: "Here they are." },
				{ type: "done" as const, reason: "stop" as const },
			],
		]);
		const controller = createAppController(store, unavailableRepositories, agent, {
			fetchImpl: async () =>
				new Response(JSON.stringify({ status: "error", message: "no stub" }), { status: 404 }),
		});
		controller.send("show my issues");
		await settled();
		await settled();

		const row = actRow(store);
		expect(row?.act).toBeDefined();
		// The visible line is exactly what it always was.
		expect(row?.text.startsWith("Smithers ")).toBe(true);
		expect(row?.actDetail).toContain("/issues.list");
		expect(row?.actDetail).toContain("open will/flows");
		// The registry's own "executed /name" is what the visible line already
		// says, so the detail carries what the reader cannot see, not an echo.
		expect(row?.actDetail).not.toContain("executed /issues.list");
		// It starts closed: the row opens because the human opened it.
		expect(row?.actExpanded).toBe(false);
	});

	test("a payload-shaped result never reaches the visible line", async () => {
		const store = await webStore();
		const agent = scriptedToolAgent([
			() => [callFor("commands", undefined), { type: "done" as const, reason: "tool_call" as const }],
			() => [
				{ type: "delta" as const, kind: "text" as const, text: "That is what I can do." },
				{ type: "done" as const, reason: "stop" as const },
			],
		]);
		const controller = createAppController(store, unavailableRepositories, agent);
		controller.send("what can you do");
		await settled();
		await settled();
		const row = actRow(store);
		expect(row?.text).not.toContain("{");
		expect(row?.actDetail ?? "").not.toContain('{"');
	});
});

describe("the row opens in place, and only the human opens it", () => {
	const openable = async () => {
		const store = await webStore();
		const agent = scriptedToolAgent([
			() => [callFor("issues.list", "open will/flows"), { type: "done" as const, reason: "tool_call" as const }],
			() => [
				{ type: "delta" as const, kind: "text" as const, text: "Here they are." },
				{ type: "done" as const, reason: "stop" as const },
			],
		]);
		const controller = createAppController(store, unavailableRepositories, agent, {
			fetchImpl: async () =>
				new Response(JSON.stringify({ status: "error", message: "no stub" }), { status: 404 }),
		});
		controller.send("show my issues");
		await settled();
		await settled();
		return { store, controller };
	};

	test("the command toggles the one row, and the journal records the human", async () => {
		const { store, controller } = await openable();
		const id = actRow(store)?.id ?? "";
		expect((await controller.commands.run("act.detail", id)).status).toBe("executed");
		expect(actRow(store)?.actExpanded).toBe(true);
		expect((await controller.commands.run("act.detail", id)).status).toBe("executed");
		expect(actRow(store)?.actExpanded).toBe(false);
		const record = [...store.collections.transitions.values()].find(
			(entry) => entry.type === "message.act.toggled",
		);
		expect(record?.actor).toBe("user");
	});

	test("it is the human's act: the agent is refused by the trigger axis", async () => {
		const { controller } = await openable();
		const outcome = await controller.commands.runAsAgent("act.detail", "message-act-1");
		expect(outcome.status).toBe("failed");
	});

	test("a row with no detail has nothing to open, and says so", async () => {
		const store = await webStore();
		const controller = createAppController(store, unavailableRepositories, {
			available: true,
			startTurn: async () => ({ status: "started" }),
			cancelTurn: async () => {},
			subscribe: () => () => {},
		});
		store.dispatch({
			type: "message.tool.executed",
			actor: "smithers",
			turnId: "turn-1",
			text: "Smithers picked up your note",
		});
		await settled();
		const id = actRow(store)?.id ?? "";
		const outcome = await controller.commands.run("act.detail", id);
		expect(outcome.status).toBe("failed");
		if (outcome.status === "failed") expect(outcome.error).toContain("no detail");
	});

	test("hover states it, pressing it expands the same row, and aria-expanded says which way", async () => {
		const { store, controller } = await openable();
		const { host } = mount(controller);
		const toggle = host.querySelector<HTMLButtonElement>(".tool-act-line .tool-act-toggle");
		expect(toggle).not.toBeNull();
		// Hover: the whole detail, on the row itself.
		expect(toggle?.title).toBe(actRow(store)?.actDetail ?? "");
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		// It is a real button, so Enter and Space toggle it with no key handler.
		expect(toggle?.tagName).toBe("BUTTON");
		expect(toggle?.dataset.flow).toBe("act.detail");

		flushSync(() => toggle?.click());
		expect(
			host.querySelector<HTMLButtonElement>(".tool-act-line .tool-act-toggle")?.getAttribute("aria-expanded"),
		).toBe("true");
		const detail = host.querySelector(".tool-act-line .tool-act-detail");
		// Embedded: the detail is inside the row it belongs to, not a takeover.
		expect(detail?.textContent).toBe(actRow(store)?.actDetail ?? "");
		// The transcript and the composer are still there: an expansion is not a view.
		expect(host.querySelectorAll(".smithers-transcript").length).toBe(1);
		expect(host.querySelectorAll("textarea").length).toBe(1);

		flushSync(() => host.querySelector<HTMLButtonElement>(".tool-act-line .tool-act-toggle")?.click());
		expect(host.querySelector(".tool-act-line .tool-act-detail")).toBeNull();
	});
});
