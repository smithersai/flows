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

/*
 * Directive 1b (will, 2026-08-19): "I think what we should be showing here is a
 * bit of a github pane so we should see a list of repos available and if we
 * click on it we see the repo view which will include tabs for issues, prs,
 * flows."
 *
 * The pane opens on the LIST, the list is the account's own repositories in the
 * chooser's three columns, a row opens the repo view, and every tab renders the
 * read behind it or says honestly that nothing has been read.
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

const CANDIDATES = [
	{ fullName: "will/flows", private: false, pushedAt: "2026-08-18T09:00:00.000Z", openIssues: 4 },
	{ fullName: "will/quiet", private: false, pushedAt: null, openIssues: 0 },
];

/*
 * Only the repository catalog is answered here: every other read the pane
 * kicks off is background work whose failure the pane already states honestly,
 * and answering them would be inventing a backend this test does not have.
 */
const catalogFetch = (): typeof fetch =>
	(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/api/reco/repos")) {
			return new Response(JSON.stringify({ candidates: CANDIDATES }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
	}) as typeof fetch;

const controllerWith = (store: AppStore): AppControllerType =>
	createAppController(store, unavailableRepositories, silentAgent, { fetchImpl: catalogFetch() });

const signedIn = async (store: AppStore, watched: ReadonlyArray<string>): Promise<void> => {
	store.dispatch({
		type: "identity.session.loaded",
		actor: "system",
		state: "signed-in",
		login: "will",
		allowlisted: true,
		admin: false,
		scopesPlain: null,
	});
	if (watched.length > 0) {
		store.dispatch({
			type: "watched.replaced",
			actor: "system",
			selected: [...watched],
			selectedAt: "2026-08-19T09:00:00.000Z",
			via: "command",
		});
	}
	await settled();
};

const rows = (host: HTMLElement): Array<HTMLElement> => [
	...host.querySelectorAll<HTMLElement>('.repo-chooser-row[data-flow="repo.open"]'),
];

describe("the GitHub pane (will, 2026-08-19)", () => {
	test("/github opens the pane on the repository list, with nothing watched", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, []);
		expect((await controller.commands.run("github")).status).toBe("executed");
		await settled();
		// The pane opened. Before this it returned silently when nothing was
		// watched, so the digest card's own button did nothing at all.
		expect(store.session().surface).toBe("github");
		expect(store.session().selectedRepository).toBeNull();

		const { host } = mount(controller);
		expect(host.querySelector('[aria-label="GitHub repositories"]')).not.toBeNull();
		expect(rows(host).map((row) => row.textContent)).toEqual([
			expect.stringContaining("will/flows"),
			expect.stringContaining("will/quiet"),
		]);
	});

	test("a row states the three columns the chooser row states", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, []);
		await controller.commands.run("github");
		await settled();
		const { host } = mount(controller);
		const first = rows(host)[0];
		expect(first?.querySelector(".repo-chooser-name")?.textContent).toBe("will/flows");
		expect(first?.querySelector(".repo-chooser-freshness")?.textContent).not.toBe("");
		expect(first?.querySelector(".repo-chooser-issues")?.textContent).toBe("4 open issues");
	});

	test("a watched repository the catalog has not answered for shows its name and nothing invented", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, ["will/offline"]);
		store.dispatch({ type: "surface.changed", actor: "user", surface: "github" });
		await settled();
		const { host } = mount(controller);
		const only = rows(host)[0];
		expect(only?.querySelector(".repo-chooser-name")?.textContent).toBe("will/offline");
		// No freshness it never read, no issue count nobody counted.
		expect(only?.querySelector(".repo-chooser-freshness")).toBeNull();
		expect(only?.querySelector(".repo-chooser-issues")).toBeNull();
	});

	test("the empty catalog is an honest empty state, not an invented row", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, []);
		store.dispatch({ type: "repos.catalog.loaded", actor: "user", available: [] });
		store.dispatch({ type: "surface.changed", actor: "user", surface: "github" });
		await settled();
		const { host } = mount(controller);
		expect(rows(host)).toHaveLength(0);
		expect(host.querySelector(".repo-chooser-empty")?.textContent).toBe("No repositories to browse yet.");
	});

	test("clicking a row opens the repo view with its four tabs and the way back", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, []);
		await controller.commands.run("github");
		await settled();
		expect((await controller.commands.run("repo.open", "will/flows")).status).toBe("executed");
		await settled();
		expect(store.session().selectedRepository).toBe("will/flows");
		const { host } = mount(controller);
		const tabs = [...host.querySelectorAll<HTMLElement>('[data-flow="repo.tab"]')];
		expect(tabs.map((tab) => tab.textContent)).toEqual(["Files", "Issues", "Pull Requests", "Flows"]);
		// The list is one press away again — the pane is a browser, not a trap.
		expect(host.querySelector('[data-flow="github"]')?.textContent).toContain("All repositories");
	});

	test("the selection enters through the dispatcher with the actor recorded", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, []);
		await controller.commands.run("repo.open", "will/flows");
		await settled();
		const record = [...store.collections.transitions.values()]
			.filter((entry) => entry.type === "repository.selected")
			.at(-1);
		expect(record?.actor).toBe("user");
		expect(record?.payload).toContain("will/flows");
	});

	test("the Flows tab renders the repository's own flows, not a pointer at the transcript", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, []);
		await controller.commands.run("repo.open", "will/flows");
		await settled();
		store.dispatch({
			type: "card.upsert",
			actor: "system",
			card: {
				id: "workflow-list-will/flows",
				kind: "workflow-list",
				title: "Workflows — will/flows",
				status: "active",
				createdAt: 1,
				ordinal: 1,
				payload: { repo: "will/flows", workflows: [{ key: "alpha-ui", description: "The alpha UI lane" }] },
			},
		});
		await controller.commands.run("repo.tab", "flows");
		await settled();
		const { host } = mount(controller);
		const flows = host.querySelector(".workflow-list");
		expect(flows?.textContent).toContain("alpha-ui");
		expect(host.textContent).not.toContain("available in the transcript");
	});

	test("the issue and pull-request rows retain the author and updated time their seams read", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, []);
		await controller.commands.run("repo.open", "will/flows");
		store.dispatch({
			type: "card.upsert",
			actor: "system",
			card: {
				id: "issues-will/flows",
				kind: "issue-list",
				title: "Issues · will/flows",
				status: "active",
				createdAt: 1,
				ordinal: 1,
				payload: {
					repo: "will/flows",
					filter: "open",
					issues: [{ number: 7, title: "Keep the row honest", state: "open", author: "will", comments: 2, updatedAt: "2026-08-19T09:00:00Z" }],
				},
			},
		});
		store.dispatch({
			type: "card.upsert",
			actor: "system",
			card: {
				id: "prs-will/flows",
				kind: "pr-list",
				title: "Pull requests · will/flows",
				status: "active",
				createdAt: 2,
				ordinal: 2,
				payload: { repo: "will/flows", landings: [{ number: 8, title: "Show when it changed", state: "open", author: "will", updatedAt: "2026-08-19T10:00:00Z" }] },
			},
		});
		await controller.commands.run("repo.tab", "issues");
		await settled();
		const { host } = mount(controller);
		expect(host.textContent).toContain("by will");
		expect(host.textContent).toContain("2026-08-19 09:00");
		await controller.commands.run("repo.tab", "pulls");
		await settled();
		expect(host.textContent).toContain("2026-08-19 10:00");
	});

	test("a repository with no flows read says so instead of showing an empty list", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, []);
		await controller.commands.run("repo.open", "will/flows");
		await settled();
		await controller.commands.run("repo.tab", "flows");
		await settled();
		const { host } = mount(controller);
		expect(host.textContent).toContain("No flows have been read for this repository.");
	});
});
