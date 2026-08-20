/*
 * E11.1–E11.4 — the Connectors surface, and the platform-proxy seams behind it.
 *
 * Which half of E11.1 is provable here, and which is not:
 *
 *   The local repository picker is an Electrobun native RPC. `pickLocalRepository`
 *   resolves through `rpc.proxy.request` and `rpc` is undefined whenever
 *   `window.__electrobun` is (src/mainview/native/NativeBridge.ts). A browser
 *   harness cannot open the OS directory dialog, so the OS dialog, its
 *   cancellation, and its not-a-repository / permission-denied branches belong
 *   to the native lane. Everything on THIS side of that seam is proved here, at
 *   the seam the native shell implements: the suite injects a scripted
 *   `NativeRepositories` into the real AppController and asserts what the
 *   product does with the picker's answer — the access it asks for, the
 *   capabilities it grants, what a downgrade revokes, and how a refusal
 *   surfaces. The browser half then proves the ABSENCE contract: a web build
 *   renders no local-repository row and reaches `connector.add` from nowhere.
 *
 * Checklist drift, recorded rather than papered over: E11.3 says the connected
 * repo card states "branch / head / worldview facts". The shipped card
 * (ConnectorsSurface.tsx) states name, `${branch ?? "Detached"} · <short head>`
 * and an access badge. There is no worldview fact on it. This suite asserts the
 * three facts that ship and prints one line naming the gap, so a human decides
 * whether to add the fact or amend the row. It does not invent the assertion.
 *
 * The platform-proxy families (/api/notifications/, /api/user/byok-keys,
 * /api/github/import) have unit tests that mock `ctx.http`, so nothing before
 * this suite proved that a browser session is admitted, that the Worker mints
 * the USER's Smithers Cloud token rather than a deployment credential, or that
 * the bearer never comes back to the page. Those three are asserted end to end
 * against the real Worker.
 */
import type { PickLocalRepositoryResult, RepositoryAccess } from "smithers-shared/NativeRepository";
import { wait, waitUntil, type Reporter } from "../Assert.ts";
import type { CdpSession } from "../Browser.ts";
import { openClient, type Client } from "../Client.ts";
import { defineSuite } from "../Suite.ts";
import { STUB_CLOUD_TOKEN } from "../../scripts/stub-backends.ts";
// Type-only: NativeBridge.ts reads window.__electrobun at module scope, so it
// cannot be imported for value under bun. Client.ts takes the same care.
import type { NativeRepositories } from "../../src/mainview/native/NativeBridge.ts";

/* ------------------------------------------------------------------ */
/* The two repositories the scripted picker hands back                 */
/* ------------------------------------------------------------------ */

const READ_ROOT = "/Users/e2e/flows";
const READ_NAME = "flows";
const READ_HEAD = "abcdef1234567890";
/** ConnectorsSurface renders `head.slice(0, 8)`. */
const READ_SHORT_HEAD = "abcdef12";
const READ_BRANCH = "main";

const WRITE_ROOT = "/Users/e2e/smithers";
const WRITE_NAME = "smithers";

/** AppStore builds the connector id from the picked root. */
const idFor = (root: string): string => `local-repository:${root}`;

/* ------------------------------------------------------------------ */
/* Product copy this suite asserts against (all from apps/ui/src)      */
/* ------------------------------------------------------------------ */

/** ConnectorsSurface.tsx — the three store rows a web build may render. */
const GITHUB_ROW = "GitHub";
const LOCAL_ROW = "Local repository";
const CLOUD_ROW = "Smithers Cloud repository";
/** ConnectorsSurface.tsx — `Connected ✓ as ${identity?.login ?? "you"}`. */
const CONNECTED_BADGE = "Connected ✓ as will";
const EMPTY_CONNECTORS = "No repositories connected";
/** App.tsx ComposerConnect — the chip label in each of its three states. */
const CHIP_SIGNED_OUT = "Connect";
const CHIP_GITHUB = "GitHub · will";
/** ConnectorsSurface.tsx — the access badge, and the one-click downgrade. */
const READ_ONLY_BADGE = "Read-only";
const READ_WRITE_BADGE = "Read & write";
const DOWNGRADE_LABEL = "Make read-only";
/** ConnectorsSurface.tsx — `${connector.branch ?? "Detached"}` and shortHead(null). */
const DETACHED = "Detached";
const NO_COMMITS = "No commits yet";
/** ConnectorsSurface.tsx ConfirmDialog — the destructive question. */
const REMOVE_TITLE = `Disconnect ${READ_NAME}?`;
const REMOVE_BODY = "Smithers will stop watching this repository. You can reconnect it any time.";
const REMOVE_CONFIRM = "Disconnect";
/** registry.ts flowRequirements — the reason a signed-out platform command carries. */
const SIGN_IN_REASON = "Sign in with GitHub first";
/** apps/server/src/index.ts requireTurnSession — the two refusals the proxy gate states. */
const PROXY_SIGNED_OUT = "Sign in to run a Smithers turn.";
const PROXY_NOT_ALLOWLISTED = "This account is not in the closed-alpha allowlist yet.";

/* ------------------------------------------------------------------ */
/* Platform answers the doubles serve, as the seams parse them         */
/* ------------------------------------------------------------------ */

/** stub-backends freshNotifications — the first row's subject.title. */
const FIRST_NOTIFICATION = "Wire the sync adapter";
/** RepoImportSeam STAGE_DETAIL["cloning_github"]. */
const CLONING_DETAIL = "Downloading from GitHub…";

const IMPORT_REPO = "will/flows";
const WATCHED_REPO = "will/flows";

/* ------------------------------------------------------------------ */
/* The scripted native picker — the seam the native shell implements   */
/* ------------------------------------------------------------------ */

interface ScriptedPicker {
	readonly repositories: NativeRepositories;
	/** Every access the product asked the picker for, in order. */
	readonly asked: () => ReadonlyArray<RepositoryAccess>;
	readonly answer: (result: PickLocalRepositoryResult) => void;
}

const scriptedPicker = (): ScriptedPicker => {
	const asked: Array<RepositoryAccess> = [];
	let next: PickLocalRepositoryResult = { status: "cancelled" };
	return {
		repositories: {
			available: true,
			pickLocalRepository: async (access) => {
				asked.push(access);
				return next;
			},
		},
		asked: () => asked,
		answer: (result) => void (next = result),
	};
};

/* ------------------------------------------------------------------ */
/* Store readers                                                       */
/* ------------------------------------------------------------------ */

const connectors = (client: Client) => [...client.store.collections.connectors.values()];
const connectorNamed = (client: Client, name: string) =>
	connectors(client).find((connector) => connector.name === name);
const operation = (client: Client) =>
	client.store.collections.connectorOperations.get("connector-operation");
const writesOf = (client: Client, name: string): ReadonlyArray<string> =>
	(connectorNamed(client, name)?.capabilities ?? [])
		.filter((capability) => capability.action === "fs:write")
		.map((capability) => capability.resource);
const readsOf = (client: Client, name: string): ReadonlyArray<string> =>
	(connectorNamed(client, name)?.capabilities ?? [])
		.filter((capability) => capability.action === "fs:read")
		.map((capability) => capability.resource);

const cardOfKind = <K extends string>(client: Client, kind: K) =>
	client.cards().find((card) => card.kind === kind);

interface PlatformCall {
	readonly method: string;
	readonly path: string;
	readonly authorization: string;
}

/* ------------------------------------------------------------------ */
/* Page readers                                                        */
/* ------------------------------------------------------------------ */

const json = (value: unknown): string => JSON.stringify(value);

const present = (session: CdpSession, selector: string): Promise<boolean> =>
	session.page.evaluate<boolean>(`document.querySelector(${json(selector)}) !== null`);

/** How many nodes match `selector`. */
const countMatching = (session: CdpSession, selector: string): Promise<number> =>
	session.page.evaluate<number>(`document.querySelectorAll(${json(selector)}).length`);

const textOf = (session: CdpSession, selector: string): Promise<string | null> =>
	session.page.evaluate<string | null>(`document.querySelector(${json(selector)})?.textContent ?? null`);

const attributeOf = (session: CdpSession, selector: string, name: string): Promise<string | null> =>
	session.page.evaluate<string | null>(
		`document.querySelector(${json(selector)})?.getAttribute(${json(name)}) ?? null`,
	);

/**
 * Click the affordance through its own handler, and answer false when nothing
 * matched. A renamed selector must fail the suite rather than quietly prove
 * nothing — that silent pass is the rot this harness exists to end.
 */
const click = (session: CdpSession, selector: string): Promise<boolean> =>
	session.page.evaluate<boolean>(`(() => {
		const target = document.querySelector(${json(selector)});
		if (target === null) return false;
		target.click();
		return true;
	})()`);

interface StoreRow {
	readonly flow: string | null;
	readonly label: string;
	/** True when the row's action is a badge (a stated fact) rather than a button (an act). */
	readonly isBadge: boolean;
}

/** One connector-store row, read the way a person reads it. */
const storeRow = (session: CdpSession, name: string): Promise<StoreRow | null> =>
	session.page.evaluate<StoreRow | null>(`(() => {
		const rows = [...document.querySelectorAll('.connect-store-list .connect-store-row')];
		const row = rows.find((node) => node.querySelector('.connect-store-text strong')?.textContent === ${json(name)});
		if (row === undefined) return null;
		const action = row.querySelector('[data-row-action]');
		return {
			flow: action === null ? null : action.getAttribute('data-flow'),
			label: (action === null ? '' : action.textContent ?? '').trim(),
			isBadge: action !== null && action.classList.contains('sui-badge'),
		};
	})()`);

const storeRowNames = (session: CdpSession): Promise<ReadonlyArray<string>> =>
	session.page.evaluate<ReadonlyArray<string>>(
		`[...document.querySelectorAll('.connect-store-list .connect-store-row .connect-store-text strong')].map((node) => node.textContent ?? '')`,
	);

interface RepositoryCard {
	/** "main · abcdef12" — the branch and short-head line, as rendered. */
	readonly facts: string;
	readonly head: string;
	readonly badges: ReadonlyArray<string>;
	readonly buttons: ReadonlyArray<string>;
}

const repositoryCard = (session: CdpSession, name: string): Promise<RepositoryCard | null> =>
	session.page.evaluate<RepositoryCard | null>(`(() => {
		const cards = [...document.querySelectorAll('.connected-repository-card')];
		const card = cards.find((node) => node.querySelector('.connect-store-text strong')?.textContent === ${json(name)});
		if (card === undefined) return null;
		return {
			facts: (card.querySelector('.repository-path')?.textContent ?? '').trim(),
			head: card.querySelector('.repository-path code')?.textContent ?? '',
			badges: [...card.querySelectorAll('.sui-badge')].map((node) => (node.textContent ?? '').trim()),
			buttons: [...card.querySelectorAll('button')].map((node) =>
				(node.getAttribute('aria-label') ?? node.textContent ?? '').trim(),
			),
		};
	})()`);

/**
 * Wait for the app to mount, re-navigating when it did not.
 *
 * `wrangler dev` reloads itself whenever a sibling session touches
 * apps/server, and a navigation that lands mid-reload sits on Chrome's error
 * page forever. auth-session.e2e.ts carries the same loop for the same reason.
 */
const mount = async (session: CdpSession, report: Reporter, label: string): Promise<void> => {
	let mounted = false;
	for (let attempt = 0; attempt < 6 && !mounted; attempt += 1) {
		if (attempt > 0) await session.page.reload();
		for (let tick = 0; tick < 30 && !mounted; tick += 1) {
			mounted = await present(session, ".app-shell");
			if (!mounted) await wait(200);
		}
	}
	report.check(mounted, `${label}: the app shell never mounted`);
};

/** Open the Connectors pane the way the composer's surfaces menu opens it. */
const openConnectors = async (session: CdpSession, report: Reporter, label: string): Promise<void> => {
	report.check(
		await click(session, ".composer-menu-trigger"),
		`${label}: the composer carries no surfaces-menu trigger (.composer-menu-trigger)`,
	);
	await waitUntil(report, `${label}: the surfaces menu never opened`, () =>
		present(session, '.composer-menu-list .composer-menu-item[data-flow="connect"]'),
	);
	report.check(
		await click(session, '.composer-menu-list .composer-menu-item[data-flow="connect"]'),
		`${label}: the surfaces menu carries no Connectors entry`,
	);
	await waitUntil(report, `${label}: the Connectors pane never rendered`, () =>
		present(session, ".connectors-surface"),
	);
};

/** The entries the composer's repository-connections menu offers, by flow. */
const connectMenuFlows = async (
	session: CdpSession,
	report: Reporter,
	label: string,
): Promise<ReadonlyArray<string>> => {
	report.check(
		await click(session, ".composer-connect-trigger"),
		`${label}: the composer carries no connect chip (.composer-connect-trigger)`,
	);
	await waitUntil(report, `${label}: the connect menu never opened`, () =>
		present(session, ".composer-connect-list"),
	);
	const flows = await session.page.evaluate<ReadonlyArray<string>>(
		`[...document.querySelectorAll('.composer-connect-list .composer-menu-item')].map((node) => node.getAttribute('data-flow') ?? '')`,
	);
	await click(session, ".composer-connect-trigger");
	await waitUntil(report, `${label}: the connect menu never closed`, async () =>
		!(await present(session, ".composer-connect-list")),
	);
	return flows;
};

/**
 * The app persists through OPFS SQLite when it can. Its own capability probe
 * (@tanstack/browser-db-sqlite-persistence `hasOPFSBrowserPrerequisites`) reads
 * `navigator.storage.getDirectory` on the page, so taking that function away
 * makes `openBrowserWASQLiteOPFSDatabase` throw and `resolvePersistenceBackend`
 * (AppStore.ts) fall back to the localStorage backend the seed below writes.
 * Replacing it with a REJECTING function is not enough: the probe only checks
 * the type, and the OPFS worker has its own navigator. Both halves live here so
 * a @tanstack/db envelope change breaks exactly one function.
 */
const FORCE_LOCAL_STORAGE = `(() => {
	if (navigator.storage) {
		Object.defineProperty(navigator.storage, 'getDirectory', { configurable: true, value: undefined });
	}
})()`;

/*
 * Two connected local repositories, written in the shape
 * localStorageCollectionOptions reads: { "s:<key>": { versionKey, data } }
 * under `smithers-mvp.<collection id>`. The rows are exactly
 * LocalRepositoryConnectorSchema; a row that drifts from it is dropped on load,
 * and the assertions below go red rather than green.
 *
 * This is the only way a browser build can hold a connector: creating one needs
 * the native picker, which a page cannot drive.
 */
const SEED_CONNECTORS = `(() => {
	const now = Date.now();
	const rows = {
		's:${idFor(READ_ROOT)}': {
			versionKey: 'e2e-seed-1',
			data: {
				id: '${idFor(READ_ROOT)}',
				kind: 'local-repository',
				status: 'connected',
				access: 'read',
				name: '${READ_NAME}',
				root: '${READ_ROOT}',
				head: '${READ_HEAD}',
				branch: '${READ_BRANCH}',
				remoteUrl: 'https://github.com/will/flows.git',
				capabilities: [{ action: 'fs:read', resource: '${READ_ROOT}/**' }],
				createdAt: now,
				updatedAt: now,
				revision: 0,
			},
		},
		's:${idFor(WRITE_ROOT)}': {
			versionKey: 'e2e-seed-2',
			data: {
				id: '${idFor(WRITE_ROOT)}',
				kind: 'local-repository',
				status: 'connected',
				access: 'read-write',
				name: '${WRITE_NAME}',
				root: '${WRITE_ROOT}',
				head: null,
				branch: null,
				remoteUrl: null,
				capabilities: [
					{ action: 'fs:read', resource: '${WRITE_ROOT}/**' },
					{ action: 'fs:write', resource: '${WRITE_ROOT}/**' },
				],
				createdAt: now,
				updatedAt: now,
				revision: 0,
			},
		},
	};
	localStorage.setItem('smithers-mvp.app-connectors', JSON.stringify(rows));
	/*
	 * Name the store these rows are in. AppStore honours the recorded backend
	 * first and otherwise prefers OPFS, so a seed that writes only the rows is
	 * read whenever OPFS happens to be unavailable and silently ignored
	 * whenever it is not. That is exactly what happened: this suite passed
	 * alone, on a cold profile where OPFS did not open, and failed inside the
	 * seventeen-suite run, where it did — the app was reading an empty OPFS
	 * database while the seeded rows sat unread in localStorage.
	 *
	 * Stamping the backend makes the seed deterministic instead of dependent
	 * on which store the browser happens to offer. The stamp is the product's
	 * own contract (chain/SchemaVersion.ts), not a test-only door.
	 */
	localStorage.setItem('smithers-mvp.persistenceBackend', 'localStorage');
})()`;

/** Park a finished page so its live store cannot write over the next one's seed. */
const park = async (session: CdpSession): Promise<void> => {
	await session.send("Page.navigate", { url: "about:blank" }).catch(() => undefined);
	session.close();
};

export default defineSuite({
	id: "E11",
	title:
		"connectors: sign-in IS the GitHub connector, the local picker is native-only, a connected repo states its facts, removal asks first, and the platform proxy carries the user's own token",
	// Marks the platform double's notifications read, removes its anthropic key
	// and starts an import job, so it runs before the suites that re-read those.
	order: 30,
	run: async ({ origin, stack, report, browser }) => {
		/* ============================================================ */
		/* E11.1 (web half) — what the product does with the picker      */
		/* ============================================================ */

		const picker = scriptedPicker();
		const native = await openClient({ origin, repositories: picker.repositories });
		report.check(
			native.controller.nativeRepositoriesAvailable,
			"the injected repository bridge did not reach the controller, so nothing below tests the real seam",
		);

		picker.answer({
			status: "connected",
			repository: {
				root: READ_ROOT,
				name: READ_NAME,
				head: READ_HEAD,
				branch: READ_BRANCH,
				remoteUrl: "https://github.com/will/flows.git",
			},
		});
		const readOutcome = await native.controller.commands.run("connector.add", "read");
		report.equals(readOutcome.status, "executed", "/connector.add read did not execute");
		report.equals(
			picker.asked()[0],
			"read",
			"the read affordance did not ask the picker for read access — the requested access never left the UI",
		);
		const readConnector = connectorNamed(native, READ_NAME);
		report.check(readConnector !== undefined, "connecting a repository created no connector row");
		report.equals(readConnector?.id, idFor(READ_ROOT), "the connector is not keyed by the picked root");
		report.equals(readConnector?.access, "read", "a read connection was not recorded as read access");
		report.equals(readConnector?.head, READ_HEAD, "the connector did not record the picked repository's head");
		report.equals(readConnector?.branch, READ_BRANCH, "the connector did not record the picked branch");
		report.equals(
			writesOf(native, READ_NAME).length,
			0,
			`a READ-ONLY connection granted write capabilities: ${writesOf(native, READ_NAME).join(", ")}`,
		);
		report.equals(
			readsOf(native, READ_NAME).join(","),
			`${READ_ROOT}/**`,
			"the read capability is not scoped to the picked root",
		);
		report.equals(operation(native)?.phase, "idle", "the connect operation never left its selecting phase");
		report.equals(operation(native)?.error, null, "a successful connection left an error on the operation");
		report.ok(
			"E11.1 a read connection asks the picker for read, records the repository it picked, and grants read-only capabilities scoped to that root.",
		);

		picker.answer({
			status: "connected",
			repository: { root: WRITE_ROOT, name: WRITE_NAME, head: null, branch: null, remoteUrl: null },
		});
		const writeOutcome = await native.controller.commands.run("connector.add", "read-write");
		report.equals(writeOutcome.status, "executed", "/connector.add read-write did not execute");
		report.equals(
			picker.asked()[1],
			"read-write",
			"the read-write affordance asked the picker for the wrong access",
		);
		report.equals(
			connectorNamed(native, WRITE_NAME)?.access,
			"read-write",
			"a read-write connection was not recorded as read-write access",
		);
		report.equals(
			writesOf(native, WRITE_NAME).join(","),
			`${WRITE_ROOT}/**`,
			"a read-write connection did not grant exactly one write capability scoped to its own root",
		);
		report.equals(
			writesOf(native, READ_NAME).length,
			0,
			"connecting a second repository read-write widened the first repository's capabilities",
		);
		report.ok(
			"E11.1 a read-write connection grants a write capability scoped to its own root, and leaves the read-only connector untouched.",
		);

		const downgrade = await native.controller.commands.run("connector.downgrade", idFor(WRITE_ROOT));
		report.equals(downgrade.status, "executed", "/connector.downgrade did not execute");
		report.equals(
			connectorNamed(native, WRITE_NAME)?.access,
			"read",
			"the downgrade did not record read access",
		);
		report.equals(
			writesOf(native, WRITE_NAME).length,
			0,
			"the downgrade relabelled the connector but left its write capability standing",
		);
		report.ok("E11.1 making a connector read-only revokes the write capability, not just the badge.");

		const connectedCount = connectors(native).length;
		picker.answer({ status: "cancelled" });
		const cancelled = await native.controller.commands.run("connector.add", "read");
		report.equals(cancelled.status, "executed", "a cancelled pick was reported as a failure");
		report.equals(connectors(native).length, connectedCount, "a cancelled pick connected a repository anyway");
		report.equals(operation(native)?.phase, "idle", "a cancelled pick left the operation mid-selection");
		report.equals(operation(native)?.error, null, "a cancelled pick was recorded as an error");
		report.ok("E11.1 cancelling the picker connects nothing and states nothing as an error.");

		const REFUSAL = "e2e: the folder is not readable";
		picker.answer({ status: "error", code: "permission-denied", message: REFUSAL });
		const refused = await native.controller.commands.run("connector.add", "read");
		report.equals(refused.status, "executed", "a refused pick threw instead of settling");
		report.equals(connectors(native).length, connectedCount, "a refused pick connected a repository anyway");
		report.equals(operation(native)?.phase, "idle", "a refused pick left the operation mid-selection");
		report.equals(
			operation(native)?.error,
			REFUSAL,
			"the picker's refusal was swallowed instead of being stated on the connector surface",
		);
		report.ok("E11.1 a picker refusal reaches the connector surface verbatim, and connects nothing.");

		const removed = await native.controller.commands.run("connector.remove", idFor(READ_ROOT));
		report.equals(removed.status, "executed", "/connector.remove did not execute");
		report.equals(connectorNamed(native, READ_NAME), undefined, "removing the connector left it connected");
		report.check(
			connectorNamed(native, WRITE_NAME) !== undefined,
			"removing one connector removed the other one too",
		);
		report.ok("E11.1 removing a connector removes the one named and leaves the rest connected.");

		/* ============================================================ */
		/* E11.4 — sign-in IS the GitHub connector                       */
		/* ============================================================ */

		// A local repository is a connection; it is not a GitHub session.
		await native.controller.loadSession();
		report.equals(
			native.store.collections.identitySessions.get("identity")?.state,
			"signed-out",
			"holding a local repository was mistaken for a GitHub session",
		);
		report.check(
			native.controller.commands.state().hasConnectors,
			"a connected local repository did not count as a connection",
		);
		report.ok("E11.4 a local repository connects work without claiming a GitHub session.");

		const signedOut = await openClient({ origin });
		await signedOut.controller.loadSession();
		report.equals(
			signedOut.store.collections.identitySessions.get("identity")?.state,
			"signed-out",
			"the signed-out client did not record a signed-out session",
		);
		report.equals(connectors(signedOut).length, 0, "a fresh client invented a connector");
		report.check(
			!signedOut.controller.commands.state().hasConnectors,
			"a signed-out client with no repositories claimed something was connected",
		);
		report.ok("E11.4 signed out with no repositories, nothing is claimed as connected.");

		/* ------------------------------------------------------------ */
		/* The proxy gate, asserted before this run allowlists anybody   */
		/* ------------------------------------------------------------ */

		const platformCalls = async (): Promise<ReadonlyArray<PlatformCall>> => {
			const answer = await stack.control("gateway", "/stub/platform-calls");
			const body = (await answer.json()) as { calls?: ReadonlyArray<PlatformCall> };
			return body.calls ?? [];
		};

		const beforeGate = (await platformCalls()).length;
		const anonymous = await fetch(`${origin}/api/notifications/list`);
		report.equals(anonymous.status, 401, "the platform proxy answered a request carrying no session");
		report.includes(
			await anonymous.text(),
			PROXY_SIGNED_OUT,
			"the proxy's signed-out refusal does not name the one available step",
		);

		// A session the allowlist has not admitted is refused at the same gate.
		const unlisted = await stack.signIn();
		const notAllowlisted = await fetch(`${origin}/api/notifications/list`, { headers: { cookie: unlisted } });
		report.equals(notAllowlisted.status, 403, "the platform proxy admitted an account outside the allowlist");
		report.includes(
			await notAllowlisted.text(),
			PROXY_NOT_ALLOWLISTED,
			"the proxy's allowlist refusal does not state why the account is refused",
		);
		report.equals(
			(await platformCalls()).length,
			beforeGate,
			"a refused request still reached Smithers Cloud, so the gate is not in front of the proxy",
		);
		report.ok(
			"the platform proxy admits only an allowlisted browser session, and a refused request never reaches Smithers Cloud.",
		);

		/* ------------------------------------------------------------ */
		/* Signed in: the connection truth, and the watched set          */
		/* ------------------------------------------------------------ */

		const cookie = await stack.signedInCookie();
		const client = await openClient({ origin, cookie });
		await client.controller.loadSession();
		report.equals(
			client.store.collections.identitySessions.get("identity")?.state,
			"signed-in",
			"the allowlisted cookie did not resolve to a signed-in session",
		);
		report.equals(connectors(client).length, 0, "signing in fabricated a local-repository connector row");
		report.check(
			client.controller.commands.state().hasConnectors,
			"a signed-in session was not treated as a connection, so sign-in is not the GitHub connector",
		);
		report.ok(
			"E11.4 a valid session IS the connection: work counts as connected with no local-connector row behind it.",
		);

		await client.controller.openRepoChooser();
		await client.settle(
			"the repository chooser never opened",
			() => client.cards().some((card) => card.kind === "repo-chooser"),
		);
		client.controller.toggleWatchedRepo(WATCHED_REPO);
		const confirmed = await client.controller.confirmWatchedRepos();
		report.equals(confirmed, undefined, `confirming the watched selection failed: ${String(confirmed)}`);
		report.equals(
			(client.store.collections.watchedRepos.get("watched")?.selected ?? []).join(","),
			WATCHED_REPO,
			"the watched set does not hold the repository that was chosen",
		);
		report.equals(
			connectors(client).length,
			0,
			"choosing a watched GitHub repository wrote a local-connector row, so connection truth is being kept in two places",
		);
		report.ok(
			"E11.4 the watched set is where a GitHub connection lives; it never writes into the local-connector store.",
		);

		/* ============================================================ */
		/* The platform-proxy seams                                      */
		/* ============================================================ */

		// Signed out, the registry refuses before any request is made: the cheap,
		// honest answer, and no 401 round trip.
		const refusedList = await signedOut.controller.commands.runAsAgent("notifications.list");
		report.equals(refusedList.status, "failed", "/notifications.list ran while signed out");
		report.includes(
			refusedList.status === "failed" ? refusedList.error : "",
			SIGN_IN_REASON,
			"the signed-out refusal does not name sign-in as the step",
		);
		report.equals(
			signedOut.countCalls("GET", "/api/notifications/list"),
			0,
			"a signed-out notifications command still called the platform",
		);
		report.check(
			cardOfKind(signedOut, "notifications") === undefined,
			"a signed-out notifications command surfaced a card anyway",
		);
		report.ok("signed out, a platform command answers with the sign-in step and never calls the platform.");

		const listed = await client.controller.commands.run("notifications.list");
		report.equals(listed.status, "executed", `/notifications.list failed: ${JSON.stringify(listed)}`);
		const notifications = cardOfKind(client, "notifications");
		report.check(notifications !== undefined, "/notifications.list surfaced no notifications card");
		if (notifications?.kind === "notifications") {
			report.equals(notifications.payload.items.length, 3, "the card did not state the platform's three rows");
			report.equals(
				notifications.payload.items[0]?.title,
				FIRST_NOTIFICATION,
				"the card did not state the platform's first row",
			);
			report.equals(
				notifications.payload.items[0]?.repo,
				"will/flows",
				"the card dropped the repository the platform named",
			);
			report.equals(
				notifications.payload.items[0]?.reason,
				"review_requested",
				"the card dropped the reason the platform gave",
			);
			report.equals(notifications.payload.items[0]?.read, false, "an unread row was rendered as read");
			report.equals(notifications.payload.items[2]?.read, true, "a read row was rendered as unread");
			report.equals(notifications.payload.unread, 2, "the card miscounted the unread rows");
		}
		report.ok("the notifications card states the platform's own rows, read state and unread count.");

		const marked = await client.controller.commands.run("notifications.read");
		report.equals(marked.status, "executed", `/notifications.read failed: ${JSON.stringify(marked)}`);
		const remarked = cardOfKind(client, "notifications");
		if (remarked?.kind === "notifications") {
			report.equals(remarked.payload.unread, 0, "marking everything read left unread rows on the card");
			report.check(
				remarked.payload.items.every((item) => item.read),
				"marking everything read left a row unread",
			);
		}
		report.equals(
			client.countCalls("GET", "/api/notifications/list"),
			2,
			"marking read did not re-list, so the card states an assumption rather than the platform's answer",
		);
		report.ok(
			"mark-all-read round-trips through the proxy — the platform's 205 counts as success, and the card re-states the platform's new truth.",
		);

		/*
		 * BYOK keys are a family the Worker now refuses at its own boundary
		 * (PLATFORM_UNIMPLEMENTED): Smithers Cloud has no key store, and the
		 * old forward handed the browser the Go router's plain-text 404. The
		 * contract to pin is the honest 501 sentence, and that the platform is
		 * never bothered with a call the Worker knows cannot succeed.
		 */
		const KEYS_REFUSAL = "Bring-your-own provider keys aren't part of this preview.";
		const keysListed = await client.controller.commands.run("keys.list");
		report.equals(keysListed.status, "failed", "keys.list forwarded to a platform route that does not exist");
		report.check(
			keysListed.status === "failed" && keysListed.error.startsWith(KEYS_REFUSAL),
			`keys.list did not answer the honest preview refusal (saw ${JSON.stringify(keysListed)})`,
		);
		const keyRemoved = await client.controller.commands.run("keys.remove", "anthropic");
		report.equals(keyRemoved.status, "failed", "keys.remove forwarded to a platform route that does not exist");
		report.check(
			keyRemoved.status === "failed" && keyRemoved.error.startsWith(KEYS_REFUSAL),
			`keys.remove did not answer the honest preview refusal (saw ${JSON.stringify(keyRemoved)})`,
		);
		report.ok("the BYOK key family answers the honest preview refusal instead of a forwarded router 404.");

		const imported = await client.controller.commands.run("repos.import", IMPORT_REPO);
		report.equals(imported.status, "executed", `/repos.import failed: ${JSON.stringify(imported)}`);
		const started = cardOfKind(client, "repo-import");
		report.check(started !== undefined, "/repos.import surfaced no import card");
		report.equals(started?.title, `Import · ${IMPORT_REPO}`, "the import card does not name the repository");
		if (started?.kind === "repo-import") {
			report.equals(started.payload.phase, "running", "the import card did not start tracking the job");
			report.equals(
				started.payload.detail,
				CLONING_DETAIL,
				"the import card does not state the stage the platform reported",
			);
			report.check(started.payload.jobId !== null, "the import card tracks no job id");
		}
		await stack.control("gateway", "/stub/import-ready", { method: "POST" });
		await client.settle(
			"the import card never reached a terminal state after the platform reported the mirror ready",
			() => {
				const card = cardOfKind(client, "repo-import");
				return card?.kind === "repo-import" && card.payload.phase === "done";
			},
			25_000,
		);
		report.equals(
			cardOfKind(client, "repo-import")?.status,
			"acted",
			"a finished import left its card in a non-terminal status",
		);
		report.ok("an import starts through the proxy, polls the job, and settles the card on the platform's answer.");

		/* ------------------------------------------------------------ */
		/* Whose credential the proxy carries, and what comes back       */
		/* ------------------------------------------------------------ */

		const calls = await platformCalls();
		const paths = calls.map((call) => `${call.method} ${call.path}`);
		for (const wanted of [
			"GET /api/notifications/list",
			"PUT /api/notifications/mark-read",
			"POST /api/github/import",
		]) {
			report.check(
				paths.some((seen) => seen.startsWith(wanted)),
				`the platform never saw ${wanted} (saw ${paths.join(" | ")})`,
			);
		}
		report.check(
			paths.some((seen) => seen.startsWith("GET /api/github/import/job-")),
			`the import job was never polled through the proxy (saw ${paths.join(" | ")})`,
		);
		report.check(
			!paths.some((seen) => seen.includes("/api/user/byok-keys")),
			`the Worker forwarded a BYOK call it knows the platform cannot serve (saw ${paths.join(" | ")})`,
		);
		const wrongCredential = calls.filter((call) => call.authorization !== `Bearer ${STUB_CLOUD_TOKEN}`);
		report.equals(
			wrongCredential.length,
			0,
			`${wrongCredential.length} proxied call(s) carried something other than the user's own Smithers Cloud token: ${wrongCredential
				.map((call) => `${call.method} ${call.path} → ${call.authorization || "(none)"}`)
				.join(" | ")}`,
		);
		const minted = stack.fronts.identity
			.requests()
			.filter((entry) => entry.path === "/api/identity/cloud-token");
		report.check(minted.length > 0, "the Worker never minted a Smithers Cloud token from the identity seam");
		report.check(
			minted.every((entry) => entry.body.includes('"login":"will"')),
			"the Worker minted a token for something other than the signed-in login",
		);
		report.ok(
			"every proxied call carried the token the identity seam minted for the signed-in login, never a deployment credential.",
		);

		const proxied = await fetch(`${origin}/api/notifications/list`, { headers: { cookie } });
		report.equals(proxied.status, 200, "the proxied read did not answer 200 for a signed-in session");
		for (const header of ["authorization", "set-cookie", "x-smithers-service-token"]) {
			report.equals(
				proxied.headers.get(header),
				null,
				`the proxy handed the browser back the upstream ${header} header`,
			);
		}
		report.includes(
			proxied.headers.get("content-type") ?? "",
			"application/json",
			"the proxy dropped the upstream content type",
		);
		await proxied.body?.cancel();
		report.ok("the proxy passes back status and content type only, so the bearer never reaches the page.");

		/* ============================================================ */
		/* The rendered surface                                          */
		/* ============================================================ */

		if (!browser.available) {
			console.log(`skip: E11 rendered surface — ${browser.reason ?? "no system browser"}`);
			console.log(
				"note: E11.3 — the checklist row names a worldview fact; the shipped card states branch, head and access only.",
			);
			return;
		}

		/* ---- signed out: the GitHub connector IS sign-in ---- */

		const out = await browser.open();
		try {
			await mount(out, report, "signed out");
			await openConnectors(out, report, "signed out");

			const githubOut = await storeRow(out, GITHUB_ROW);
			report.check(githubOut !== null, "the Connectors surface lists no GitHub connector row");
			report.equals(
				githubOut?.flow,
				"auth.sign-in",
				"signed out, the GitHub connector's action is not the sign-in command, so connecting is a second act",
			);
			report.equals(githubOut?.isBadge, false, "signed out, the GitHub row already states a connection");
			report.equals(
				await textOf(out, ".connector-empty strong"),
				EMPTY_CONNECTORS,
				"signed out, the surface does not state that no repositories are connected",
			);
			report.equals(
				await textOf(out, ".composer-connect-trigger .composer-connect-label"),
				CHIP_SIGNED_OUT,
				"signed out, the composer chip does not read Connect",
			);
			report.equals(
				await attributeOf(out, ".composer-connect-trigger", "data-connected"),
				"false",
				"signed out, the composer chip claims a connection",
			);
			report.ok("E11.4 signed out, the GitHub connector IS the sign-in command and nothing claims to be connected.");

			/* ---- the local picker is native-only, and the web build says so ---- */

			const namesOut = await storeRowNames(out);
			report.check(
				!namesOut.includes(LOCAL_ROW),
				`a browser build rendered the "${LOCAL_ROW}" row, which only the native picker can serve (rows: ${namesOut.join(", ")})`,
			);
			/*
			 * Will, 2026-08-19: "import to smithers cloud button exists and it
			 * shouldn't. importing to smithers cloud just happens in background —
			 * it's an implementation detail. the user feels like they are on
			 * github." The capability stays registered and the panes start it in
			 * the background; what must not exist is a row that asks the human
			 * for it.
			 */
			report.check(
				!namesOut.includes(CLOUD_ROW),
				`the connect store still offers the "${CLOUD_ROW}" row; importing is background work now (rows: ${namesOut.join(", ")})`,
			);
			report.equals(
				await countMatching(out, '[data-flow="repos.import"]'),
				0,
				"a visible affordance still asks the human to import a repository",
			);
			report.equals(
				await countMatching(out, '[data-flow="connector.add"]'),
				0,
				"connector.add is reachable from a visible affordance in a browser build, where the picker cannot run",
			);
			const menuOut = await connectMenuFlows(out, report, "signed out");
			report.check(
				!menuOut.includes("connector.add"),
				`the composer's connect menu offers Add local repository in a browser build (${menuOut.join(", ")})`,
			);
			report.check(
				menuOut.includes("auth.sign-in"),
				`signed out, the connect menu does not offer GitHub sign-in (${menuOut.join(", ")})`,
			);
			report.ok(
				"E11.1 a browser build renders no local-repository row and reaches connector.add from nowhere; the picker is native-only.",
			);
		} finally {
			await park(out);
		}

		/* ---- signed in, no local repositories ---- */

		const signedIn = await browser.open(cookie);
		try {
			await mount(signedIn, report, "signed in");
			await openConnectors(signedIn, report, "signed in");
			await waitUntil(report, "the signed-in session never reached the Connectors surface", async () =>
				(await storeRow(signedIn, GITHUB_ROW))?.isBadge === true,
			);

			const githubIn = await storeRow(signedIn, GITHUB_ROW);
			report.equals(
				githubIn?.flow,
				null,
				"signed in, the GitHub row still offers a Connect button, so connection is a second act after sign-in",
			);
			report.equals(
				githubIn?.label,
				CONNECTED_BADGE,
				"signed in, the GitHub row does not derive its connected state from the session",
			);
			report.equals(
				await textOf(signedIn, ".composer-connect-trigger .composer-connect-label"),
				CHIP_GITHUB,
				"signed in with no local repositories, the composer chip does not name the GitHub identity",
			);
			report.equals(
				await attributeOf(signedIn, ".composer-connect-trigger", "data-connected"),
				"true",
				"the composer chip does not derive its connected state from the same session answer",
			);
			const menuIn = await connectMenuFlows(signedIn, report, "signed in");
			report.check(
				menuIn.includes("repos.watch"),
				`signed in, the connect menu does not offer the GitHub repository chooser (${menuIn.join(", ")})`,
			);
			report.check(
				!menuIn.includes("auth.sign-in"),
				`signed in, the connect menu still offers sign-in (${menuIn.join(", ")})`,
			);
			report.ok(
				"E11.4 signed in, the GitHub row states the session's own answer and the chip names the identity; there is no second connect step.",
			);
		} finally {
			await park(signedIn);
		}

		/* ---- a connected repository: its facts, and its removal ---- */

		const seeded = await browser.open(cookie);
		try {
			await seeded.send("Page.addScriptToEvaluateOnNewDocument", { source: FORCE_LOCAL_STORAGE });
			await seeded.send("Page.addScriptToEvaluateOnNewDocument", { source: SEED_CONNECTORS });
			await seeded.page.reload();
			await mount(seeded, report, "seeded");
			await openConnectors(seeded, report, "seeded");
			await waitUntil(
				report,
				"the connected repositories never rendered — the persisted connector rows did not load",
				async () => (await repositoryCard(seeded, READ_NAME)) !== null,
				20_000,
			);

			/* E11.3 — the facts the card states. */
			const readOnly = await repositoryCard(seeded, READ_NAME);
			report.equals(readOnly?.head, READ_SHORT_HEAD, "the card does not state the short head (first 8 characters)");
			report.check(
				(readOnly?.facts ?? "").startsWith(`${READ_BRANCH} ·`),
				`the card does not lead with the branch (saw ${JSON.stringify(readOnly?.facts)})`,
			);
			report.check(
				(readOnly?.badges ?? []).includes(READ_ONLY_BADGE),
				`a read connector does not state ${READ_ONLY_BADGE} (badges: ${(readOnly?.badges ?? []).join(", ")})`,
			);
			report.check(
				!(readOnly?.buttons ?? []).includes(DOWNGRADE_LABEL),
				"a read-only connector offers a downgrade it has nothing to downgrade",
			);
			report.check(
				(readOnly?.buttons ?? []).includes(`Remove ${READ_NAME}`),
				`the card carries no labelled remove affordance (buttons: ${(readOnly?.buttons ?? []).join(", ")})`,
			);

			const readWrite = await repositoryCard(seeded, WRITE_NAME);
			report.check(readWrite !== null, "the read-write repository rendered no card of its own");
			report.check(
				(readWrite?.badges ?? []).includes(READ_WRITE_BADGE),
				`a read-write connector does not state ${READ_WRITE_BADGE} (badges: ${(readWrite?.badges ?? []).join(", ")})`,
			);
			report.equals(readWrite?.head, NO_COMMITS, "a repository with no head does not say so plainly");
			report.check(
				(readWrite?.facts ?? "").startsWith(`${DETACHED} ·`),
				`a repository with no branch does not read ${DETACHED} (saw ${JSON.stringify(readWrite?.facts)})`,
			);
			report.check(
				(readWrite?.buttons ?? []).includes(DOWNGRADE_LABEL),
				`a read-write connector offers no one-click downgrade (buttons: ${(readWrite?.buttons ?? []).join(", ")})`,
			);
			report.ok(
				"E11.3 a connected repository states its branch, its short head — Detached and No commits yet when it has neither — and its access, with the downgrade offered only where there is write access to drop.",
			);

			/* E11.2 — removal is a question first. */
			report.check(
				!(await present(seeded, '[data-slot="dialog-content"]')),
				"a dialog was already mounted before removal was asked for",
			);
			report.check(
				await click(seeded, `.connected-repository-card button[aria-label="Remove ${READ_NAME}"]`),
				"the connected repository carries no remove affordance",
			);
			await waitUntil(report, "the remove affordance opened no confirm dialog", () =>
				present(seeded, '[data-slot="dialog-content"]'),
			);
			report.equals(
				await textOf(seeded, '[data-slot="dialog-title"]'),
				REMOVE_TITLE,
				"the removal dialog does not name the repository it is about to disconnect",
			);
			report.equals(
				await textOf(seeded, '[data-slot="dialog-description"]'),
				REMOVE_BODY,
				"the removal dialog does not state the consequence and that it is reversible",
			);
			report.equals(
				await textOf(seeded, '[data-slot="dialog-footer"] .sui-button-destructive'),
				REMOVE_CONFIRM,
				"the removal confirm is not the destructive-styled action",
			);
			report.check(
				(await repositoryCard(seeded, READ_NAME)) !== null,
				"opening the question already disconnected the repository",
			);

			report.check(
				await click(seeded, '[data-slot="dialog-footer"] button:not(.sui-button-destructive)'),
				"the removal dialog carries no way out that is not the destructive act",
			);
			await waitUntil(report, "cancelling never closed the removal dialog", async () =>
				!(await present(seeded, '[data-slot="dialog-content"]')),
			);
			report.check(
				(await repositoryCard(seeded, READ_NAME)) !== null,
				"cancelling the removal disconnected the repository anyway",
			);
			report.ok(
				"E11.2 removing a repository asks a destructive, repository-naming question first, and cancelling leaves it connected.",
			);

			report.check(
				await click(seeded, `.connected-repository-card button[aria-label="Remove ${READ_NAME}"]`),
				"the remove affordance stopped working after a cancel",
			);
			await waitUntil(report, "the remove affordance opened no confirm dialog the second time", () =>
				present(seeded, '[data-slot="dialog-content"]'),
			);
			report.check(
				await click(seeded, '[data-slot="dialog-footer"] .sui-button-destructive'),
				"the removal dialog carries no destructive confirm",
			);
			await waitUntil(report, "confirming never closed the removal dialog", async () =>
				!(await present(seeded, '[data-slot="dialog-content"]')),
			);
			await waitUntil(report, "confirming the removal did not disconnect the repository", async () =>
				(await repositoryCard(seeded, READ_NAME)) === null,
			);
			report.check(
				(await repositoryCard(seeded, WRITE_NAME)) !== null,
				"confirming the removal disconnected a repository it never named",
			);
			await waitUntil(
				report,
				"the composer chip did not re-derive from the connectors that remain",
				async () =>
					(await textOf(seeded, ".composer-connect-trigger .composer-connect-label")) === WRITE_NAME,
			);
			report.ok(
				"E11.2 only the destructive confirm disconnects, it disconnects only the repository it named, and the composer chip re-derives from what is left.",
			);

			const errors = seeded.consoleErrors();
			report.check(
				errors.length === 0,
				`the connectors round trip logged ${errors.length} console error(s): ${errors.slice(0, 3).join(" | ")}`,
			);
			report.ok("the whole connectors round trip ran without a console error.");
		} finally {
			await park(seeded);
		}

		console.log(
			"note: E11.3 — the checklist row names a worldview fact; the shipped card states branch, head and access only. Add the fact or amend the row.",
		);
	},
});
