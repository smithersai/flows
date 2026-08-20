import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { StorageApi } from "@tanstack/db";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "../App";
import { ControllerTestProvider } from "../ControllerContext";
import { createAppController } from "./AppController";
import type { AppController as AppControllerType } from "./AppController";
import { createAppStore } from "./AppStore";
import type { AppStore } from "./AppStore";
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge";
import { repoImportPolling } from "./seams/RepoImportSeam";

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

/** Poll the store rather than guess a delay; a miss fails on the deadline, never hangs. */
const until = async (ready: () => boolean, deadlineMs = 2_000): Promise<void> => {
	const started = Date.now();
	while (!ready()) {
		if (Date.now() - started > deadlineMs) throw new Error("the condition never became true");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
};

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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

	/*
	 * "Everything is pretty close to a github clone" (will, 2026-08-19). The
	 * three list tabs are one list: the Flows tab wears the same row treatment
	 * the Issues and Pull Requests tabs wear. What it must NOT wear is a column
	 * a flow does not have — a number, an open/closed badge, an author, a
	 * comment count — because NO INVENTION forbids dressing it in data the
	 * source never answered.
	 */
	test("the Flows tab wears the shared row treatment, with only the fields a flow has", async () => {
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
				payload: {
					repo: "will/flows",
					workflows: [
						{ key: "alpha-ui", description: "The alpha UI lane" },
						{ key: "post-failure", description: null },
					],
				},
			},
		});
		await controller.commands.run("repo.tab", "flows");
		await settled();
		const { host } = mount(controller);

		// The same list element the Issues and Pull Requests tabs render into.
		const list = host.querySelector("ul.world-card-list.workflow-list");
		expect(list).not.toBeNull();
		const rows = [...(list?.querySelectorAll<HTMLElement>("li.world-card-row") ?? [])];
		expect(rows.length).toBe(2);

		// Row one: the key as the row's title, the description as its metadata
		// column, the run act bound to the registered command.
		expect(rows[0]?.querySelector(".world-card-title")?.textContent).toBe("alpha-ui");
		expect(rows[0]?.querySelector(".world-card-path")?.textContent).toBe("The alpha UI lane");
		expect(rows[0]?.querySelector('[data-flow="flow.run"]')).not.toBeNull();

		// Row two has no description, so it states none — no placeholder copy.
		expect(rows[1]?.querySelector(".world-card-title")?.textContent).toBe("post-failure");
		expect(rows[1]?.querySelector(".world-card-path")).toBeNull();

		// Nothing a flow does not have: no issue number, no state badge.
		for (const row of rows) {
			expect(row.querySelector('[data-slot="badge"]')).toBeNull();
			expect(row.textContent).not.toContain("#");
		}
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

	/*
	 * THE EMBED LAW (AGENTS.md): the frame is a transcript entry at conversation
	 * width with the composer below — not a second column beside the chat. The
	 * shell allocates .chat-frame[data-pane] a 58% side pane, so the absence of
	 * that attribute is the load-bearing half of this.
	 */
	test("the pane is the last entry INSIDE the transcript, not a pane beside it", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, []);
		await controller.commands.run("github");
		await settled();
		const { host } = mount(controller);
		const pane = host.querySelector('[aria-label="GitHub repositories"]');
		const transcript = host.querySelector(".smithers-transcript");
		expect(pane).not.toBeNull();
		expect(transcript).not.toBeNull();
		expect(transcript?.contains(pane as Node)).toBe(true);
		// The conversation column keeps the whole shell.
		expect(host.querySelector(".chat-frame")?.getAttribute("data-pane")).toBeNull();
		expect(pane?.classList.contains("embedded-pane")).toBe(false);
		expect(pane?.classList.contains("transcript-pane")).toBe(true);
		// The composer is still below it, and the frame is the newest entry.
		expect(host.querySelector("textarea")).not.toBeNull();
		const messageColumn = pane?.parentElement;
		expect(messageColumn?.classList.contains("sui-chat-messages")).toBe(true);
		const entries = [...(messageColumn?.children ?? [])];
		expect(entries.at(-1) === pane).toBe(true);
	});

	test("the Files frame embeds in the transcript on the same terms", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, ["will/flows"]);
		expect((await controller.commands.run("files")).status).toBe("executed");
		await settled();
		const { host } = mount(controller);
		const pane = host.querySelector('[aria-label="Repository files"]');
		expect(pane).not.toBeNull();
		expect(host.querySelector(".smithers-transcript")?.contains(pane as Node)).toBe(true);
		expect(host.querySelector(".chat-frame")?.getAttribute("data-pane")).toBeNull();
		expect(host.querySelector("textarea")).not.toBeNull();
	});

	/*
	 * The Flows tab used to call listWorkspaceWorkflows() with no argument,
	 * which resolves the WATCHED set and answers with watched[0] — so opening
	 * the second repository read the first one's workspace.
	 */
	test("the Flows tab reads the repository that is open, not the first watched one", async () => {
		const store = await webStore();
		const asked: Array<string> = [];
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/api/reco/repos")) {
					return new Response(JSON.stringify({ candidates: CANDIDATES }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				// Both workflow calls (provision, then the listWorkflows RPC) name
				// their repository in the POST body.
				if (url.includes("/api/workflow")) {
					const body = JSON.parse(String(init?.body ?? "{}")) as { repo?: unknown };
					if (typeof body.repo === "string") asked.push(body.repo);
				}
				return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
			}) as typeof fetch,
		});
		await signedIn(store, ["will/first", "will/second"]);
		await controller.commands.run("repo.open", "will/second");
		await settled();
		await controller.commands.run("repo.tab", "flows");
		await settled();
		expect(store.session().selectedRepository).toBe("will/second");
		// The read named the repository on screen, and never the first watched one.
		expect(asked.length).toBeGreaterThan(0);
		expect([...new Set(asked)]).toEqual(["will/second"]);
		// Two repositories are watched, so the old path would have opened the
		// workflow chooser instead of reading the repository on screen.
		expect(store.collections.cards.get("workflow-repo")).toBeUndefined();
	});

	/*
	 * The Files frame used to take `selectedRepository ?? watched[0]`, which
	 * guesses a target whenever more than one repository is watched.
	 */
	test("the Files frame asks which repository when several are watched", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, ["will/first", "will/second"]);
		await controller.commands.run("files");
		await settled();
		expect(store.session().surface).toBe("files");
		expect(store.session().selectedRepository).toBeNull();
		const { host } = mount(controller);
		// A real choice, not a sentence: the repository list, each row bound to
		// the /files command that opens that repository.
		const choices = [...host.querySelectorAll<HTMLElement>('.repo-chooser-row[data-flow="files"]')];
		expect(choices.map((row) => row.querySelector(".repo-chooser-name")?.textContent)).toEqual([
			"will/flows",
			"will/quiet",
			"will/first",
			"will/second",
		]);
	});

	test("naming a repository opens the Files frame on it", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, ["will/first", "will/second"]);
		expect((await controller.commands.run("files", "will/second")).status).toBe("executed");
		await settled();
		expect(store.session().selectedRepository).toBe("will/second");
	});

	test("the single watched repository is the Files frame's target", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, ["will/only"]);
		await controller.commands.run("files");
		await settled();
		expect(store.session().selectedRepository).toBe("will/only");
	});

	/*
	 * The Files/Code tab and the Files frame are ONE component (will, 2026-08-19,
	 * directive 6: "the same view as the repo view's Files/Code tab").
	 */
	test("one files browser, mounted in both the Files frame and the repo view's Files tab", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, ["will/flows"]);
		await controller.commands.run("files");
		await settled();
		const filesFrame = mount(controller);
		expect(
			filesFrame.host.querySelectorAll('[data-repo-files-browser="shared"]'),
		).toHaveLength(1);
		await controller.commands.run("repo.open", "will/flows");
		await controller.commands.run("repo.tab", "files");
		await settled();
		const repoView = mount(controller);
		expect(repoView.host.querySelectorAll('[data-repo-files-browser="shared"]')).toHaveLength(1);
	});

	/*
	 * `files.list` parses the FIRST token as the path, so the root cannot be
	 * sent as the empty string: `" will/flows"` collapses to one token and the
	 * repository name is then read as a path.
	 */
	test("the breadcrumb at the root asks for the root, not for a path named after the repo", async () => {
		const store = await webStore();
		const paths: Array<string> = [];
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			fetchImpl: (async (input: RequestInfo | URL) => {
				const url = String(input);
				const contents = /\/contents\/?([^?]*)/.exec(url);
				if (contents !== null) {
					paths.push(decodeURIComponent(contents[1] ?? ""));
					return new Response(JSON.stringify([]), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
			}) as typeof fetch,
		});
		await signedIn(store, ["will/flows"]);
		await controller.commands.run("files");
		await settled();
		const { host } = mount(controller);
		const crumb = host.querySelector<HTMLElement>('[data-flow="files.list"]');
		expect(crumb).not.toBeNull();
		paths.length = 0;
		crumb?.click();
		await settled();
		// The root, addressed as the root — never as the repository's own name.
		expect(paths).toEqual([""]);
	});

	test("a pull-request row states its comment count beside the rest", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, []);
		await controller.commands.run("repo.open", "will/flows");
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
				payload: {
					repo: "will/flows",
					landings: [
						{
							number: 8,
							title: "Show when it changed",
							state: "open",
							author: "will",
							comments: 5,
							updatedAt: "2026-08-19T10:00:00Z",
						},
					],
				},
			},
		});
		await controller.commands.run("repo.tab", "pulls");
		await settled();
		const { host } = mount(controller);
		const row = host.querySelector('[data-flow="prs.view"]');
		expect(row?.textContent).toContain("#8 Show when it changed");
		expect(row?.textContent).toContain("5");
		expect(row?.textContent).toContain("by will");
		expect(row?.textContent).toContain("2026-08-19 10:00");
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

/*
 * A frame is a VIEW of reads the store already holds. Every repo-scoped read
 * card used to be rendered TWICE while a frame was open — once as a standalone
 * transcript card above the pane, once inside it — and every tab the user
 * visited left its list behind, so browsing three tabs left three stray lists
 * stacked above the pane. That is not a browsing pane; it is the transcript
 * with a pane in it.
 */
/*
 * The race directive 5 created, and the retry that closes it.
 *
 * Opening a repository starts a SILENT import and reads the repository in the
 * same breath. A repository the account has never mirrored answers every read
 * under `/api/repos/{o}/{r}/**` with a 404 until that import lands, and nothing
 * renders the import — so without a retry the first open of a fresh repository
 * sits on "Files have not been read yet." until the user tries again by hand.
 * That is the implementation detail leaking out as broken browsing.
 */
describe("the first open of a repository the account has not mirrored yet", () => {
	/** The import job the fake platform runs: cloning on the first poll, ready on the next. */
	const importingBackend = (repo: string) => {
		const calls = { contents: 0, imports: 0, polls: 0 };
		let mirrored = false;
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/api/reco/repos")) {
				return json({ candidates: CANDIDATES });
			}
			if (url.includes("/api/github/import/")) {
				calls.polls += 1;
				// One in-flight poll, then ready — the mirror exists from then on.
				if (calls.polls === 1) return json({ importJobId: "job-1", status: "cloning", stage: "cloning_github" });
				mirrored = true;
				return json({ importJobId: "job-1", status: "ready" });
			}
			if (url.includes("/api/github/import") && init?.method === "POST") {
				calls.imports += 1;
				return json({ importJobId: "job-1", status: "cloning", stage: "resolving" });
			}
			if (url.includes(`/api/repos/${repo}/contents`)) {
				calls.contents += 1;
				// The whole namespace 404s until the import lands: the body names
				// the REPOSITORY, never a path, which is the split FilesSeam reads.
				if (!mirrored) return json({ error: "repository not found" }, 404);
				return json([
					{ name: "README.md", path: "README.md", type: "file" },
					{ name: "src", path: "src", type: "dir" },
				]);
			}
			return json({}, 503);
		}) as typeof fetch;
		return { calls, fetchImpl };
	};

	test("the pane fills itself when the silent import lands, with no second act from the user", async () => {
		const store = await webStore();
		const backend = importingBackend("will/flows");
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			fetchImpl: backend.fetchImpl,
		});
		await signedIn(store, []);
		const restore = repoImportPolling.delayMs;
		repoImportPolling.delayMs = 1;
		try {
			await controller.commands.run("repo.open", "will/flows");
			await settled();
			// The first read really did degrade: the repository is not there yet.
			expect(backend.calls.contents).toBe(1);
			expect(store.collections.cards.get("files-will/flows-/")).toBeUndefined();
			const { host } = mount(controller);
			expect(host.textContent).toContain("Files have not been read yet.");

			// Nothing else is pressed from here on. The import lands, and the
			// frame re-runs the read that degraded.
			await until(() => store.collections.repoImports.get("will/flows")?.phase === "done");
			await until(() => store.collections.cards.get("files-will/flows-/") !== undefined);
			expect(backend.calls.contents).toBe(2);

			const listed = store.collections.cards.get("files-will/flows-/");
			expect(listed?.kind === "file-list" && listed.payload.entries.map((entry) => entry.name)).toEqual([
				"src",
				"README.md",
			]);
			// And the pane shows it: the projection follows the collection.
			flushSync(() => {});
			await settled();
			expect(host.textContent).toContain("README.md");
			// Still no import card, at any phase (directive 5).
			expect(store.collections.cards.get("repo-import-will/flows")).toBeUndefined();
		} finally {
			repoImportPolling.delayMs = restore;
		}
	});

	test("a read that did not degrade is never read twice", async () => {
		const store = await webStore();
		const backend = importingBackend("will/flows");
		const controller = createAppController(store, unavailableRepositories, silentAgent, {
			fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				// The mirror is already there: the contents read answers at once.
				if (url.includes("/api/repos/will/flows/contents")) {
					return json([{ name: "README.md", path: "README.md", type: "file" }]);
				}
				return backend.fetchImpl(input, init);
			}) as typeof fetch,
		});
		await signedIn(store, []);
		const restore = repoImportPolling.delayMs;
		repoImportPolling.delayMs = 1;
		try {
			await controller.commands.run("repo.open", "will/flows");
			await until(() => store.collections.cards.get("files-will/flows-/") !== undefined);
			await until(() => store.collections.repoImports.get("will/flows")?.phase === "done");
			await settled();
			const listed = store.collections.cards.get("files-will/flows-/");
			// One read, one card: the retry is armed by the degradation, not by
			// the import finishing.
			expect(listed?.kind === "file-list" && listed.payload.entries.length).toBe(1);
			expect(store.collections.cards.get("files-will/flows-/")?.createdAt).toBe(listed?.createdAt);
		} finally {
			repoImportPolling.delayMs = restore;
		}
	});
});

describe("a frame owns the reads it renders", () => {
	const issueCard = (id: string, repo: string, ordinal: number) =>
		({
			id,
			kind: "issue-list" as const,
			title: `Issues · ${repo}`,
			status: "active" as const,
			createdAt: ordinal,
			ordinal,
			payload: {
				repo,
				filter: "open" as const,
				issues: [
					{
						number: 7,
						title: `Keep ${repo} honest`,
						state: "open" as const,
						author: "will",
						comments: 2,
						updatedAt: "2026-08-19T09:00:00Z",
					},
				],
			},
		});

	test("each active tab shows exactly one list, and switching tabs leaves nothing behind", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, []);
		await controller.commands.run("repo.open", "will/flows");
		store.dispatch({ type: "card.upsert", actor: "system", card: issueCard("issues-will/flows", "will/flows", 1) });
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
				payload: {
					repo: "will/flows",
					landings: [{ number: 8, title: "Show when it changed", state: "open", author: "will", updatedAt: "2026-08-19T10:00:00Z" }],
				},
			},
		});
		await controller.commands.run("repo.tab", "issues");
		await settled();
		const { host } = mount(controller);
		const pane = host.querySelector('[aria-label="GitHub repositories"]');
		expect(pane).not.toBeNull();

		// One issues list in the whole document, and it is inside the pane.
		const issueLists = [...host.querySelectorAll('[data-flow="issues.view"]')];
		expect(issueLists).toHaveLength(1);
		expect(pane?.contains(issueLists[0] as Node)).toBe(true);
		// The pull-request read the pane is not showing has not been left in the
		// transcript either — the frame owns this repository's reads while open.
		expect([...host.querySelectorAll('[data-flow="prs.view"]')]).toHaveLength(0);

		await controller.commands.run("repo.tab", "pulls");
		await settled();
		expect([...host.querySelectorAll('[data-flow="issues.view"]')]).toHaveLength(0);
		const pullRows = [...host.querySelectorAll('[data-flow="prs.view"]')];
		expect(pullRows.length).toBeGreaterThan(0);
		expect(pullRows.every((row) => pane?.contains(row) === true)).toBe(true);
	});

	test("another repository's read is still the transcript's — a frame owns only what it shows", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, []);
		await controller.commands.run("repo.open", "will/flows");
		store.dispatch({ type: "card.upsert", actor: "system", card: issueCard("issues-other", "will/quiet", 1) });
		await controller.commands.run("repo.tab", "issues");
		await settled();
		const { host } = mount(controller);
		const pane = host.querySelector('[aria-label="GitHub repositories"]');
		const lists = [...host.querySelectorAll('[data-flow="issues.view"]')];
		expect(lists).toHaveLength(1);
		// It belongs to a different repository, so it stays where it was read.
		expect(pane?.contains(lists[0] as Node)).toBe(false);
	});

	test("the cards are hidden, never deleted — closing the frame returns them to the transcript", async () => {
		const store = await webStore();
		const controller = controllerWith(store);
		await signedIn(store, []);
		await controller.commands.run("repo.open", "will/flows");
		store.dispatch({ type: "card.upsert", actor: "system", card: issueCard("issues-will/flows", "will/flows", 1) });
		await controller.commands.run("repo.tab", "issues");
		await settled();
		const { host } = mount(controller);
		expect([...host.querySelectorAll('[data-flow="issues.view"]')]).toHaveLength(1);

		await controller.commands.run("chat");
		await settled();
		// The store never lost the read…
		expect(store.collections.cards.get("issues-will/flows")).toBeDefined();
		// …and with the frame closed the transcript renders it again, once.
		expect([...host.querySelectorAll('[data-flow="issues.view"]')]).toHaveLength(1);
		expect(host.querySelector('[aria-label="GitHub repositories"]')).toBeNull();
	});
});
