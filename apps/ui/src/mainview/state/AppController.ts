import { parseWikilinks, restoreWikilinks } from "@smthrs/ui/vault";
import type { RepositoryAccess } from "smithers-shared/NativeRepository";
import type { AgentChatMessage, AgentTurnFrame, FetchLike } from "smithers-shared/NativeAgent";
import {
	ADMIN_ALLOWLIST_PATH,
	ADMIN_FEEDBACK_PATH,
	ADMIN_GRANT_PATH,
	ADMIN_HEALTH_PATH,
	ADMIN_REQUESTS_PATH,
	AUTH_LOGOUT_PATH,
	AUTH_SCOPES_PATH,
	AUTH_NATIVE_CLAIM_PATH,
	AUTH_NATIVE_START_PATH,
	AUTH_SESSION_PATH,
	AUTH_SIGN_IN_PATH,
	APPROVAL_DECISION_PATH,
	BILLING_BALANCE_PATH,
	IDENTITY_REQUEST_ACCESS_PATH,
	RECO_FEEDBACK_PATH,
	RECO_FIRST_RUN_PATH,
	RECO_REPOS_PATH,
	RECO_WATCHED_PATH,
	TOOLS_BROWSER_FETCH_PATH,
	TURN_PATH,
	WORKFLOW_EVENTS_PATH,
	WORKFLOW_PROVISION_PATH,
	WORKFLOW_RPC_PATH,
	WORKFLOW_STREAM_PATH,
} from "smithers-shared/AgentApiRoutes";
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge";
import { createCommandRegistry } from "../flows/Commands";
import type { CommandOutcome, CommandRegistry } from "../flows/Commands";
import type { SlashItem } from "../flows/registry";
import type { CatalogItem } from "../flows/Commands";
import { flowRequirements, parseSubmit } from "../flows/registry";
import { createAppStatusSeam } from "./seams/AppStatusSeam";
import type { AppStatusSeam } from "./seams/AppStatusSeam";
import { createBillingSeam } from "./seams/BillingSeam";
import type { BillingSeam } from "./seams/BillingSeam";
import { createBookmarksSeam } from "./seams/BookmarksSeam";
import type { BookmarksSeam } from "./seams/BookmarksSeam";
import { createFilesSeam } from "./seams/FilesSeam";
import type { FilesSeam } from "./seams/FilesSeam";
import { createEnvironmentSeam } from "./seams/EnvironmentSeam";
import type { EnvironmentSeam } from "./seams/EnvironmentSeam";
import { createIssuesSeam } from "./seams/IssuesSeam";
import type { IssuesSeam } from "./seams/IssuesSeam";
import { createKeysSeam } from "./seams/KeysSeam";
import type { KeysSeam } from "./seams/KeysSeam";
import { createLandingsSeam } from "./seams/LandingsSeam";
import type { LandingsSeam } from "./seams/LandingsSeam";
import { createNotificationsSeam } from "./seams/NotificationsSeam";
import type { NotificationsSeam } from "./seams/NotificationsSeam";
import { resolveTargetRepo } from "./RepoContext";
import { createRepoCatalogSeam, parseRepoCandidates } from "./seams/RepoCatalogSeam";
import type { RepoCandidate } from "./seams/RepoCatalogSeam";
import { createRepoImportSeam } from "./seams/RepoImportSeam";
import type { RepoImportSeam } from "./seams/RepoImportSeam";
import type { SeamContext } from "./seams/SeamContext";
import {
	impossibleAskOf,
	renderedAskTurnText,
	renderedRunTurnText,
	RUN_LAUNCH_COMMANDS,
	runLaunchCommandOf,
	toolResultLaunchedRun,
} from "./RunClaims";
import { actDetail, actDetailField } from "./MessageScrub";
import type { ImpossibleAskClass } from "./Instructions";
import { smithersInstructions } from "./Instructions";
import { agentVisibleCatalog } from "../flows/agentTools";
import { CardPatchSchema, CardSchema, DEFAULT_PALETTE, isPalette, MAX_AGENT_SUGGESTIONS, PALETTES, WORLD_DISPLAY_NAME } from "./AppState";
import type { Palette } from "./AppState";
import type { AgentSuggestion, Card, RecoDigestPayload, RecoRecommendationPayload, Session, WorldDocument } from "./AppState";
import type { AppStore } from "./AppStore";
import { REPO_CHOOSER_CARD_ID, THEME_PICKER_CARD_ID } from "./AppStore";
import { AGENT_RUNTIME_CONTEXT_VERSION } from "smithers-shared/AgentContext";
import type { AgentRuntimeContext } from "smithers-shared/AgentContext";
import { foldLineages } from "../chain/DebugFolds";

/**
 * The client-side tool-loop leg cap, mirroring the chat worker's
 * CHAT_MAX_TOOL_LEGS default (8): over it the turn ends honestly instead of
 * looping forever on a model that keeps calling tools.
 */
const MAX_TOOL_LEGS = 8;

/**
 * The chain's own doors (DESIGN.md §14): calls that ARE the surface — the
 * author seat and the transcript doors — rather than acts on the app, so
 * they never render an act row of their own.
 */
/*
 * Why the chain turned back, in plain words. The visible line stays
 * in-character ("Smithers adjusted its approach"); these are what the row
 * opens up to, so a human can see the reason without reading the journal.
 */
const GATE_REASONS: Readonly<Record<string, string>> = {
	shape: "the step it wrote did not fit the shape the app accepts",
	fuel: "the step would have cost more than the turn had left",
	catalog: "it reached for something this app does not have",
	denied: "the act needed a permission it does not have",
	call_failed: "the act it tried came back as a failure",
	script_failed: "the step it wrote could not run",
};

/** The agent's structured follow-up channel (will, 2026-08-19) — a proposal, not an act. */
const SUGGESTIONS_FLOW = "suggestions.propose";

const CHAIN_SURFACE_CALLS = new Set(["author", "say", "card.show", "card.update", SUGGESTIONS_FLOW]);

/**
 * Launch Checklist D-4's exhausted-balance refusal, shared between the
 * `zeroBalanceGuard` that dispatches it as a transcript message and
 * `surfaceCommandFailure`, which recognizes it to skip its toast (the
 * refusal is already an embedded chat message; a toast would double-surface
 * it). Names the upgrade path per the definition of done: "how to proceed".
 */
const ZERO_BALANCE_EXHAUSTED_TEXT =
	"Balance is at $0 — workflow runs pause until more balance is added. Run /billing.upgrade to add balance; chat stays free in the meantime.";

export interface AppController {
	readonly store: AppStore;
	readonly nativeAgentAvailable: boolean;
	readonly nativeRepositoriesAvailable: boolean;
	/** The command registry: every interactive affordance routes through it. */
	readonly commands: CommandRegistry;
	readonly slashItems: (needle: string) => Array<SlashItem<CatalogItem>>;
	readonly changeDraft: (draft: string) => void;
	readonly reset: () => void;
	readonly stop: () => void;
	readonly send: (text: string) => void;
	readonly showChat: () => void;
	readonly showWorld: () => void;
	readonly showConnectors: () => void;
	readonly showGithub: () => void;
	readonly showFiles: (repo?: string) => void;
	readonly openRepository: (repo: string) => void;
	readonly selectRepositoryTab: (tab: Session["repositoryTab"]) => void;
	readonly runCommand: (name: string) => boolean;
	readonly runCommandArgs: (name: string, args: string) => boolean;
	readonly connectLocalRepository: (access: RepositoryAccess) => Promise<void>;
	readonly makeConnectorReadOnly: (id: string) => void;
	readonly removeConnector: (id: string) => void;
	readonly selectWorldDocument: (id: string) => string | void;
	readonly changeWorldDocument: (id: string, body: string) => void;
	readonly createWorldDocument: () => void;
	/** Ask whether to delete a note; the answer is `world.delete.confirm|cancel`. */
	readonly removeWorldDocument: (id: string) => string | void;
	readonly confirmWorldDelete: () => string | void;
	readonly cancelWorldDelete: () => void;
	readonly decideApproval: (id: string, decision: "approved" | "denied") => void;
	readonly retryLastTurn: () => void;
	readonly toggleTheme: () => void;
	/** Wear a color theme (/theme) — the axis orthogonal to light/dark. */
	readonly setPalette: (args: string) => string | void;
	/* Wave 10 — the onboarding chooser (repos.watch) and the watched set. */
	readonly openRepoChooser: (preselect?: string) => Promise<string | void>;
	readonly toggleWatchedRepo: (fullName: string) => string | void;
	readonly selectAllWatchedRepos: () => void;
	readonly selectNoWatchedRepos: () => void;
	readonly confirmWatchedRepos: () => Promise<string | void>;
	/* /clear (§2h): sweep the transcript into world notes, THEN clear. */
	readonly clearConversation: () => Promise<string | void>;
	/* The browser tool + surface (§2d/§2d′). */
	readonly openBrowser: (url: string) => Promise<string | void | { readonly value: string }>;
	/*
	 * Wave 11 — workflows in the conversation. Create/list/run through the
	 * per-user gateway seam; runs render as embedded run cards tracked live.
	 */
	readonly createWorkflow: (
		description: string,
		repo?: string,
	) => Promise<string | void | { readonly value: string }>;
	readonly listWorkspaceWorkflows: (repo?: string) => Promise<string | void | { readonly value: string }>;
	readonly runWorkflow: (name: string, repo?: string) => Promise<string | void | { readonly value: string }>;
	/* Wave 12 §2 — the answer to "which watched repository?" (one act). */
	readonly chooseWorkflowRepo: (fullName: string) => Promise<string | void | { readonly value: string }>;
	/* Wave 12 §3 — the two acts a run that has gone quiet offers. */
	readonly stopWatchingRun: (cardId: string) => string | void;
	readonly retryRunWatch: (cardId: string) => string | void;
	/** Boot reconciliation: resume the event pump for any run card still live. */
	readonly resumeWorkflowRuns: () => void;
	/* Card maximize/minimize — the user's presentation transition (§2d′). */
	readonly maximizeCard: (id: string) => string | void;
	readonly minimizeCard: () => void;
	/** Open or close one act row's detail in place (will, 2026-08-19). */
	readonly toggleActDetail: (id: string) => string | void;
	/* The admin dev-tools panel + debug reads (§2b/§2d; admin registry only). */
	readonly toggleDevtools: () => void;
	/** Flip which backend drives a turn (admin /debug.backend; DESIGN.md §14). */
	readonly setAgentBackend: (backend: string) => string | { readonly value: string };
	/* The composer surfaces menu — the /surfaces command's open state. */
	readonly toggleSurfacesMenu: () => void;
	/*
	 * The composer connect menu's open state. Not a command — the chip is a
	 * pointer affordance, not a registry entry — but the state is still the
	 * store's, reached through the dispatcher with the actor recorded.
	 */
	readonly toggleConnectMenu: () => void;
	readonly closeConnectMenu: () => void;
	readonly debugSnapshot: () => { readonly value: string };
	readonly debugEvents: () => { readonly value: string };
	readonly debugSeams: () => Promise<string | void | { readonly value: string }>;
	/** The chain x-ray (DESIGN.md §14 debug mode): the journal fold, as data. */
	readonly debugChain: () => { readonly value: string };
	/** The wire tap: the controller's fetch ring, newest first. */
	readonly debugNet: () => { readonly value: string };
	/**
	 * The same ring, read WITHOUT surfacing it.
	 *
	 * `debugNet` is the flow: it renders the read for the human who typed it.
	 * The dev-tools panel reads the ring while rendering, so it needs the pure
	 * read — dispatching from a render is a re-render loop.
	 */
	readonly netTap: () => string;
	/** Drop every chain grant and pending denial (admin /debug.grants.reset). */
	readonly resetGrants: () => Promise<string | { readonly value: string }>;
	/**
	 * The tapped fetch, exposed so the chain runtime's model-relay traffic
	 * records into the same ring as every controller seam.
	 */
	readonly tappedFetch: FetchLike;
	/** Load the identity session record from the identity seam (actor: system). */
	readonly loadSession: () => Promise<void>;
	/** Redirect to the identity seam's GitHub OAuth start. */
	readonly signIn: () => void;
	readonly signOut: () => Promise<string | void>;
	readonly requestAccess: () => Promise<string | void>;
	/**
	 * Consume a `?auth=failed` return from a failed OAuth redirect: the failure
	 * renders as a Smithers message in the chat (honest error + retry action),
	 * never a bare page. Answers whether the search string carried one.
	 */
	readonly handleAuthReturn: (search: string) => boolean;
	/*
	 * The requirement axis (registry.ts commandRequirements): park a
	 * user-invoked command on an unmet requirement, and resume it when the
	 * requirement's predicate flips true. Deferral is durable (the session
	 * row) because sign-in is a full OAuth redirect; every seam that can
	 * SATISFY a requirement calls resumeDeferredCommand after it settles.
	 */
	readonly deferCommand: (name: string, args: string | null, requirement: string) => void;
	readonly resumeDeferredCommand: () => void;
	/** Record a visible command run for the slash menu's recency ranking. */
	readonly noteCommandRun: (name: string) => void;
	/** Render the full visible-flow catalog into the chat (the /flows answer). */
	readonly showCommandCatalog: () => void;
	/** Render the sign-in step into the chat (auth.prompt — the agent's door to login). */
	readonly promptSignIn: () => void;
	/**
	 * Record the follow-ups the agent predicts after its answer (will,
	 * 2026-08-19). Validated here: a question is the user's own next message,
	 * a flow is one the human can invoke from the pill row.
	 */
	readonly proposeSuggestions: (
		proposals: ReadonlyArray<{ kind: string; label: string; flow?: string; args?: string }>,
	) => string | { readonly value: string };
	/** Reload the app window — the /reload affordance (dev loop, stuck states). */
	readonly reloadApp: () => void;
	/*
	 * The multi-parity domain seams (MULTI-ACTIONS-GAP.md Tier 1/2): issues,
	 * PRs/landings, billing checkout, BYOK keys, notifications, the agent
	 * environment, and repo import. One method per command; each seam owns its
	 * backend domain in state/seams/*.
	 */
	readonly listIssues: IssuesSeam["listIssues"];
	readonly viewIssue: IssuesSeam["viewIssue"];
	readonly createIssue: IssuesSeam["createIssue"];
	readonly setIssueState: IssuesSeam["setIssueState"];
	readonly commentOnIssue: IssuesSeam["commentOnIssue"];
	readonly listLandings: LandingsSeam["listLandings"];
	readonly viewLanding: LandingsSeam["viewLanding"];
	readonly createLanding: LandingsSeam["createLanding"];
	readonly landLanding: LandingsSeam["landLanding"];
	readonly reviewLanding: LandingsSeam["reviewLanding"];
	readonly startCheckout: BillingSeam["startCheckout"];
	readonly openBillingPortal: BillingSeam["openBillingPortal"];
	readonly listKeys: KeysSeam["listKeys"];
	readonly removeKey: KeysSeam["removeKey"];
	readonly listNotifications: NotificationsSeam["listNotifications"];
	readonly markNotificationsRead: NotificationsSeam["markNotificationsRead"];
	readonly viewEnvironment: EnvironmentSeam["viewEnvironment"];
	readonly setEnvironmentVar: EnvironmentSeam["setEnvironmentVar"];
	readonly importRepository: RepoImportSeam["importRepository"];
	readonly listBookmarks: BookmarksSeam["listBookmarks"];
	readonly listFiles: FilesSeam["listFiles"];
	readonly readFile: FilesSeam["readFile"];
	readonly checkGitHubApp: AppStatusSeam["checkGitHubApp"];
	/** Dismiss one toast on the shared corner stack (the toast.dismiss command). */
	readonly dismissToast: (id: string) => void;
	/** Refresh the billing record from the billing seam (actor: system). */
	readonly refreshBalance: () => Promise<void>;
	/** Refresh the balance and surface it as a card in the transcript. */
	readonly showBalance: () => Promise<string | { readonly value: string }>;
	/** Beat 5: fetch the reco seam's first-run answer and render it (digest message + card, or the honest degraded line). */
	readonly loadFirstRunReco: (bump?: boolean) => Promise<void>;
	readonly acceptRecommendation: (cardId?: string) => Promise<string | void>;
	readonly editRecommendation: (cardId?: string) => Promise<string | void>;
	readonly dismissRecommendation: (cardId?: string) => Promise<string | void>;
	readonly refreshRecommendation: () => Promise<string | void>;
	/* The admin plugin's controller half — registered as commands only for admin sessions. */
	readonly adminAllowlist: (action: "add" | "remove", login: string) => Promise<string | void>;
	readonly adminGrant: (amountUsd: number, login: string) => string | void;
	readonly adminGrantConfirm: (cardId: string) => Promise<string | void>;
	readonly adminGrantCancel: (cardId: string) => string | void;
	readonly adminRequests: () => Promise<string | void>;
	readonly adminQueueApprove: (login: string) => Promise<string | void>;
	readonly adminFeedback: () => Promise<string | void>;
	readonly adminHealth: () => Promise<string | void>;
}

/**
 * The product-Worker backend seams the controller talks to. Injectable so tests
 * bind honest doubles instead of a network; production uses same-origin fetch.
 */
export interface AppServices {
	readonly fetchImpl?: FetchLike;
	readonly baseUrl?: string;
	/** The toast debounce (the 300ms law); injectable so tests pin both sides of it. */
	readonly toastDebounceMs?: number;
	/**
	 * Open a URL in the system browser (the native shell's door). Present =
	 * the sign-in handoff runs OAuth outside the webview, where passkeys
	 * work; absent = pure web keeps the same-page navigation.
	 */
	readonly openExternal?: (url: string) => Promise<boolean>;
	/** The handoff claim poll cadence; tests shorten it. */
	readonly handoffPollMs?: number;
	/** How long a settled-ok toast states its result before dismissing itself. */
	readonly toastAutoDismissMs?: number;
	/**
	 * Wave 11 — the run card's event-pump cadence (the floor under the relay's
	 * SSE pokes) and the provision poll gap. Injectable so tests drive a whole
	 * run journey without waiting out real seconds.
	 */
	readonly workflowPollMs?: number;
	/**
	 * Wave 12 §3 — how long a run may make no progress before the card states
	 * that it has gone quiet and the pump stops (10 minutes in production).
	 */
	readonly workflowQuietMs?: number;
	/**
	 * How long a request/response seam may take before it is an honest failure
	 * (§22.6). Streaming paths carry no deadline; tests shorten this one.
	 */
	readonly seamTimeoutMs?: number;
}

const documentPath = (store: AppStore): string => {
	const paths = new Set([...store.collections.worldDocuments.values()].map((document) => document.path));
	let suffix = 1;
	while (paths.has(`Untitled ${suffix}.md`)) suffix += 1;
	return `Untitled ${suffix}.md`;
};

const updateDocumentBody = (document: WorldDocument, body: string) => {
	const restoredBody = restoreWikilinks(body);
	return {
		id: document.id,
		path: document.path,
		title: document.title,
		body: restoredBody,
		links: [...new Set(parseWikilinks(restoredBody).map((link) => link.target).filter(Boolean))],
		tags: document.tags,
		sources: [...new Set([...document.sources, "user:world-editor"])],
		confidence: document.confidence,
	};
};

interface PendingToolCall {
	readonly callId: string;
	readonly name: string;
	readonly args: string;
}

interface ActiveTurn {
	readonly id: string;
	receivedText: boolean;
	/** Executed tool legs of this logical turn (capped at MAX_TOOL_LEGS). */
	toolLegs: number;
	/** The function_call / function_call_output items accumulated across legs. */
	readonly toolItems: AgentChatMessage[];
	pendingCall: PendingToolCall | undefined;
	/*
	 * Wave 12 §1: the run-launch command this turn actually executed, if any.
	 * Once set, the model's remaining text for the turn is held back and only
	 * rendered if it claims nothing about run state (see RunClaims.ts).
	 */
	runLaunch: string | undefined;
	/*
	 * Wave 13c: the impossible-ask class the user's message asked for, if any
	 * (detected from the ask alone at send time). Once set, the model's text
	 * for the turn is held back like a launch turn's and only rendered if it
	 * offers the act the class names — never for ordinary conversation.
	 */
	askClass: ImpossibleAskClass | undefined;
	/** Text deltas withheld from the transcript while a claim check is pending. */
	claimBuffer: string;
}

/**
 * Environment-agnostic: the native bridge is injected by the composition root so this
 * module never pulls the Electrobun runtime into pure-web or test contexts.
 */
export const createAppController = (
	store: AppStore,
	repositories: NativeRepositories,
	agent: NativeAgent,
	services: AppServices = {},
): AppController => {
	let activeTurn: ActiveTurn | undefined;
	/*
	 * The actor commands dispatch under: "user" for buttons/slash/keyboard,
	 * "smithers" while a model tool call runs through the same registry path,
	 * so the journal records who actually drove the change.
	 */
	let commandActor: "user" | "smithers" = "user";
	/** Announce an identity change to the other tabs; wired by watchIdentityAcrossTabs. */
	let identityChanged: () => void = () => {};
	const baseUrl = services.baseUrl ?? "";
	/*
	 * The wire tap (DESIGN.md §14 debug mode): a bounded in-memory ring around
	 * the one fetch seam every controller call flows through. Records method,
	 * url, status, and duration. Never persisted. This is the only capture
	 * debug mode adds beyond what the app already stores.
	 */
	const netRing: Array<{
		readonly at: number;
		readonly method: string;
		readonly url: string;
		readonly status: number | "error";
		readonly ms: number;
	}> = [];
	const recordNet = (entry: (typeof netRing)[number]): void => {
		netRing.push(entry);
		if (netRing.length > 100) netRing.shift();
	};
	const rawHttp: FetchLike = services.fetchImpl ?? fetch.bind(globalThis);
	/*
	 * Mid-session 401 recovery (multi's AUTH_REQUIRED discipline, one seam):
	 * a 401 off any /api call while the app believes it is signed in means the
	 * cookie expired — bursts collapse into ONE identity re-probe, and the
	 * definitive answer drives the auth conversation state (loadSession never
	 * 401s itself: the Worker restates signed-out as 200). A 401 while
	 * signed-out is the expected state and probes nothing.
	 */
	let authReprobeAt = 0;
	const noteUnauthorized = (url: string): void => {
		if (!url.includes("/api/") || url.includes("/api/auth/")) return;
		const identity = store.collections.identitySessions.get("identity");
		if (identity?.state !== "signed-in") return;
		const now = Date.now();
		if (now - authReprobeAt < 10_000) return;
		authReprobeAt = now;
		void loadSession();
	};

	const http: FetchLike = async (input, init) => {
		const started = Date.now();
		const method =
			init?.method ?? (input instanceof Request ? input.method : "GET");
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		try {
			const response = await rawHttp(input, init);
			recordNet({ at: started, method, url, status: response.status, ms: Date.now() - started });
			if (response.status === 401) noteUnauthorized(url);
			return response;
		} catch (error) {
			recordNet({ at: started, method, url, status: "error", ms: Date.now() - started });
			throw error;
		}
	};

	/*
	 * A request that never answers has to become an answer.
	 *
	 * §22.6 / A.18: `POST /api/workflow/provision` never replied, so
	 * "Preparing your … workspace…" stood past 120s with no run card, no
	 * timeout and no error — the silent-failure family with a spinner on top.
	 * A bounded wait turns it into an honest refusal. It rides only on the
	 * request/response seams; the streaming paths (the turn, the model relay)
	 * carry no deadline, because a long stream is not a hang.
	 */
	const SEAM_TIMEOUT_MS = services.seamTimeoutMs ?? 30_000;
	/**
	 * One request, with a deadline on it.
	 *
	 * Built from an AbortController rather than `AbortSignal.timeout` so the
	 * timer is CLEARED the moment the request settles: a dangling timer per
	 * request holds the process open outside a browser, and the deadline is
	 * about the request, not about the page.
	 */
	const boundedFetch = async (url: string, init: RequestInit): Promise<Response> => {
		if (typeof AbortController !== "function") return http(url, init);
		const aborter = new AbortController();
		const timer = setTimeout(() => aborter.abort(new Error("seam timeout")), SEAM_TIMEOUT_MS);
		unref(timer);
		try {
			return await http(url, { ...init, signal: aborter.signal });
		} finally {
			clearTimeout(timer);
		}
	};

	const errorMessageOf = async (response: Response, fallback: string): Promise<string> => {
		const body = (await response.text().catch(() => "")).trim();
		try {
			const parsed: unknown = JSON.parse(body);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"message" in parsed &&
				typeof parsed.message === "string"
			) {
				return parsed.message;
			}
		} catch {
			// A non-JSON error body carries no better message than the fallback.
		}
		return body === "" ? fallback : `${fallback} (${body.slice(0, 200)})`;
	};

	/*
	 * The 300ms toast law (2026-08-09): background work not settled within
	 * 300ms states what is running on the shared toast stack; work under
	 * 300ms never flashes anything. `work` answers true on success or the
	 * honest failure line — a failure toast stays until dismissed, an ok
	 * toast resolves into the result and dismisses itself.
	 */
	const toastDebounceMs = services.toastDebounceMs ?? 300;
	const toastAutoDismissMs = services.toastAutoDismissMs ?? 4000;
	const workflowPollMs = services.workflowPollMs ?? 2500;
	const unref = (timer: ReturnType<typeof setTimeout>): void => {
		// Bun/Node timers hold the process open (e2e scripts); browser timers don't.
		(timer as { unref?: () => void }).unref?.();
	};
	/*
	 * One toast per flow key, so a re-run of the same flow owns the slot: the
	 * run counter keeps a finished run from resolving OR auto-dismissing the
	 * toast a newer run is using — a running notice must never silently vanish
	 * while the work it names is still in flight.
	 */
	const toastRuns = new Map<string, number>();
	const withToast = async <T>(
		key: string,
		title: string,
		doneTitle: string,
		work: () => Promise<T | string>,
	): Promise<T | string> => {
		const run = (toastRuns.get(key) ?? 0) + 1;
		toastRuns.set(key, run);
		let shown = false;
		const debounce = setTimeout(() => {
			if (toastRuns.get(key) !== run) return;
			shown = true;
			store.dispatch({ type: "toast.shown", actor: "system", key, title });
		}, toastDebounceMs);
		unref(debounce);
		let outcome: T | string;
		try {
			outcome = await work();
		} catch {
			// A thrown flow is still an honest failure — never a toast stuck "running".
			outcome = `${title.replace(/…$/, "")} didn't finish — the app hit an unexpected error.`;
		} finally {
			clearTimeout(debounce);
		}
		// A newer run of the same flow owns the toast now; this one reports nothing.
		if (toastRuns.get(key) !== run) return outcome;
		// Resolve whatever is on screen for this key — including a toast an
		// earlier (slower) run put up, or a failed one this run just retried.
		if (!shown && store.collections.toasts.get(`toast-${key}`) === undefined) return outcome;
		// A string outcome is the honest failure line; anything else is success
		// (true, or a value the caller consumes — e.g. the browser tool's read).
		const ok = typeof outcome !== "string";
		store.dispatch({
			type: "toast.resolved",
			actor: "system",
			key,
			status: ok ? "ok" : "failed",
			// Settled work states its result, never the running sentence: an ok
			// toast reads as done for the seconds before it dismisses itself, and
			// a failure keeps the attempt's title with the honest line under it.
			...(ok ? { title: doneTitle } : {}),
			detail: ok ? "" : (outcome as string),
		});
		if (ok) {
			const dismiss = setTimeout(() => {
				if (toastRuns.get(key) !== run) return;
				store.dispatch({ type: "toast.dismissed", actor: "system", id: `toast-${key}` });
			}, toastAutoDismissMs);
			unref(dismiss);
		}
		return outcome;
	};

	const dismissToast = (id: string): void => {
		store.dispatch({ type: "toast.dismissed", actor: "user", id });
	};

	/** Returning from a failed OAuth redirect is a chat message, never a bare page. */
	const handleAuthReturn = (search: string): boolean => {
		const params = new URLSearchParams(search);
		const auth = params.get("auth");
		if (auth !== "failed" && auth !== "error") return false;
		store.dispatch({
			type: "message.appended",
			actor: "system",
			text: "GitHub sign-in didn't finish — nothing was signed in. Try again whenever you're ready.",
			action: { flow: "auth.sign-in", label: "Try sign-in again" },
		});
		return true;
	};

	/*
	 * Identity seam. Only definitive answers gate the app: a signed-out or
	 * non-allowlisted response drives the landing states; "unavailable" (seam
	 * unset or unreachable) is recorded honestly but never blocks the surface.
	 */
	const fetchScopesPlain = async (): Promise<string | null> => {
		try {
			const response = await http(`${baseUrl}${AUTH_SCOPES_PATH}`);
			if (!response.ok) {
				await response.body?.cancel();
				return null;
			}
			const body = (await response.json()) as { scopes?: unknown };
			if (!Array.isArray(body.scopes)) return null;
			const plains = body.scopes
				.map((scope) =>
					typeof scope === "object" && scope !== null && "plain" in scope && typeof scope.plain === "string"
						? scope.plain.trim()
						: "",
				)
				.filter((plain) => plain !== "");
			if (plains.length === 0) return null;
			// The identity worker writes each scope as a whole sentence
			// ("See your GitHub profile — your username, name, and avatar."), so
			// they are stated after a lead-in, never spliced into one.
			return `Before GitHub asks, here is what Smithers will use: ${plains.join(" ")}`;
		} catch {
			return null;
		}
	};

	const dispatchSignedOut = async (): Promise<void> => {
		const scopesPlain = await fetchScopesPlain();
		store.dispatch({
			type: "identity.session.loaded",
			actor: "system",
			state: "signed-out",
			login: null,
			allowlisted: false,
			admin: false,
			scopesPlain,
		});
	};

	const dispatchUnavailable = (): void => {
		store.dispatch({
			type: "identity.session.loaded",
			actor: "system",
			state: "unavailable",
			login: null,
			allowlisted: false,
			admin: false,
			scopesPlain: null,
		});
	};

	const loadSession = async (): Promise<void> => {
		const previous = store.collections.identitySessions.get("identity");
		let response: Response;
		try {
			response = await http(`${baseUrl}${AUTH_SESSION_PATH}`);
		} catch {
			dispatchUnavailable();
			return;
		}
		// Signed-out is the expected resolved answer, never an error path: the
		// identity upstream states it as 401/403, the product Worker's seam
		// restates it as 200 { status: "signed-out" } so the browser never logs
		// the expected answer as a console error. Both shapes resolve the same.
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel();
			await dispatchSignedOut();
			return;
		}
		if (!response.ok) {
			await response.body?.cancel();
			dispatchUnavailable();
			return;
		}
		const body = (await response.json().catch(() => undefined)) as
			| { status?: unknown; login?: unknown; allowlisted?: unknown; admin?: unknown }
			| undefined;
		if (body?.status === "signed-out") {
			await dispatchSignedOut();
			return;
		}
		if (body === undefined || typeof body.login !== "string" || body.login === "") {
			dispatchUnavailable();
			return;
		}
		store.dispatch({
			type: "identity.session.loaded",
			actor: "system",
			state: "signed-in",
			login: body.login,
			allowlisted: body.allowlisted === true,
			admin: body.admin === true,
			scopesPlain: null,
		});
		if (previous?.state !== "signed-in" || previous.login !== body.login) identityChanged();
		// The balance read is driven by the session answer, not fired blind at
		// boot: signed out it could only come back 401 — the expected state,
		// logged by the browser as a console error anyway.
		void refreshBalance();
		// Beat 5: entering chat signed-in reads the reco seam's first-run answer.
		if (body.allowlisted === true) {
			void loadFirstRunReco();
			// Wave 11: a live run card's event pump resumes from its lastSeq.
			resumeWorkflowRuns();
		}
		// The signed-in answer can satisfy a parked command's requirement — the
		// command that deferred into this sign-in continues here, across the
		// OAuth redirect.
		resumeDeferredCommand();
	};

	/*
	 * The native sign-in handoff (device-flow style): the embedded webview has
	 * no platform authenticator, so GitHub passkeys CANNOT complete inside it
	 * (the live failure: GitHub's cross-device Bluetooth fallback dying in the
	 * window). OAuth runs in the SYSTEM browser instead — start mints a
	 * one-time handoff, openExternal launches the browser at the OAuth start
	 * bound to it, and the page polls the claim same-origin until the session
	 * cookie lands in the app's own jar. One toast narrates the whole arc.
	 */
	const handoffPollMs = services.handoffPollMs ?? 2000;
	const nativeSignIn = async (openExternal: (url: string) => Promise<boolean>): Promise<void> => {
		const key = "auth.sign-in.handoff";
		const fail = (detail: string): void => {
			store.dispatch({ type: "toast.resolved", actor: "system", key, status: "failed", detail });
		};
		store.dispatch({ type: "toast.shown", actor: "system", key, title: "Finishing sign-in in your browser…" });
		let start: { handoffId?: unknown; pollSecret?: unknown } | undefined;
		try {
			const response = await http(`${baseUrl}${AUTH_NATIVE_START_PATH}`, { method: "POST" });
			if (!response.ok) {
				fail(await errorMessageOf(response, "Sign-in couldn't start. Try again."));
				return;
			}
			start = (await response.json().catch(() => undefined)) as typeof start;
		} catch {
			fail("Sign-in couldn't start — the identity service didn't answer.");
			return;
		}
		if (typeof start?.handoffId !== "string" || typeof start.pollSecret !== "string") {
			fail("Sign-in couldn't start — the identity service answered in an unexpected shape.");
			return;
		}
		const origin = baseUrl !== "" ? baseUrl : typeof window === "undefined" ? "" : window.location.origin;
		const opened = await openExternal(
			`${origin}${AUTH_SIGN_IN_PATH}?handoff=${encodeURIComponent(start.handoffId)}`,
		);
		if (!opened) {
			fail("Your browser couldn't be opened. Try again.");
			return;
		}
		// ~5 minutes of patience: OAuth in another app takes as long as it takes.
		for (let attempt = 0; attempt < 150; attempt += 1) {
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, handoffPollMs);
				unref(timer);
			});
			let claim: Response;
			try {
				claim = await http(`${baseUrl}${AUTH_NATIVE_CLAIM_PATH}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ handoffId: start.handoffId, pollSecret: start.pollSecret }),
				});
			} catch {
				continue; // A dropped poll is not a failed sign-in.
			}
			if (claim.status === 404) {
				fail("That sign-in expired — try again.");
				return;
			}
			const body = (await claim.json().catch(() => undefined)) as
				| { status?: unknown; message?: unknown }
				| undefined;
			if (body?.status === "pending") continue;
			if (body?.status === "ready") {
				// The claim's Set-Cookie is in the jar; the session probe states it.
				await loadSession();
				const identity = store.collections.identitySessions.get("identity");
				store.dispatch({
					type: "toast.resolved",
					actor: "system",
					key,
					status: "ok",
					title: "Signed in",
					detail:
						identity?.state === "signed-in"
							? `Connected as ${identity.login ?? "you"}.`
							: "Signed in — loading your session…",
				});
				return;
			}
			if (body?.status === "failed") {
				fail(typeof body.message === "string" ? body.message : "Sign-in didn't finish. Try again.");
				return;
			}
		}
		fail("Sign-in timed out — try again whenever you're ready.");
	};

	/*
	 * Sign-in navigates ONLY when the identity seam has answered that it
	 * exists (multi's startSignIn discipline): navigating blindly off a build
	 * with no seam just reloads the SPA — a flash with no answer, which reads
	 * as a silent failure. Every refusal states itself as a toast. With the
	 * native shell's openExternal door, sign-in runs the handoff instead of
	 * navigating: the webview page survives, and passkeys work in the real
	 * browser.
	 */
	const signIn = (): void => {
		const identity = store.collections.identitySessions.get("identity");
		const toast = (key: string, title: string, detail: string): void => {
			store.dispatch({ type: "toast.shown", actor: "system", key, title });
			store.dispatch({ type: "toast.resolved", actor: "system", key, status: "failed", detail });
		};
		if (identity?.state === "signed-in") {
			toast(
				"auth.sign-in.already",
				`Already connected as ${identity.login ?? "you"}`,
				"GitHub is connected — /auth.sign-out switches accounts.",
			);
			return;
		}
		if (identity === undefined || identity.state === "unavailable") {
			toast(
				"auth.sign-in.unavailable",
				"Sign-in isn't available on this build",
				"No identity service is configured here — use the deployed app to sign in.",
			);
			return;
		}
		if (identity.state === "unknown") {
			toast(
				"auth.sign-in.pending",
				"Still checking sign-in availability",
				"The identity service hasn't answered yet — try again in a moment.",
			);
			return;
		}
		const openExternal = services.openExternal;
		if (openExternal !== undefined) {
			void nativeSignIn(openExternal);
			return;
		}
		if (typeof window !== "undefined") window.location.assign(`${baseUrl}${AUTH_SIGN_IN_PATH}`);
	};

	/*
	 * Sign-out that does not sign out must SAY so. Returning void on a failed
	 * logout left the user looking at their own signed-in session with no hint
	 * that the act had failed — the silent-failure shape, on the one act whose
	 * whole point is that it took effect.
	 */
	const signOut = async (): Promise<string | void> => {
		try {
			const response = await http(`${baseUrl}${AUTH_LOGOUT_PATH}`, { method: "POST" });
			if (!response.ok) {
				return await errorMessageOf(response, "Signing out didn't go through — you are still signed in.");
			}
		} catch {
			return "Signing out didn't go through — the identity service didn't answer. You are still signed in.";
		}
		store.dispatch({ type: "identity.session.cleared", actor: "user" });
		identityChanged();
	};

	/*
	 * A.38: this used to answer nothing at all when there was nothing to do.
	 * For a non-allowlisted account the auth message carries both the filed
	 * request and any failure, so the outcome is visible where it belongs; for
	 * everyone else the flow now says why it did nothing instead of POSTing
	 * quietly and returning.
	 */
	const requestAccess = async (): Promise<string | void> => {
		const identity = store.collections.identitySessions.get("identity");
		if (identity === undefined || identity.state !== "signed-in" || identity.login === null) {
			return "Sign in with GitHub first — an access request needs an account to attach to.";
		}
		if (identity.allowlisted) {
			return `You already have access as ${identity.login} — there is no request to file.`;
		}
		try {
			const response = await http(`${baseUrl}${IDENTITY_REQUEST_ACCESS_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ login: identity.login }),
			});
			if (!response.ok) {
				store.dispatch({
					type: "identity.access.failed",
					actor: "system",
					message: await errorMessageOf(response, "The access request did not go through. Try again."),
				});
				return;
			}
		} catch {
			store.dispatch({
				type: "identity.access.failed",
				actor: "system",
				message: "The access request did not go through. Try again.",
			});
			return;
		}
		store.dispatch({ type: "identity.access.requested", actor: "user" });
	};

	/** Billing seam: dollars only; chat is complimentary, so a definitive $0 never pauses it. */
	const refreshBalanceImpl = async (): Promise<true | string> => {
		let response: Response;
		try {
			response = await http(`${baseUrl}${BILLING_BALANCE_PATH}`);
		} catch {
			store.dispatch({ type: "billing.unavailable", actor: "system" });
			return "Your balance couldn't be refreshed — the billing service didn't answer.";
		}
		if (!response.ok) {
			await response.body?.cancel();
			store.dispatch({ type: "billing.unavailable", actor: "system" });
			return "Your balance couldn't be refreshed right now.";
		}
		const body = (await response.json().catch(() => undefined)) as
			| {
					state?: unknown;
					allowedToStartWork?: unknown;
					balance?: { totalUsd?: unknown; lifetimeChargedUsd?: unknown; chargeCount?: unknown };
			  }
			| undefined;
		const state = body?.state;
		if (
			body === undefined ||
			(state !== "ok" && state !== "low" && state !== "empty") ||
			typeof body.allowedToStartWork !== "boolean" ||
			typeof body.balance?.totalUsd !== "string"
		) {
			store.dispatch({ type: "billing.unavailable", actor: "system" });
			return "Your balance couldn't be refreshed right now.";
		}
		store.dispatch({
			type: "billing.refreshed",
			actor: "system",
			state,
			totalUsd: body.balance.totalUsd,
			allowedToStartWork: body.allowedToStartWork,
			lifetimeChargedUsd:
				typeof body.balance.lifetimeChargedUsd === "string" ? body.balance.lifetimeChargedUsd : "0",
			chargeCount: typeof body.balance.chargeCount === "number" ? body.balance.chargeCount : 0,
		});
		return true;
	};

	const refreshBalance = (): Promise<void> =>
		withToast("billing.balance.refresh", "Refreshing your balance…", "Balance is up to date", refreshBalanceImpl).then(() => undefined);

	const nextTranscriptOrdinal = (): number => {
		let highest = -1;
		for (const message of store.collections.messages.values()) highest = Math.max(highest, message.ordinal);
		for (const card of store.collections.cards.values()) highest = Math.max(highest, card.ordinal);
		return highest + 1;
	};

	/*
	 * The multi-parity domain seams: each owns one backend domain behind the
	 * platform proxy, constructed on the shared seam context (the tapped
	 * fetch, the store, the transcript-ordinal door).
	 */
	const seamCtx: SeamContext = {
		http,
		baseUrl,
		store,
		dispatch: store.dispatch,
		actor: () => commandActor,
		nextOrdinal: nextTranscriptOrdinal,
	};
	const issuesSeam = createIssuesSeam(seamCtx);
	const landingsSeam = createLandingsSeam(seamCtx);
	const billingSeam = createBillingSeam(seamCtx);
	const keysSeam = createKeysSeam(seamCtx);
	const notificationsSeam = createNotificationsSeam(seamCtx);
	const environmentSeam = createEnvironmentSeam(seamCtx);
	const repoImportSeam = createRepoImportSeam(seamCtx);
	const repoCatalogSeam = createRepoCatalogSeam(seamCtx, {
		repos: RECO_REPOS_PATH,
		watched: RECO_WATCHED_PATH,
	});
	const bookmarksSeam = createBookmarksSeam(seamCtx);
	const filesSeam = createFilesSeam(seamCtx);
	const appStatusSeam = createAppStatusSeam(seamCtx);

	/*
	 * §22.7: this returned void, so the model's own `billing.balance` call
	 * handed it NOTHING back and it answered from a guess — "$0.00" one line
	 * above the card the same call had just rendered reading "$519 left". A
	 * tool that can be invoked and cannot be read confabulates on every data
	 * question, not just this one.
	 */
	const showBalance = async (): Promise<string | { readonly value: string }> => {
		await refreshBalance();
		const account = store.collections.billingAccounts.get("billing");
		if (account === undefined || account.state === "unknown" || account.state === "unavailable") {
			return "The billing service didn't answer, so there is no balance to state right now.";
		}
		// One balance card, re-surfaced at the end of the transcript each time it
		// is asked for: leaving it at its old ordinal would answer the command
		// with a silent no-op once the conversation has moved past it.
		const card: Card = {
			id: "billing-balance",
			kind: "balance",
			title: "Balance",
			status: "active",
			createdAt: Date.now(),
			ordinal: nextTranscriptOrdinal(),
			payload: {
				totalUsd: account.totalUsd ?? "0",
				state: account.state,
				allowedToStartWork: account.allowedToStartWork,
				lifetimeChargedUsd: account.lifetimeChargedUsd ?? "0",
				chargeCount: account.chargeCount,
				// The first-run line, stated once: an untouched grant reads
				// "You have $500 of usage on us." — after any charge it is gone.
				introUsd: account.chargeCount === 0 ? account.totalUsd : null,
			},
		};
		store.dispatch({ type: "card.upsert", actor: "system", card });
		return {
			value: `balance: $${account.totalUsd ?? "0"} left; $${account.lifetimeChargedUsd ?? "0"} spent across ${account.chargeCount} turn(s)`,
		};
	};

	/*
	 * The recommendations seam (Wave 3b, Beat 5 — "Smithers has already read").
	 * The digest sentence becomes the first Smithers message and the one
	 * recommendation a card; a degraded answer renders its honestMessage,
	 * never filler. Every accept/edit/dismiss posts feedback (the day-one
	 * logging law) and a failed post leaves the card retryable with the honest
	 * error — the approval discipline, applied to recommendations.
	 */

	/** Mirror the seam's selection locally, keeping provenance the row already holds. */
	const mirrorWatched = (selected: ReadonlyArray<string>): void => {
		const existing = store.collections.watchedRepos.get("watched");
		if (
			existing !== undefined &&
			existing.selected !== null &&
			existing.selected.length === selected.length &&
			existing.selected.every((name, index) => name === selected[index])
		) {
			return;
		}
		store.dispatch({
			type: "watched.replaced",
			actor: "system",
			selected: [...selected],
			selectedAt: existing?.selectedAt ?? null,
			via: existing?.via ?? null,
		});
	};

	/**
	 * Read the DURABLE watched selection and mirror it locally.
	 *
	 * The selection lives on the reco seam and `GET /api/reco/watched` answers it
	 * from its own store — it does not need GitHub. The first-run digest DOES,
	 * and when GitHub refuses that read (live on canary: `degraded:
	 * github_rejected`, HTTP 401) the degraded answer carries no `watched`, so
	 * the app came up believing the user watches nothing: `flow.create` sent
	 * them back to the onboarding chooser they had already answered, and the
	 * runtime context told the model `needsSelection`, which had it say "I need a
	 * repository to watch before I can create a workflow" to someone watching
	 * three. A degraded digest is not a forgotten selection.
	 */
	const loadWatchedSelection = async (): Promise<void> => {
		try {
			const selected = await repoCatalogSeam.readWatchedSelection();
			if (selected === undefined) return;
			mirrorWatched(selected);
		} catch {
			// The honest message the caller already rendered is the whole answer.
		}
	};

	/** The chooser card, when one is in the transcript. */
	const chooserCard = (): Extract<Card, { kind: "repo-chooser" }> | undefined => {
		const card = store.collections.cards.get(REPO_CHOOSER_CARD_ID);
		return card?.kind === "repo-chooser" ? card : undefined;
	};

	const patchChooser = (
		patch: Partial<Extract<Card, { kind: "repo-chooser" }>["payload"]>,
		status?: Card["status"],
	): void => {
		const card = chooserCard();
		if (card === undefined) return;
		store.dispatch({
			type: "card.updated",
			actor: commandActor,
			id: card.id,
			patch: { payload: { ...card.payload, ...patch }, ...(status === undefined ? {} : { status }) },
		});
	};

	/*
	 * Open the repo chooser — the one onboarding question, and the "just ask"
	 * path later. Candidates come from the selection read when one exists
	 * (pre-filled), else from GET /api/reco/repos; the agent's optional repo
	 * argument pre-selects on top. The card is embedded in the transcript for
	 * every actor — a chooser is never a takeover.
	 */
	/*
	 * The account's repositories, and the catalog the repository list projects,
	 * both from the one seam that owns those reads (RepoCatalogSeam — GET
	 * /api/reco/repos, GET /api/reco/watched). The onboarding chooser and the
	 * GitHub pane's repository list are the same read: one asks the user to
	 * pick, the other lets them browse, and neither may show a repository the
	 * account does not have.
	 */
	const readRepoCandidates = repoCatalogSeam.readCandidates;
	const loadRepoCatalog = repoCatalogSeam.loadCatalog;

	const openRepoChooserImpl = async (preselect?: string): Promise<true | string> => {
		/*
		 * The chooser lists the USER'S repositories: without a signed-in
		 * session it can only open empty (the live bug: an empty "No
		 * repositories match" chooser while signed out). The sign-in step
		 * renders instead — promptSignIn answers every identity state
		 * honestly, including a build with no identity seam at all.
		 */
		const chooserIdentity = store.collections.identitySessions.get("identity");
		if (chooserIdentity?.state !== "signed-in") {
			promptSignIn();
			return "GitHub isn't connected yet — the chooser lists your repositories, so the sign-in step comes first.";
		}
		const via = commandActor === "smithers" ? "agent" : "command";
		let candidates: RepoCandidate[] | undefined;
		let selected: string[] = [];
		try {
			selected = (await repoCatalogSeam.readWatchedSelection()) ?? [];
			candidates = await readRepoCandidates();
		} catch {
			return "The recommendations service didn't answer — the chooser couldn't open. Try again.";
		}
		if (candidates === undefined) {
			return "The recommendations service didn't answer — the chooser couldn't open. Try again.";
		}
		// A pre-selected name the candidates list doesn't know is stated, not
		// silently dropped — and the chooser still opens with what IS visible.
		const preselectKnown = preselect === undefined || candidates.some((candidate) => candidate.fullName === preselect);
		const mergedSelection =
			preselect === undefined || !preselectKnown || selected.includes(preselect)
				? selected
				: [...selected, preselect];
		const existing = chooserCard();
		let highest = -1;
		for (const message of store.collections.messages.values()) highest = Math.max(highest, message.ordinal);
		for (const card of store.collections.cards.values()) highest = Math.max(highest, card.ordinal);
		const card: Card = {
			id: REPO_CHOOSER_CARD_ID,
			kind: "repo-chooser",
			title: "Choose the repositories Smithers watches",
			status: "active",
			createdAt: existing?.createdAt ?? Date.now(),
			ordinal: highest + 1,
			payload: { candidates, selected: mergedSelection, via, phase: "choosing" },
		};
		store.dispatch({ type: "card.upsert", actor: commandActor, card });
		if (!preselectKnown && preselect !== undefined) {
			return `I couldn't find ${preselect} among your repositories — the chooser is open with the ones I can see.`;
		}
		return true;
	};

	const openRepoChooser = (preselect?: string): Promise<string | void> =>
		withToast(
			"reco.chooser",
			"Reading your repositories…",
			"Your repositories are ready to choose",
			() => openRepoChooserImpl(preselect),
		).then((outcome) => (outcome === true ? undefined : outcome));

	/*
	 * A.12: the toggle used to add ANY name to the selection, so
	 * `/repos.watch.toggle no-such/repo` silently put a repository the account
	 * does not have into the set the confirm would persist. The chooser's own
	 * rows are the universe — the sibling `/repos.watch <repo>` already refuses
	 * by name, and this now answers the same way.
	 */
	const toggleWatchedRepo = (fullName: string): string | void => {
		const card = chooserCard();
		if (card === undefined) return "The repository chooser isn't open — run /repos.watch first.";
		if (card.payload.phase === "saving") return;
		const known = card.payload.candidates.some((repo) => repo.fullName === fullName);
		if (!known) {
			return `I couldn't find ${fullName} among your repositories — the chooser is open with the ones I can see.`;
		}
		const selected = card.payload.selected.includes(fullName)
			? card.payload.selected.filter((name) => name !== fullName)
			: [...card.payload.selected, fullName];
		patchChooser({ selected, phase: "choosing" });
	};

	const selectAllWatchedRepos = (): void => {
		const card = chooserCard();
		if (card === undefined || card.payload.phase === "saving") return;
		patchChooser({ selected: card.payload.candidates.map((candidate) => candidate.fullName), phase: "choosing" });
	};

	const selectNoWatchedRepos = (): void => {
		const card = chooserCard();
		if (card === undefined || card.payload.phase === "saving") return;
		patchChooser({ selected: [], phase: "choosing" });
	};

	/*
	 * Confirm → PUT /api/reco/watched with the chooser's via → one calm line
	 * naming what is watched AND that asking changes it → the scoped digest
	 * arrives (the 300ms toast law covers the compute).
	 */
	const confirmWatchedReposImpl = async (): Promise<true | string> => {
		const card = chooserCard();
		if (card === undefined) return "There is no repository chooser open.";
		if (card.payload.phase === "saving") return true;
		const { selected, via } = card.payload;
		patchChooser({ phase: "saving" });
		const echoed = await repoCatalogSeam.saveWatchedSelection(selected, via);
		if ("error" in echoed) {
			patchChooser({ phase: "failed", error: echoed.error }, "error");
			return echoed.error;
		}
		const saved = [...echoed.selected];
		store.dispatch({
			type: "watched.replaced",
			actor: commandActor,
			selected: saved,
			selectedAt: echoed.selectedAt ?? new Date().toISOString(),
			via: echoed.via !== null && ["onboarding", "command", "agent"].includes(echoed.via)
				? (echoed.via as "onboarding" | "command" | "agent")
				: via,
		});
		store.dispatch({ type: "card.removed", actor: commandActor, id: card.id });
		store.dispatch({
			type: "message.appended",
			actor: "system",
			text:
				saved.length === 0
					? "Watching no repositories for now. You can change this anytime — just ask."
					: `Watching ${saved.length} ${saved.length === 1 ? "repository" : "repositories"}: ${saved.join(", ")}. You can change this anytime — just ask.`,
		});
		// The scoped digest + one recommendation arrive for the watched set.
		void loadFirstRunReco(true);
		// A confirmed selection can satisfy a parked command's repos-selected
		// requirement — the command that deferred into this chooser continues.
		resumeDeferredCommand();
		return true;
	};

	const confirmWatchedRepos = (): Promise<string | void> =>
		withToast("reco.watched.save", "Saving your selection…", "Selection saved", confirmWatchedReposImpl).then(
			(outcome) => (outcome === true ? undefined : outcome),
		);
	const loadFirstRunRecoImpl = async (bump: boolean): Promise<true | string> => {
		let response: Response;
		try {
			response = await http(`${baseUrl}${RECO_FIRST_RUN_PATH}`);
		} catch {
			const message =
				"I couldn't reach the recommendations service just now — ask me anything and we'll start from here.";
			store.dispatch({ type: "reco.message.loaded", actor: "system", message });
			return message;
		}
		if (!response.ok) {
			const message = await errorMessageOf(response, "The recommendations service didn't answer.");
			store.dispatch({ type: "reco.message.loaded", actor: "system", message });
			return message;
		}
		const body = (await response.json().catch(() => undefined)) as
			| {
					degraded?: unknown;
					honestMessage?: unknown;
					needsSelection?: unknown;
					emptySelection?: unknown;
					candidates?: unknown;
					watched?: unknown;
					digest?: {
						computedAt?: unknown;
						reposConsidered?: unknown;
						openIssues?: unknown;
						openPullRequests?: unknown;
						staleCount?: unknown;
						mostActiveRepo?: { name?: unknown } | null;
						oldestWaiting?: {
							repo?: unknown;
							number?: unknown;
							title?: unknown;
							url?: unknown;
							waitingDays?: unknown;
						} | null;
						untriagedInMostActive?: unknown;
						sentence?: unknown;
					};
					recommendation?: {
						id?: unknown;
						title?: unknown;
						proposes?: unknown;
						whyNow?: unknown;
						whatHappens?: unknown;
						subject?: { url?: unknown };
						evidenceKey?: unknown;
						whatChanged?: unknown;
					} | null;
			  }
			| undefined;
		if (body?.degraded === true) {
			const message =
				typeof body.honestMessage === "string" && body.honestMessage.trim() !== ""
					? body.honestMessage
					: "I couldn't read your GitHub work just now — ask me anything and we'll start from here.";
			// A degraded answer IS the seam's honest success state — the work
			// itself succeeded, so the toast resolves ok; the message says the rest.
			store.dispatch({ type: "reco.message.loaded", actor: "system", message });
			// The digest needed GitHub; the SELECTION does not. Keep it.
			await loadWatchedSelection();
			return true;
		}
		/*
		 * Wave 10 onboarding: no watched-repos selection yet. The candidates
		 * ride inline so the chooser renders in one round trip; the chooser
		 * card IS the conversation's one question.
		 */
		if (body?.needsSelection === true) {
			const candidates = parseRepoCandidates(body.candidates);
			store.dispatch({ type: "reco.selection.needed", actor: "system", candidates });
			return true;
		}
		// Chose-zero is an honest state, never a fabricated digest.
		if (body?.emptySelection === true) {
			const message =
				typeof body.honestMessage === "string" && body.honestMessage.trim() !== ""
					? body.honestMessage
					: "You're watching no repositories right now — ask me to watch some and we'll start from there.";
			store.dispatch({ type: "reco.message.loaded", actor: "system", message });
			return true;
		}
		const digest = body?.digest;
		if (
			body === undefined ||
			digest === undefined ||
			typeof digest.sentence !== "string" ||
			digest.sentence.trim() === "" ||
			typeof digest.computedAt !== "string" ||
			typeof digest.reposConsidered !== "number" ||
			typeof digest.openIssues !== "number" ||
			typeof digest.openPullRequests !== "number" ||
			typeof digest.staleCount !== "number" ||
			typeof digest.untriagedInMostActive !== "number"
		) {
			const message =
				"The recommendations service answered in a shape I didn't understand — nothing is lost; ask me anything.";
			store.dispatch({ type: "reco.message.loaded", actor: "system", message });
			return message;
		}
		const digestPayload: RecoDigestPayload = {
			computedAt: digest.computedAt,
			reposConsidered: digest.reposConsidered,
			openIssues: digest.openIssues,
			openPullRequests: digest.openPullRequests,
			staleCount: digest.staleCount,
			mostActiveRepo:
				digest.mostActiveRepo !== null &&
				digest.mostActiveRepo !== undefined &&
				typeof digest.mostActiveRepo.name === "string"
					? digest.mostActiveRepo.name
					: null,
			oldestWaiting:
				digest.oldestWaiting !== null &&
				digest.oldestWaiting !== undefined &&
				typeof digest.oldestWaiting.repo === "string" &&
				typeof digest.oldestWaiting.number === "number" &&
				typeof digest.oldestWaiting.title === "string" &&
				typeof digest.oldestWaiting.url === "string" &&
				typeof digest.oldestWaiting.waitingDays === "number"
					? {
							label: `${digest.oldestWaiting.repo}#${digest.oldestWaiting.number} — ${digest.oldestWaiting.title}`,
							url: digest.oldestWaiting.url,
							waitingDays: digest.oldestWaiting.waitingDays,
						}
					: null,
			untriagedInMostActive: digest.untriagedInMostActive,
		};
		const wire = body.recommendation;
		const recommendation: RecoRecommendationPayload | null =
			wire !== null &&
			wire !== undefined &&
			typeof wire.id === "string" &&
			typeof wire.title === "string" &&
			typeof wire.proposes === "string" &&
			typeof wire.whyNow === "string" &&
			typeof wire.whatHappens === "string" &&
			typeof wire.evidenceKey === "string" &&
			typeof wire.subject?.url === "string"
				? {
						id: wire.id,
						title: wire.title,
						proposes: wire.proposes,
						whyNow: wire.whyNow,
						whatHappens: wire.whatHappens,
						subjectUrl: wire.subject.url,
						evidenceKey: wire.evidenceKey,
						...(typeof wire.whatChanged === "string" ? { whatChanged: wire.whatChanged } : {}),
					}
				: null;
		store.dispatch({
			type: "reco.digest.loaded",
			actor: "system",
			sentence: digest.sentence,
			digest: digestPayload,
			recommendation,
			bump,
		});
		/*
		 * A digest with nothing to recommend LANDS on the repository list (will,
		 * 2026-08-19), so the catalog the list projects is read here rather than
		 * waiting for the user to press something. With a recommendation on
		 * screen the list is not shown, so nothing is read for it.
		 */
		if (recommendation === null) void loadRepoCatalog();
		// A scoped digest proves a selection exists — mirror it (the local
		// record keeps the chooser's pre-fill and the agent context honest).
		if (Array.isArray(body.watched)) {
			const names = body.watched.filter((name): name is string => typeof name === "string");
			mirrorWatched(names);
		}
		return true;
	};

	const loadFirstRunReco = (bump = false): Promise<void> =>
		withToast(
			"reco.first-run",
			bump ? "Refreshing what I found…" : "Reading your repos…",
			bump ? "Refreshed what I found" : "Read your repos",
			() => loadFirstRunRecoImpl(bump),
		).then(() => undefined);

	/** The live recommendation card: the named one, else the active one carrying a recommendation. */
	const recoCard = (cardId?: string): Extract<Card, { kind: "reco" }> | undefined => {
		if (cardId !== undefined) {
			const card = store.collections.cards.get(cardId);
			return card?.kind === "reco" ? (card as Extract<Card, { kind: "reco" }>) : undefined;
		}
		const found = [...store.collections.cards.values()].find(
			// "error" is a failed feedback post: retryable, never terminal.
			(card) => card.kind === "reco" && card.status !== "acted" && card.payload.recommendation !== null,
		);
		return found as Extract<Card, { kind: "reco" }> | undefined;
	};

	/** Every accept/edit/dismiss posts feedback; a failed post leaves the card retryable. */
	const postRecoFeedback = async (
		card: Extract<Card, { kind: "reco" }>,
		action: "accept" | "edit" | "dismiss",
	): Promise<true | string> => {
		const recommendation = card.payload.recommendation;
		if (recommendation === null) return "There is no recommendation to answer.";
		try {
			const response = await http(`${baseUrl}${RECO_FEEDBACK_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					recommendationId: recommendation.id,
					action,
					evidenceKey: recommendation.evidenceKey,
				}),
			});
			if (!response.ok) {
				const message = await errorMessageOf(response, "The feedback post didn't go through. Try again.");
				store.dispatch({ type: "reco.feedback.failed", actor: "system", cardId: card.id, message });
				return message;
			}
		} catch {
			const message = "The feedback post didn't go through. Try again.";
			store.dispatch({ type: "reco.feedback.failed", actor: "system", cardId: card.id, message });
			return message;
		}
		return true;
	};

	const postRecoFeedbackWithToast = (
		card: Extract<Card, { kind: "reco" }>,
		action: "accept" | "edit" | "dismiss",
	): Promise<true | string> =>
		withToast("reco.feedback", "Posting your feedback…", "Feedback posted", () => postRecoFeedback(card, action));

	const acceptRecommendation = async (cardId?: string): Promise<string | void> => {
		const card = recoCard(cardId);
		const recommendation = card?.payload.recommendation;
		if (card === undefined || recommendation === null || recommendation === undefined) {
			return "There is no current recommendation to accept.";
		}
		if (card.status === "acted") return "That recommendation was already answered.";
		if ((await postRecoFeedbackWithToast(card, "accept")) !== true) return undefined;
		store.dispatch({ type: "card.updated", actor: commandActor, id: card.id, patch: { status: "acted" } });
		// Accept runs the recommendation's affordance: the proposed work starts
		// as an ordinary turn through the same send path as everything else.
		send(recommendation.proposes);
		return undefined;
	};

	const editRecommendation = async (cardId?: string): Promise<string | void> => {
		const card = recoCard(cardId);
		const recommendation = card?.payload.recommendation;
		if (card === undefined || recommendation === null || recommendation === undefined) {
			return "There is no current recommendation to edit.";
		}
		if (card.status === "acted") return "That recommendation was already answered.";
		if ((await postRecoFeedbackWithToast(card, "edit")) !== true) return undefined;
		store.dispatch({ type: "card.updated", actor: commandActor, id: card.id, patch: { status: "acted" } });
		// Edit opens the composer prefilled with the proposal, ready to reshape.
		store.dispatch({
			type: "composer.control.changed",
			actor: "system",
			owner: "user",
			draft: recommendation.proposes,
		});
		return undefined;
	};

	const dismissRecommendation = async (cardId?: string): Promise<string | void> => {
		const card = recoCard(cardId);
		if (card === undefined || card.payload.recommendation === null) {
			return "There is no current recommendation to dismiss.";
		}
		if (card.status === "acted") return "That recommendation was already answered.";
		if ((await postRecoFeedbackWithToast(card, "dismiss")) !== true) return undefined;
		// Dismiss removes the card without argument.
		store.dispatch({ type: "card.removed", actor: commandActor, id: card.id });
		return undefined;
	};

	const refreshRecommendation = async (): Promise<string | void> => {
		await loadFirstRunReco(true);
		return undefined;
	};

	/*
	 * The admin plugin's controller half. Every read and write goes through the
	 * product Worker's /api/admin/* routes, which re-validate the session and
	 * answer 404-never-403 to non-admins; a 404 here therefore means "not an
	 * admin (or not configured)" and is surfaced as an honest line.
	 */
	const adminAllowlistImpl = async (action: "add" | "remove", login: string): Promise<true | string> => {
		try {
			const response = await http(`${baseUrl}${ADMIN_ALLOWLIST_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ login, action }),
			});
			if (!response.ok) {
				const message = await errorMessageOf(response, "The allowlist change didn't go through.");
				store.dispatch({ type: "message.appended", actor: "system", text: message });
				return message;
			}
			const echo = (await response.json().catch(() => undefined)) as
				| { applied?: unknown; duplicate?: unknown }
				| undefined;
			const verb = action === "add" ? "added to" : "removed from";
			store.dispatch({
				type: "message.appended",
				actor: "system",
				text:
					echo?.duplicate === true
						? `${login} was already ${action === "add" ? "on" : "off"} the allowlist — nothing changed.`
						: `${login} ${verb} the allowlist, recorded under your name.`,
			});
		} catch {
			const message = "The allowlist change didn't go through — the admin route didn't answer.";
			store.dispatch({ type: "message.appended", actor: "system", text: message });
			return message;
		}
		return true;
	};

	const adminAllowlist = (action: "add" | "remove", login: string): Promise<string | void> =>
		withToast("admin.allowlist", "Updating the allowlist…", "Allowlist updated", () => adminAllowlistImpl(action, login)).then(
			() => undefined,
		);

	const adminGrant = (amountUsd: number, login: string): string | void => {
		// Never post directly: the confirmation card states exactly what will happen first.
		const card: Card = {
			id: `grant-${crypto.randomUUID()}`,
			kind: "grant-confirm",
			title: `Grant $${amountUsd} to ${login}?`,
			status: "active",
			createdAt: Date.now(),
			ordinal: nextTranscriptOrdinal(),
			payload: { login, amountUsd, phase: "confirm" },
		};
		store.dispatch({ type: "card.upsert", actor: commandActor, card });
		return undefined;
	};

	const adminGrantConfirm = async (cardId: string): Promise<string | void> => {
		const card = store.collections.cards.get(cardId);
		if (card === undefined || card.kind !== "grant-confirm") return "That grant confirmation is gone.";
		if (card.payload.phase === "granted") return "That grant was already posted.";
		if (card.payload.phase === "sending") return undefined;
		const { login, amountUsd } = card.payload;
		store.dispatch({
			type: "card.updated",
			actor: commandActor,
			id: card.id,
			patch: { payload: { login, amountUsd, phase: "sending" } },
		});
		await withToast("admin.grant", `Granting $${amountUsd} to ${login}…`, `Granted $${amountUsd} to ${login}`, async () => {
			try {
				const response = await http(`${baseUrl}${ADMIN_GRANT_PATH}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ login, amountUsd }),
				});
				if (!response.ok) {
					const message = await errorMessageOf(response, "The grant didn't go through.");
					store.dispatch({
						type: "card.updated",
						actor: "system",
						id: card.id,
						patch: { status: "error", payload: { login, amountUsd, phase: "failed", error: message } },
					});
					return message;
				}
				const echo = (await response.json().catch(() => undefined)) as
					| { grantId?: unknown; duplicate?: unknown }
					| undefined;
				store.dispatch({
					type: "card.updated",
					actor: "system",
					id: card.id,
					patch: {
						status: "acted",
						payload: {
							login,
							amountUsd,
							phase: "granted",
							...(typeof echo?.grantId === "string" ? { grantId: echo.grantId } : {}),
						},
					},
				});
			} catch {
				const message = "The grant didn't go through — the admin route didn't answer.";
				store.dispatch({
					type: "card.updated",
					actor: "system",
					id: card.id,
					patch: { status: "error", payload: { login, amountUsd, phase: "failed", error: message } },
				});
				return message;
			}
			return true;
		});
		return undefined;
	};

	const adminGrantCancel = (cardId: string): string | void => {
		const card = store.collections.cards.get(cardId);
		if (card === undefined || card.kind !== "grant-confirm") return "That grant confirmation is gone.";
		if (card.payload.phase === "sending") return "That grant is already being posted — a moment.";
		store.dispatch({ type: "card.removed", actor: commandActor, id: card.id });
		return undefined;
	};

	const ADMIN_REQUESTS_CARD_ID = "admin-requests";

	/** Re-read the queue and refresh the queue card (also the post-approve refresh). */
	const adminRequestsImpl = async (): Promise<true | string> => {
		try {
			const response = await http(`${baseUrl}${ADMIN_REQUESTS_PATH}`);
			if (!response.ok) {
				const message = await errorMessageOf(response, "The request queue didn't answer.");
				store.dispatch({ type: "message.appended", actor: "system", text: message });
				return message;
			}
			const body = (await response.json().catch(() => undefined)) as
				| { requests?: Array<{ login?: unknown; note?: unknown; createdAt?: unknown }> }
				| undefined;
			const requests = (Array.isArray(body?.requests) ? body.requests : [])
				.filter((row) => typeof row.login === "string")
				.map((row) => ({
					login: row.login as string,
					note: typeof row.note === "string" ? row.note : null,
					createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
				}));
			const existing = store.collections.cards.get(ADMIN_REQUESTS_CARD_ID);
			const card: Card = {
				id: ADMIN_REQUESTS_CARD_ID,
				kind: "request-queue",
				title: `Request-access queue — ${requests.length} waiting`,
				status: "active",
				createdAt: existing?.createdAt ?? Date.now(),
				ordinal: nextTranscriptOrdinal(),
				payload: { requests, approving: null },
			};
			store.dispatch({ type: "card.upsert", actor: "system", card });
		} catch {
			const message = "The request queue didn't answer — the admin route is unreachable.";
			store.dispatch({ type: "message.appended", actor: "system", text: message });
			return message;
		}
		return true;
	};

	const adminRequests = (): Promise<string | void> =>
		withToast("admin.requests", "Reading the request queue…", "Request queue read", adminRequestsImpl).then(() => undefined);

	const adminQueueApprove = async (login: string): Promise<string | void> => {
		const card = store.collections.cards.get(ADMIN_REQUESTS_CARD_ID);
		if (card !== undefined && card.kind === "request-queue") {
			store.dispatch({
				type: "card.updated",
				actor: commandActor,
				id: card.id,
				patch: { payload: { ...card.payload, approving: login, error: undefined } },
			});
		}
		const post = await withToast("admin.queue.approve", `Approving ${login}…`, `${login} approved`, async () => {
			try {
				const response = await http(`${baseUrl}${ADMIN_ALLOWLIST_PATH}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ login, action: "add" }),
				});
				if (!response.ok) {
					const message = await errorMessageOf(response, `Approving ${login} didn't go through.`);
					const current = store.collections.cards.get(ADMIN_REQUESTS_CARD_ID);
					if (current !== undefined && current.kind === "request-queue") {
						store.dispatch({
							type: "card.updated",
							actor: "system",
							id: current.id,
							patch: { status: "error", payload: { ...current.payload, approving: null, error: message } },
						});
					}
					return message;
				}
			} catch {
				const message = `Approving ${login} didn't go through — the admin route didn't answer.`;
				const current = store.collections.cards.get(ADMIN_REQUESTS_CARD_ID);
				if (current !== undefined && current.kind === "request-queue") {
					store.dispatch({
						type: "card.updated",
						actor: "system",
						id: current.id,
						patch: { status: "error", payload: { ...current.payload, approving: null, error: message } },
					});
				}
				return message;
			}
			return true;
		});
		if (post !== true) return undefined;
		// The queue card re-reads from the server — never from local optimism.
		await adminRequests();
		return undefined;
	};

	const adminFeedbackImpl = async (): Promise<true | string> => {
		try {
			const response = await http(`${baseUrl}${ADMIN_FEEDBACK_PATH}`);
			if (!response.ok) {
				const message = await errorMessageOf(response, "The feedback log didn't answer.");
				store.dispatch({ type: "message.appended", actor: "system", text: message });
				return message;
			}
			const body = (await response.json().catch(() => undefined)) as
				| {
						all?: Array<{
							login?: unknown;
							entries?: Array<{ at?: unknown; action?: unknown; recommendationId?: unknown }>;
						}>;
				  }
				| undefined;
			const sections = (Array.isArray(body?.all) ? body.all : [])
				.filter((section) => typeof section.login === "string")
				.map((section) => ({
					login: section.login as string,
					entries: (Array.isArray(section.entries) ? section.entries : [])
						.filter(
							(entry) =>
								typeof entry.at === "string" &&
								(entry.action === "accept" || entry.action === "edit" || entry.action === "dismiss") &&
								typeof entry.recommendationId === "string",
						)
						.map((entry) => ({
							at: entry.at as string,
							action: entry.action as "accept" | "edit" | "dismiss",
							recommendationId: entry.recommendationId as string,
						})),
				}));
			const existing = store.collections.cards.get("admin-reco-log");
			const total = sections.reduce((count, section) => count + section.entries.length, 0);
			const card: Card = {
				id: "admin-reco-log",
				kind: "reco-log",
				title: `Recommendation feedback — ${total} event${total === 1 ? "" : "s"}`,
				status: "active",
				createdAt: existing?.createdAt ?? Date.now(),
				ordinal: nextTranscriptOrdinal(),
				payload: { sections },
			};
			store.dispatch({ type: "card.upsert", actor: "system", card });
		} catch {
			const message = "The feedback log didn't answer — the admin route is unreachable.";
			store.dispatch({ type: "message.appended", actor: "system", text: message });
			return message;
		}
		return true;
	};

	const adminFeedback = (): Promise<string | void> =>
		withToast("admin.feedback", "Reading the feedback log…", "Feedback log read", adminFeedbackImpl).then(() => undefined);

	const adminHealthImpl = async (): Promise<true | string> => {
		try {
			const response = await http(`${baseUrl}${ADMIN_HEALTH_PATH}`);
			if (!response.ok) {
				const message = await errorMessageOf(response, "The health read didn't answer.");
				store.dispatch({ type: "message.appended", actor: "system", text: message });
				return message;
			}
			const body = (await response.json().catch(() => undefined)) as
				| {
						services?: Array<{ name?: unknown; status?: unknown; detail?: unknown }>;
						charges?: { chargeCount?: unknown; lifetimeChargedUsd?: unknown } | null;
						queueDepth?: unknown;
						checkedAt?: unknown;
				  }
				| undefined;
			if (!Array.isArray(body?.services)) {
				const message = "The health read answered in a shape I didn't understand.";
				store.dispatch({ type: "message.appended", actor: "system", text: message });
				return message;
			}
			const services = body.services
				.filter(
					(service) =>
						typeof service.name === "string" &&
						(service.status === "ok" || service.status === "failed" || service.status === "unconfigured") &&
						typeof service.detail === "string",
				)
				.map((service) => ({
					name: service.name as string,
					status: service.status as "ok" | "failed" | "unconfigured",
					detail: service.detail as string,
				}));
			const charges =
				body.charges !== null &&
				body.charges !== undefined &&
				typeof body.charges.chargeCount === "number" &&
				typeof body.charges.lifetimeChargedUsd === "string"
					? { chargeCount: body.charges.chargeCount, lifetimeChargedUsd: body.charges.lifetimeChargedUsd }
					: null;
			const existing = store.collections.cards.get("admin-health");
			const card: Card = {
				id: "admin-health",
				kind: "admin-health",
				title: "What failed overnight?",
				status: services.some((service) => service.status === "failed") ? "error" : "active",
				createdAt: existing?.createdAt ?? Date.now(),
				ordinal: nextTranscriptOrdinal(),
				payload: {
					services,
					queueDepth: typeof body.queueDepth === "number" ? body.queueDepth : null,
					charges,
					checkedAt: typeof body.checkedAt === "string" ? body.checkedAt : new Date().toISOString(),
				},
			};
			store.dispatch({ type: "card.upsert", actor: "system", card });
		} catch {
			const message = "The health read didn't answer — the admin route is unreachable.";
			store.dispatch({ type: "message.appended", actor: "system", text: message });
			return message;
		}
		return true;
	};

	const adminHealth = (): Promise<string | void> =>
		withToast("admin.health", "Reading service health…", "Service health read", adminHealthImpl).then(() => undefined);

	/*
	 * Chat is complimentary during the alpha: the billing seam records each
	 * turn's true cost and debits zero, so the UI carries NO per-turn dollar
	 * line. The balance chip still refreshes from the real answer after a turn.
	 */
	const settleTurnBilling = (): void => {
		void refreshBalance();
	};

	const handleCardFrame = (frame: Extract<AgentTurnFrame, { type: "card" | "card.update" }>): void => {
		if (frame.type === "card") {
			store.dispatch({ type: "card.upsert", actor: "smithers", card: frame.card });
			return;
		}
		const patch = CardPatchSchema.safeParse(frame.patch);
		const existing = store.collections.cards.get(frame.id);
		if (!patch.success || existing === undefined) {
			console.warn("Smithers dropped a card.update frame for an unknown or invalid card", frame.id);
			return;
		}
		const merged = CardSchema.safeParse({ ...existing, ...patch.data, id: existing.id });
		if (!merged.success) {
			console.warn("Smithers dropped a card.update frame that fails schema", merged.error);
			return;
		}
		store.dispatch({ type: "card.updated", actor: "smithers", id: frame.id, patch: patch.data });
	};

	/** The transcript as the chat contract reads it: no tool-act lines, no empty bubbles. */
	const contextMessages = (): ReadonlyArray<AgentChatMessage> =>
		store
			.agentContextSnapshot()
			.messages.filter((message) => message.act === undefined && message.text.trim() !== "")
			.map((message) => ({
				role: message.role === "user" ? ("user" as const) : ("assistant" as const),
				content: message.text,
			}));

	/*
	 * The hidden runtime context, freshly derived from live collections on EVERY
	 * turn leg (never cached): the server boundary renders it into the upstream
	 * instructions, so the model truthfully knows it runs inside the Smithers
	 * product. It is never dispatched, so it never enters the persisted visible
	 * transcript; it carries no secrets (only state the client already holds).
	 */
	/*
	 * The shared context contract (apps/shared/src/AgentContext.ts) names three
	 * surfaces, and the GitHub and Files panes arrived after it. Both embed in
	 * the chat shell — the transcript and composer stay visible beside them —
	 * so the contract value for either is the shell that hosts them. Widening
	 * the shared enum so the model can name the pane it is looking at is a
	 * change to apps/shared, outside this change's reach.
	 */
	const contextSurface = (surface: Session["surface"]): AgentRuntimeContext["surface"] =>
		surface === "world" || surface === "connectors" ? surface : "chat";

	const agentRuntimeContext = (): AgentRuntimeContext => {
		const snapshot = store.agentContextSnapshot();
		const current = store.session();
		const identity = store.collections.identitySessions.get("identity");
		const watched = store.collections.watchedRepos.get("watched");
		const selected =
			current.selectedWorldDocumentId === null
				? undefined
				: store.collections.worldDocuments.get(current.selectedWorldDocumentId);
		return {
			version: AGENT_RUNTIME_CONTEXT_VERSION,
			product: "smithers",
			capturedAt: snapshot.capturedAt,
			revision: snapshot.revision,
			surface: contextSurface(current.surface),
			theme: current.theme,
			selectedWorldDocument: selected?.path ?? null,
			connectors: snapshot.connectors.map((connector) => ({
				kind: connector.kind,
				name: connector.name,
				status: connector.status,
				access: connector.access,
				root: connector.root,
				branch: connector.branch,
			})),
			/*
			 * Sign-in IS the GitHub connector (§2a′): connection truth derives
			 * from the validated session + the watched-repos selection, never
			 * from the legacy local-connector store.
			 */
			github: {
				connected: identity?.state === "signed-in",
				login: identity?.state === "signed-in" ? identity.login : null,
				watchedRepos:
					identity?.state !== "signed-in"
						? null
						: watched === undefined || watched.selected === null
							? "unselected"
							: watched.selected.length,
				/*
				 * §22.7: a COUNT left the model declining to answer "what repos do
				 * you watch?" while the names were served plainly by the seam it
				 * was already reading.
				 */
				...(identity?.state === "signed-in" && watched?.selected != null
					? { watchedRepoNames: [...watched.selected] }
					: {}),
			},
			/*
			 * §22.7 wanted the balance in here — the client holds it, the model
			 * did not, and asked for it the model answered "$0.00" one line above
			 * a card its own tool call had just rendered reading "$519 left". The
			 * shared context contract has no billing field, and the server renders
			 * only what that contract declares, so a balance sent from here is
			 * dropped on the way. Widening it is a change to apps/shared, outside
			 * this change's reach; /billing.balance still answers the question.
			 */
			worldState: {
				documentCount: snapshot.worldState.documents.length,
				documents: snapshot.worldState.documents.map((document) => ({
					path: document.path,
					title: document.title,
					confidence: document.confidence,
				})),
			},
			capabilities: [
				"Hold a streaming conversation in this chat and read its visible transcript.",
				'Run app commands through the "commands" tool — the same code path as the UI buttons and slash commands.',
				"Render structured cards (plans, approvals, statuses, recommendations) in the transcript.",
				"Create, list, and run Smithers workflows on the user's watched repositories (flow.create, flow.list, flow.run) — runs report live as embedded cards in this chat.",
				...(repositories.available
					? ["Connect a local repository the user picks in the native picker."]
					: []),
			],
			limitations: [
				"Cannot see or control the host environment beyond what this context block states.",
				"Workflow runs execute on the user's workspace gateway; any outbound act a run wants (pushes, PRs) pauses for the human's explicit approval — never promise one landed without it.",
				repositories.available
					? "Can only touch repositories the user explicitly connected, listed above."
					: "This pure-web client cannot connect local repositories (the native app can); none are connected unless listed above.",
			],
		};
	};

	/*
	 * Wave 13 §F: the system prompt's capability section is GENERATED per turn
	 * from the live command catalog and connector state — the one source of
	 * truth — so the model's offers are bounded by what actually exists, and a
	 * workflow is never presented as laundering an effect the catalog lacks.
	 */
	const turnInstructions = (): string => {
		const identity = store.collections.identitySessions.get("identity");
		const watched = store.collections.watchedRepos.get("watched");
		const signedIn = identity?.state === "signed-in";
		return smithersInstructions(agentVisibleCatalog(commands.callable()), {
			github: {
				connected: signedIn,
				login: signedIn ? identity.login : null,
				watchedRepos: !signedIn ? null : watched === undefined || watched.selected === null ? "unselected" : watched.selected.length,
			},
			localRepositories: [...store.collections.connectors.values()].map((connector) => connector.name),
			localRepositoriesAvailable: repositories.available,
		});
	};

	const launchLeg = (turnId: string, messages: ReadonlyArray<AgentChatMessage>): void => {
		void agent
			.startTurn({
				runId: turnId,
				messages,
				instructions: turnInstructions(),
				tools: commands.toolSpecs(),
				context: agentRuntimeContext(),
			})
			.then((result) => {
				if (result.status !== "error" || activeTurn?.id !== turnId) return;
				const turn = activeTurn;
				activeTurn = undefined;
				// §1: a leg that never started still ends a turn that launched a
				// run, and a claim streamed before the launch is already on screen.
				settleRunClaims(turn);
				store.dispatch({
					type: "message.response.failed",
					actor: "system",
					turnId,
					message: result.message,
				});
				settleTurnBilling();
			})
			.catch(() => {
				if (activeTurn?.id !== turnId) return;
				const turn = activeTurn;
				activeTurn = undefined;
				settleRunClaims(turn);
				store.dispatch({
					type: "message.response.failed",
					actor: "system",
					turnId,
					message: "The native Smithers Cloud connection stopped responding.",
				});
				settleTurnBilling();
			});
	};

	/*
	 * The visible one-line record of a tool act (§2b transcript hygiene): at
	 * most a compact Smithers-side line, actor smithers — the raw arguments or
	 * result payload (the commands list's JSON, the browser read's text) NEVER
	 * enters the conversation. The full-fidelity record lives in the toolCalls
	 * collection for the admin dev-tools panel.
	 */
	/** The proposal channel, whichever spelling the model reached it by. */
	const isSuggestionCall = (name: string, args: string): boolean => {
		if (name.replace(/^\/+/, "") === SUGGESTIONS_FLOW) return true;
		try {
			const parsed: unknown = JSON.parse(args);
			return (
				typeof parsed === "object" &&
				parsed !== null &&
				"name" in parsed &&
				typeof parsed.name === "string" &&
				parsed.name.replace(/^\/+/, "") === SUGGESTIONS_FLOW
			);
		} catch {
			return false;
		}
	};

	/*
	 * What the act row opens up to (will, 2026-08-19): "This is cool but I can't
	 * click on it or hover to see more".
	 *
	 * The flow the model actually called, the arguments it passed, and one short
	 * line of what came back. Every part goes through the scrub, so a payload is
	 * NAMED rather than pasted and the whole detail is bounded — the visible line
	 * above it is untouched, and the full record stays in the dev-tools panel.
	 */
	const toolActDetail = (call: PendingToolCall, result: string): string | undefined => {
		let flow = call.name;
		let args = "";
		try {
			const parsed: unknown = JSON.parse(call.args);
			if (typeof parsed === "object" && parsed !== null) {
				if ("name" in parsed && typeof parsed.name === "string") flow = parsed.name.replace(/^\/+/, "");
				if ("args" in parsed && typeof parsed.args === "string") args = parsed.args;
				if (args === "" && "action" in parsed && typeof parsed.action === "string") args = parsed.action;
			}
		} catch {
			// The raw arguments are the honest source when they do not parse.
			args = call.args;
		}
		/*
		 * "executed /issues.list" is the registry's own acknowledgement, and the
		 * visible line above already says the flow ran — repeating it as the
		 * result would fill the row with what the reader can see.
		 */
		const answered = result.split("\n")[0] ?? "";
		const said = answered.trim() === `executed /${flow}` ? "" : answered;
		return actDetail([`/${flow}`, actDetailField(args), actDetailField(said)]);
	};

	const toolActLine = (call: PendingToolCall, result: string): string => {
		let inner = call.name;
		let action: string | undefined;
		let args: string | undefined;
		try {
			const parsed: unknown = JSON.parse(call.args);
			if (typeof parsed === "object" && parsed !== null) {
				// The model may spell the name "/browser" (the catalog's own
				// dialect, normalized at the agent boundary too) — stripped here
				// so the label renders /browser, never //browser.
				if ("name" in parsed && typeof parsed.name === "string") inner = parsed.name.replace(/^\/+/, "");
				if ("action" in parsed && typeof parsed.action === "string") action = parsed.action;
				if ("args" in parsed && typeof parsed.args === "string") args = parsed.args;
			}
		} catch {
			// The raw tool name is the honest label when the arguments don't parse.
		}
		if (call.name === "commands" && action === "list") return "Smithers checked what it can do here";
		if (call.name === "commands" && inner === "browser" && !result.startsWith("failed:") && !result.startsWith("unknown-")) {
			let host = args ?? "";
			try {
				host = new URL(args ?? "").host;
			} catch {
				// Keep the raw args as the host label.
			}
			return `Smithers read ${host}`;
		}
		/*
		 * Wave 12 §1: the act line for a launch is deterministic too — it names
		 * the run the client actually started, from the machine acknowledgment,
		 * never from the model's wording.
		 */
		const launched = runLaunchCommandOf(call.name, call.args);
		if (launched !== undefined && toolResultLaunchedRun(result)) {
			const workflow = /\bworkflow=(\S+)/.exec(result)?.[1] ?? inner;
			const repo = /\brepo=(\S+)/.exec(result)?.[1];
			return `Smithers started a ${workflow} run${repo === undefined ? "" : ` on ${repo}`}`;
		}
		const label = call.name === "commands" ? `/${inner}` : call.name;
		if (result.startsWith("executed /") || (!result.startsWith("failed:") && !result.startsWith("unknown-"))) {
			return `Smithers ran ${label}`;
		}
		// The honest failure, one line, payload-free: an error string that
		// still looks like raw JSON never reaches the transcript.
		const clean = result.trim().startsWith("{") || result.trim().startsWith("[") ? "that didn't work" : result;
		return `Smithers tried ${label} — ${clean.replace(/\s+/g, " ").slice(0, 160)}`;
	};

	/*
	 * One tool-loop leg: execute the model's call through the registry (the
	 * same path as buttons and slash, actor smithers), render the act line,
	 * then POST the continuation turn with the tool-role result appended.
	 */
	const continueToolLeg = async (turn: ActiveTurn): Promise<void> => {
		const call = turn.pendingCall;
		if (call === undefined) return;
		turn.pendingCall = undefined;
		turn.toolLegs += 1;
		// executeForAgent runs as actor smithers (withAgentActor) — the same
		// dispatch path as buttons and slash, with the agent attribution.
		const result = await commands.executeForAgent({ name: call.name, arguments: call.args });
		if (activeTurn?.id !== turn.id) return;
		/*
		 * Wave 12 §1: a real launch arms the deterministic claim surface for the
		 * rest of this turn. A refusal or a chooser route launched nothing, so
		 * there is no run for the model to misdescribe and its prose stands.
		 */
		const launched = runLaunchCommandOf(call.name, call.args);
		if (launched !== undefined && toolResultLaunchedRun(result)) turn.runLaunch = launched;
		store.dispatch({
			type: "toolcall.recorded",
			actor: "smithers",
			turnId: turn.id,
			name: call.name,
			arguments: call.args,
			result,
		});
		/*
		 * The follow-up channel is not an ACT: the pills it proposes are the
		 * whole of what it does, and they are already on screen. A marker row
		 * saying Smithers ran it would narrate the furniture.
		 */
		if (!isSuggestionCall(call.name, call.args)) {
			const detail = toolActDetail(call, result);
			store.dispatch({
				type: "message.tool.executed",
				actor: "smithers",
				turnId: turn.id,
				text: toolActLine(call, result),
				...(detail === undefined ? {} : { detail }),
			});
		}
		turn.toolItems.push(
			{ type: "function_call", call_id: call.callId, name: call.name, arguments: call.args },
			{ type: "function_call_output", call_id: call.callId, output: result },
		);
		launchLeg(turn.id, [...contextMessages(), ...turn.toolItems]);
	};

	/*
	 * Wave 12 §1 — the claim surface settles deterministically.
	 *
	 * A turn that launched a run renders the model's whole answer only when it
	 * claims nothing about run state; otherwise the client's own line stands in
	 * its place. The check reads the WHOLE answer (anything streamed before the
	 * tool call plus everything withheld after it) because a preamble and a
	 * continuation land in one bubble — half-suppressing a claim still ships it.
	 */
	const settleRunClaims = (turn: ActiveTurn): void => {
		const command = turn.runLaunch;
		const askClass = turn.askClass;
		if (command === undefined && askClass === undefined) return;
		const buffered = turn.claimBuffer;
		turn.claimBuffer = "";
		turn.runLaunch = undefined;
		turn.askClass = undefined;
		const streamed = store.collections.messages.get(`message-${turn.id}-smithers`)?.text ?? "";
		const whole = `${streamed}${buffered}`;
		if (whole.trim() === "") {
			/*
			 * Nothing renderable was withheld, so nothing is substituted — but the
			 * turn must still settle. `message.response.completed` no-ops when no
			 * answer message exists, and the session's phase would have stayed
			 * `responding` forever with the composer refusing every submit: held-
			 * back whitespace bricked the chat. Report it as what it was, through
			 * the empty-response path that already exists for exactly this.
			 */
			turn.receivedText = false;
			return;
		}
		/*
		 * Wave 13c: an ask-classed turn that launched nothing still answers
		 * honestly — the class's deterministic line when the model offered the
		 * impossible act, its own words otherwise (an unoffered answer flushes
		 * verbatim through the same substitution that would have replaced it).
		 */
		const text =
			command !== undefined
				? renderedRunTurnText(command, whole)
				: renderedAskTurnText(askClass as ImpossibleAskClass, whole);
		store.dispatch({
			type: "message.claim.substituted",
			actor: "system",
			turnId: turn.id,
			text,
		});
	};

	agent.subscribe((frame: AgentTurnFrame) => {
		if (frame.runId !== activeTurn?.id) return;
		if (frame.type === "card" || frame.type === "card.update") {
			handleCardFrame(frame);
			return;
		}
		if (frame.type === "tool_call") {
			// The model asked for a command; the done frame right after it ends
			// this leg, and the continuation is driven from there.
			activeTurn.pendingCall = { callId: frame.call_id, name: frame.name, args: frame.arguments };
			return;
		}
		if (frame.type === "delta") {
			if (frame.text === "") return;
			if (frame.kind === "text") {
				activeTurn.receivedText = true;
				/*
				 * Wave 12 §1: after a run launch the model's words are held until
				 * the turn settles, so a claim is never rendered even for the beat
				 * it would take to stream. Reasoning is unaffected — it is not the
				 * answer, and the substitution replaces the answer.
				 * Wave 13c: the same hold applies when the user's ask named an
				 * impossible class — the offer is reviewed before it renders.
				 */
				if (activeTurn.runLaunch !== undefined || activeTurn.askClass !== undefined) {
					activeTurn.claimBuffer += frame.text;
					return;
				}
			}
			store.dispatch({
				type: "message.response.delta",
				actor: "smithers",
				turnId: frame.runId,
				channel: frame.kind,
				delta: frame.text,
			});
			return;
		}
		/*
		 * Chain frames (DESIGN.md §14). A settled command call renders the same
		 * one-line act row the tool loop rendered — the harness's own doors
		 * (author, say, cards, sys/*) are not user-facing acts. A gate
		 * rejection is visible, payload-free, and in-character (§9: no
		 * flow/run jargon) — never an error bubble, because the next link
		 * corrects it. The remaining chain frames (link.*, steering.drained,
		 * park, call.started) are journal evidence: debug mode renders them;
		 * the transcript does not.
		 */
		if (frame.type === "link.authored") {
			// A chain turn that ends without prose is still a worked turn: the
			// authored link is the proof, so the empty-response failure branch
			// below never applies to a chain turn.
			activeTurn.receivedText = true;
			return;
		}
		if (frame.type === "call.settled") {
			// Wave 12 parity: a settled launch call arms the deterministic claim
			// surface exactly as the tool loop did, so the model's prose about
			// the run substitutes at settle instead of rendering as a claim.
			if (RUN_LAUNCH_COMMANDS.includes(frame.name)) {
				activeTurn.runLaunch = frame.name;
			}
			if (!CHAIN_SURFACE_CALLS.has(frame.name) && !frame.name.startsWith("sys/")) {
				const detail = actDetail([
					`/${frame.name}`,
					// The chain's own vocabulary for how the call resolved.
					frame.verdict === "run" ? "" : frame.verdict === "hit" ? "answered from cache" : "replayed",
					actDetailField(frame.resultDigest ?? ""),
				]);
				store.dispatch({
					type: "message.tool.executed",
					actor: "smithers",
					turnId: frame.runId,
					text: `Smithers ran /${frame.name}`,
					...(detail === undefined ? {} : { detail }),
				});
			}
			return;
		}
		if (frame.type === "park") {
			// Approval parks explain themselves through the approval card; every
			// other park states the pause honestly instead of settling silently.
			if (frame.code !== "approval") {
				store.dispatch({
					type: "message.appended",
					actor: "system",
					text:
						frame.code === "quota"
							? "Smithers paused — this turn ran out of budget."
							: "Smithers paused — it is waiting on something outside this chat.",
				});
			}
			return;
		}
		if (frame.type === "gate.rejected") {
			// Why it changed course, in the gate's own vocabulary — never jargon
			// in the visible line, but the detail may name the reason plainly.
			const detail = actDetail([GATE_REASONS[frame.kind], actDetailField(frame.message ?? "")]);
			store.dispatch({
				type: "message.tool.executed",
				actor: "smithers",
				turnId: frame.runId,
				text: "Smithers adjusted its approach",
				...(detail === undefined ? {} : { detail }),
			});
			return;
		}
		if (frame.type === "steering.drained") {
			store.dispatch({
				type: "message.tool.executed",
				actor: "smithers",
				turnId: frame.runId,
				text: "Smithers picked up your note",
				detail: `read ${frame.count} note${frame.count === 1 ? "" : "s"} you sent mid-turn`,
			});
			return;
		}
		if (frame.type !== "done") return;
		const turn = activeTurn;
		// A kill outranks a pending tool call: the terminal frame the Worker
		// injects for a server-side kill can land between the model's
		// `tool_call` frame and the upstream's own `done`. Continuing there
		// would run the tool and re-POST a continuation leg — the killed turn
		// would quietly carry on, which is exactly what B-3 forbids.
		if (
			frame.error === undefined &&
			frame.reason !== "cancelled" &&
			turn.pendingCall !== undefined
		) {
			if (turn.toolLegs >= MAX_TOOL_LEGS) {
				activeTurn = undefined;
				settleRunClaims(turn);
				store.dispatch({
					type: "message.response.failed",
					actor: "system",
					turnId: turn.id,
					message: `I hit the tool-call limit for this turn (${MAX_TOOL_LEGS}) — stopping here instead of looping.`,
				});
				settleTurnBilling();
				return;
			}
			void continueToolLeg(turn);
			return;
		}
		activeTurn = undefined;
		settleRunClaims(turn);
		if (frame.error !== undefined) {
			store.dispatch({
				type: "message.response.failed",
				actor: "system",
				turnId: turn.id,
				message: frame.error,
			});
		} else if (frame.reason === "cancelled") {
			// A server-side kill ended the stream with the honest terminal frame —
			// render it interrupted (partial text kept), never a silent stop.
			store.dispatch({
				type: "message.response.cancelled",
				actor: "system",
				turnId: turn.id,
				detail: "That turn was stopped by the server.",
			});
		} else if (frame.reason === "tool_limit") {
			// The server-side cap answered honestly; surface it the same way.
			store.dispatch({
				type: "message.response.failed",
				actor: "system",
				turnId: turn.id,
				message: "Smithers Cloud stopped this turn at its tool-call limit.",
			});
		} else if (!turn.receivedText) {
			store.dispatch({
				type: "message.response.failed",
				actor: "system",
				turnId: turn.id,
				message: "Smithers Cloud returned an empty response.",
			});
		} else {
			store.dispatch({
				type: "message.response.completed",
				actor: "smithers",
				turnId: turn.id,
			});
		}
		settleTurnBilling();
	});

	/*
	 * A failed flow has no channel of its own to answer into — dropping the
	 * outcome reads as a silent no-op (the "did it even run?" bug). Every
	 * invocation the human makes — a pointer press OR a name typed into the
	 * composer — states its refusal as a toast; executes that render their own
	 * error UI return void and never reach this. The zero-balance refusal is
	 * the one exception: `zeroBalanceGuard` already dispatched it as an
	 * embedded transcript message, so toasting it too would double-surface the
	 * same refusal.
	 */
	const surfaceCommandFailure = (name: string, outcome: CommandOutcome): void => {
		if (outcome.status !== "failed") return;
		if (outcome.error === ZERO_BALANCE_EXHAUSTED_TEXT) return;
		const key = `command.failed.${name}`;
		store.dispatch({ type: "toast.shown", actor: "system", key, title: `/${name} didn't run` });
		store.dispatch({ type: "toast.resolved", actor: "system", key, status: "failed", detail: outcome.error });
	};

	const send = (text: string): void => {
		const parsed = parseSubmit(text, commands.all());
		if (parsed.kind === "empty") return;
		if (parsed.kind === "unknown-command") {
			/*
			 * §23.5: a name the app does not have used to go to the model as
			 * prose, and the model reached for whatever flow it COULD see — so
			 * `/reset` on a non-admin session ran `retry`. The app answers for
			 * its own registry.
			 */
			store.dispatch({ type: "composer.changed", actor: "user", draft: "" });
			surfaceCommandFailure(parsed.name, {
				status: "failed",
				error: `There is no /${parsed.name} flow. Type / to see everything Smithers can do.`,
			});
			return;
		}
		if (parsed.kind === "command") {
			/*
			 * A bare /name is a command invocation, never a prompt for the agent.
			 * The outcome is surfaced exactly as the pointer path surfaces it:
			 * a flow the human typed and that refused must SAY so — dropping the
			 * outcome here is what made `/name <args>` silent while bare `/name`
			 * (which the slash menu routes through the pointer path) was honest.
			 */
			store.dispatch({ type: "composer.changed", actor: "user", draft: "" });
			void commands
				.run(parsed.name, parsed.args)
				.then((outcome) => surfaceCommandFailure(parsed.name, outcome));
			return;
		}
		const prompt = parsed.text;
		if (store.session().phase !== "idle") {
			/*
			 * Mid-turn input steers a steerable turn (DESIGN.md §14): the words
			 * render as the user's own bubble now, and the running chain drains
			 * them at its next link boundary. A backend without steering (the
			 * proxy) keeps today's behavior — the input is not eaten, it stays
			 * in the composer.
			 */
			const turn = activeTurn;
			if (turn !== undefined && agent.steer !== undefined) {
				// Wave 13c holds apply to steered asks too: an impossible ask
				// admitted mid-turn arms the same review the opening prompt gets.
				const steeredAsk = impossibleAskOf(prompt);
				if (steeredAsk !== undefined && turn.askClass === undefined) {
					turn.askClass = steeredAsk;
				}
				void agent.steer(turn.id, prompt).then((admitted) => {
					if (admitted) {
						store.dispatch({ type: "message.steered", actor: "user", turnId: turn.id, text: prompt });
					}
				});
			}
			return;
		}
		/*
		 * Auth is a conversation state: a definitive signed-out or
		 * non-allowlisted answer never reaches the backend — the attempt
		 * resolves to a calm one-line reply whose action is the one needed
		 * step. The composer's draft stays; the user's words are never eaten.
		 * (Slash commands above still run: /auth.sign-in works signed-out.)
		 */
		const identity = store.collections.identitySessions.get("identity");
		if (identity?.state === "signed-out") {
			store.dispatch({
				type: "message.appended",
				actor: "system",
				text: "Sign in with GitHub first — that's the one step between you and this conversation.",
				action: { flow: "auth.sign-in", label: "Sign in with GitHub" },
			});
			return;
		}
		if (identity?.state === "signed-in" && !identity.allowlisted) {
			store.dispatch({
				type: "message.appended",
				actor: "system",
				text: identity.accessRequested
					? "Your request is already in — the chat opens up as soon as there's a spot."
					: "Smithers is open to design partners only right now — request access and we'll open the chat.",
				...(identity.accessRequested
					? {}
					: { action: { flow: "auth.request-access", label: "Request access" } }),
			});
			return;
		}
		const turnId = crypto.randomUUID();
		activeTurn = {
			id: turnId,
			receivedText: false,
			toolLegs: 0,
			toolItems: [],
			pendingCall: undefined,
			runLaunch: undefined,
			// Wave 13c: the ASK arms the hold, detected from the user's words
			// before the model speaks — ordinary conversation arms nothing.
			askClass: impossibleAskOf(prompt),
			claimBuffer: "",
		};
		store.dispatch({ type: "message.submitted", actor: commandActor, turnId, text: prompt });
		launchLeg(turnId, contextMessages());
	};

	const reset = (): void => {
		if (activeTurn !== undefined) void agent.cancelTurn(activeTurn.id);
		activeTurn = undefined;
		stopWorkflowPumps();
		store.dispatch({ type: "conversation.reset", actor: "user" });
	};

	const showChat = (): void => {
		store.dispatch({ type: "surface.changed", actor: commandActor, surface: "chat" });
	};

	/*
	 * Toggles toggle (§2c): invoking the command for the currently-open pane
	 * returns to the chat. And THE EMBED LAW's in-app half (§2c″): the AGENT's
	 * invocation renders an embedded card in the transcript instead — a
	 * surface-maximizing takeover is structurally unavailable to the model.
	 */
	const showWorld = (): void => {
		if (commandActor === "smithers") {
			const snapshot = store.worldStateSnapshot();
			let highest = -1;
			for (const message of store.collections.messages.values()) highest = Math.max(highest, message.ordinal);
			for (const card of store.collections.cards.values()) highest = Math.max(highest, card.ordinal);
			const card: Card = {
				id: "world-embedded",
				kind: "world",
				title: WORLD_DISPLAY_NAME,
				status: "active",
				createdAt: Date.now(),
				ordinal: highest + 1,
				payload: {
					documents: snapshot.documents.map((document) => ({
						path: document.path,
						title: document.title,
						confidence: document.confidence,
					})),
				},
			};
			store.dispatch({ type: "card.upsert", actor: "smithers", card });
			return;
		}
		store.dispatch({
			type: "surface.changed",
			actor: "user",
			surface: store.session().surface === "world" ? "chat" : "world",
		});
	};

	const showConnectors = (): void => {
		if (commandActor === "smithers") {
			const identity = store.collections.identitySessions.get("identity");
			let highest = -1;
			for (const message of store.collections.messages.values()) highest = Math.max(highest, message.ordinal);
			for (const card of store.collections.cards.values()) highest = Math.max(highest, card.ordinal);
			const card: Card = {
				id: "connect-embedded",
				kind: "connect",
				title: "Connect work to Smithers",
				status: "active",
				createdAt: Date.now(),
				ordinal: highest + 1,
				payload: {
					github: {
						connected: identity?.state === "signed-in",
						login: identity?.login ?? null,
					},
					nativeAvailable: repositories.available,
				},
			};
			store.dispatch({ type: "card.upsert", actor: "smithers", card });
			return;
		}
		store.dispatch({
			type: "surface.changed",
			actor: "user",
			surface: store.session().surface === "connectors" ? "chat" : "connectors",
		});
	};

	/**
	 * Read the section the repository view is showing, through its own seam.
	 * Every read is scoped to the repository the user opened — including the
	 * Flows tab, which used to resolve the watched set instead and so could show
	 * a different repository's workflows than the one on screen.
	 */
	const readRepositoryTab = (tab: Session["repositoryTab"], repo: string): void => {
		if (tab === "files") void filesSeam.listFiles("", repo);
		if (tab === "issues") void issuesSeam.listIssues("open", repo);
		if (tab === "pulls") void landingsSeam.listLandings(repo);
		if (tab === "flows") void listWorkspaceWorkflows(repo);
	};

	const openRepository = (repo: string): void => {
		store.dispatch({ type: "repository.selected", actor: commandActor, repo });
		store.dispatch({ type: "surface.changed", actor: commandActor, surface: "github" });
		// Importing is an implementation detail. Reads retain their existing honest
		// degradation while this background job is still becoming ready.
		void repoImportSeam.importRepository(repo);
		// Opening a repository is asking to see it: the section on screen reads
		// itself rather than waiting for the user to press its own tab.
		readRepositoryTab(store.session().repositoryTab, repo);
	};

	const selectRepositoryTab = (tab: Session["repositoryTab"]): void => {
		store.dispatch({ type: "repository.tab.changed", actor: commandActor, tab });
		const repo = store.session().selectedRepository;
		if (repo === null) return;
		readRepositoryTab(tab, repo);
	};

	/*
	 * The GitHub pane opens on the repository LIST (will, 2026-08-19: "we should
	 * see a list of repos available and if we click on it we see the repo view").
	 * It opens whether or not anything is watched — a pane that silently refuses
	 * to open is the worst answer to a button the user just pressed — and the
	 * list states its own empty case when the account has no repositories.
	 */
	const showGithub = (): void => {
		store.dispatch({ type: "repository.selected", actor: commandActor, repo: null });
		store.dispatch({ type: "surface.changed", actor: commandActor, surface: "github" });
		void loadRepoCatalog();
	};

	/*
	 * "clicking world is cool. we should be able to also click files and view
	 * the repo" (will, 2026-08-19). The target follows the one repo-resolution
	 * rule every repo-scoped command follows (RepoContext.ts): an explicit
	 * `owner/repo` wins, a single watched repository is the target, and anything
	 * else is a genuine choice — so the frame opens on the repository LIST and
	 * the human picks, rather than the surface guessing one for them.
	 */
	const showFiles = (explicit?: string): void => {
		const resolved = resolveTargetRepo(store, explicit);
		const repo = "error" in resolved ? null : resolved.repo;
		store.dispatch({ type: "repository.selected", actor: commandActor, repo });
		store.dispatch({ type: "surface.changed", actor: commandActor, surface: "files" });
		void loadRepoCatalog();
		if (repo === null) return;
		void repoImportSeam.importRepository(repo);
		void filesSeam.listFiles("", repo);
	};

	const maximizeCard = (id: string): string | void => {
		if (store.collections.cards.get(id) === undefined) return `There is no card with id ${id}.`;
		store.dispatch({ type: "card.maximized", actor: "user", id });
	};

	const minimizeCard = (): void => {
		store.dispatch({ type: "card.minimized", actor: "user" });
	};

	/*
	 * Open or close one act row's detail, in place in the transcript (will,
	 * 2026-08-19). A presentation transition like maximize, and the human's
	 * alone: the row expands under itself, never into a takeover.
	 */
	const toggleActDetail = (id: string): string | void => {
		const row = store.collections.messages.get(id);
		if (row === undefined || row.act === undefined) return `There is no act row with id ${id}.`;
		if (row.actDetail === undefined) return "That act kept no detail to open.";
		store.dispatch({ type: "message.act.toggled", actor: "user", id });
	};

	const toggleDevtools = (): void => {
		// The command registers only for admins; the guard keeps the state
		// honest even if a stale binding fires in a non-admin session.
		const identity = store.collections.identitySessions.get("identity");
		if (identity?.state !== "signed-in" || !identity.admin) return;
		store.dispatch({ type: "devtools.toggled", actor: "user", open: !store.session().devtoolsOpen });
	};

	const toggleSurfacesMenu = (): void => {
		store.dispatch({
			type: "surfaces-menu.toggled",
			actor: "user",
			open: !store.session().surfacesMenuOpen,
		});
	};

	const toggleConnectMenu = (): void => {
		store.dispatch({
			type: "connect-menu.toggled",
			actor: "user",
			open: store.session().connectMenuOpen !== true,
		});
	};

	/*
	 * Escape, an outside press, and picking an entry all CLOSE — they are not
	 * toggles, and dispatching one against an already-closed menu would write a
	 * transition that changed nothing into the journal.
	 */
	const closeConnectMenu = (): void => {
		if (store.session().connectMenuOpen !== true) return;
		store.dispatch({ type: "connect-menu.toggled", actor: "user", open: false });
	};

	/*
	 * DESIGN.md §14: the human flips which backend drives a turn — the
	 * chat.smithers.sh proxy with the client tool loop, or the in-browser Agent
	 * Chain over /api/model/stream. user-only by the trigger axis (the agent
	 * must never switch its own engine), honest about the argument instead of
	 * guessing, and it states the answer in the chat: a backend answer the
	 * human cannot see is a backend they cannot trust.
	 */
	const setAgentBackend = (backend: string): string | { readonly value: string } => {
		const live = store.session().agentBackend ?? "proxy";
		const asked = backend.trim();
		// Bare /debug.backend flips to the other one: naming what you are already
		// on is what the answer below does anyway.
		const target = asked === "" ? (live === "chain" ? "proxy" : "chain") : asked;
		if (target !== "proxy" && target !== "chain") {
			return `debug.backend needs "proxy" or "chain" (currently: ${live})`;
		}
		if (store.session().phase !== "idle") {
			return "the backend can only change between turns — stop the current turn first";
		}
		store.dispatch({ type: "agent.backend.changed", actor: "user", backend: target });
		const value = `agent backend: ${target}`;
		// A backend answer the human cannot see is a backend they cannot trust.
		if (commandActor !== "smithers") {
			store.dispatch({ type: "message.appended", actor: "system", text: value });
		}
		return { value };
	};

	/*
	 * The debug reads (§2d): one typed surface the dev-tools panel renders and
	 * the agent invokes to answer "what is happening" for admin sessions.
	 */
	/*
	 * A debug read the HUMAN asked for renders in the transcript.
	 *
	 * `{ value }` is the agent boundary's channel and never renders on its own
	 * (§2b), so a read whose only answer is a value is a silent no-op for the
	 * person who typed it. `debug.seams` already showed the shape: surface
	 * first, return the value second. These four now do the same. The agent's
	 * own invocation still renders nothing — it reads the value in its tool
	 * result, and pasting the payload into the chat as well would be noise.
	 */
	const DEBUG_READ_LIMIT = 4000;
	const surfaceDebugRead = (title: string, payload: string): { readonly value: string } => {
		if (commandActor !== "smithers") {
			const shown =
				payload.length <= DEBUG_READ_LIMIT
					? payload
					: `${payload.slice(0, DEBUG_READ_LIMIT)}\n\n… truncated at ${DEBUG_READ_LIMIT} of ${payload.length} characters. The dev-tools panel (/admin.devtools) holds the whole read.`;
			store.dispatch({
				type: "message.appended",
				actor: "system",
				text: `${title}\n\n\`\`\`json\n${shown}\n\`\`\``,
			});
		}
		return { value: payload };
	};

	const debugSnapshot = (): { readonly value: string } => {
		const identity = store.collections.identitySessions.get("identity");
		const billing = store.collections.billingAccounts.get("billing");
		const watched = store.collections.watchedRepos.get("watched");
		return surfaceDebugRead(
			"App state snapshot",
			JSON.stringify({
				surface: store.session().surface,
				phase: store.session().phase,
				revision: store.session().revision,
				messages: store.collections.messages.size,
				cards: [...store.collections.cards.values()].map((card) => `${card.kind}:${card.status}`),
				worldDocuments: store.collections.worldDocuments.size,
				identity:
					identity === undefined
						? null
						: { state: identity.state, login: identity.login, allowlisted: identity.allowlisted, admin: identity.admin },
				billing: billing === undefined ? null : { state: billing.state, totalUsd: billing.totalUsd },
				watchedRepos: watched?.selected ?? null,
				commands: commands.entries().map((entry) => ({
					name: entry.binding.descriptor.name,
					trigger: entry.binding.descriptor.modelInvocable ? "both" : "user",
					hidden: entry.metadata.hidden === true,
				})),
			}),
		);
	};

	const debugEvents = (): { readonly value: string } => {
		const tail = [...store.collections.transitions.values()]
			.sort((left, right) => left.revision - right.revision)
			.slice(-40)
			.map((record) => ({
				revision: record.revision,
				actor: record.actor,
				type: record.type,
				at: new Date(record.createdAt).toISOString(),
			}));
		return surfaceDebugRead("Transition journal tail", JSON.stringify(tail));
	};

	const debugChain = (): { readonly value: string } => {
		// The journal fold, whole: every lineage (turns and backgrounds), each
		// link's script, calls, rejections, steering, outcome, and the author
		// contexts — the two-histories view. Full payloads by design: the
		// admin panel is the raw-payload surface the transcript never is.
		return surfaceDebugRead(
			"Chain journal x-ray",
			JSON.stringify(foldLineages([...store.collections.chainEvents.values()])),
		);
	};

	const netTap = (): string => JSON.stringify([...netRing].reverse());

	const debugNet = (): { readonly value: string } => surfaceDebugRead("Network tap", netTap());

	const resetGrants = async (): Promise<string | { readonly value: string }> => {
		if (agent.revokeGrants === undefined) return "this backend holds no grants";
		await agent.revokeGrants();
		// A revocation the human cannot see is a revocation they cannot trust.
		if (commandActor !== "smithers") {
			store.dispatch({
				type: "message.appended",
				actor: "system",
				text: "The chain's session grants are revoked — the next tool call asks for permission again.",
			});
		}
		return { value: "chain grants revoked" };
	};

	const debugSeams = async (): Promise<string | void | { readonly value: string }> => {
		// admin.health is a VIEW over this same read, not a separate path.
		await adminHealth();
		const card = store.collections.cards.get("admin-health");
		if (card === undefined || card.kind !== "admin-health") {
			return "The seam probe didn't land — see the honest line in the chat.";
		}
		return { value: JSON.stringify(card.payload) };
	};

	/*
	 * /clear (§2h): sweep the outgoing transcript for anything that belongs in
	 * world (decisions, facts, preferences — provenance chat-sweep, actor
	 * smithers), apply it, THEN clear. A failed sweep clears nothing.
	 */
	const SWEEP_INSTRUCTIONS = [
		"You are sweeping a chat transcript before it is cleared.",
		"Extract anything that belongs in long-term world memory: decisions the user made, durable facts about their work, stated preferences.",
		'Answer with ONLY JSON: {"notes":[{"title":"...","body":"...","confidence":0.0}...]} — body is markdown, confidence is 0..1.',
		'If nothing is worth keeping, answer {"notes":[]}. No prose, no fences.',
	].join("\n");

	interface SweepNote {
		readonly title: string;
		readonly body: string;
		readonly confidence: number;
	}

	const runSweep = async (transcript: ReadonlyArray<AgentChatMessage>): Promise<SweepNote[] | undefined> => {
		let response: Response;
		try {
			/*
			 * The sweep reads NDJSON turn frames ({type:"delta",kind:"text"}), so
			 * it posts to the TURN route that speaks them. Pointing it at the
			 * model relay — which answers the provider's own SSE — meant the
			 * parse below found nothing every time, and /clear answered "I
			 * couldn't finish reviewing the conversation" on a healthy backend
			 * while keeping the transcript it was asked to sweep.
			 */
			response = await http(`${baseUrl}${TURN_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					// The route identifies every turn, including this one: a body
					// without a runId is refused with 400, which the parse below
					// could only report as "nothing worth keeping".
					runId: `sweep-${Date.now()}`,
					messages: transcript,
					instructions: SWEEP_INSTRUCTIONS,
				}),
			});
		} catch {
			return undefined;
		}
		if (!response.ok || response.body === null) {
			await response.body?.cancel();
			return undefined;
		}
		const raw = await response.text();
		let text = "";
		for (const line of raw.split("\n")) {
			if (line.trim() === "") continue;
			try {
				const frame: unknown = JSON.parse(line);
				if (
					typeof frame === "object" &&
					frame !== null &&
					(frame as { type?: unknown }).type === "delta" &&
					(frame as { kind?: unknown }).kind === "text" &&
					typeof (frame as { text?: unknown }).text === "string"
				) {
					text += (frame as { text: string }).text;
				}
			} catch {
				// An unparseable line is not sweep output.
			}
		}
		const match = /\{[\s\S]*\}/.exec(text);
		if (match === null) return undefined;
		try {
			const parsed: unknown = JSON.parse(match[0]);
			if (typeof parsed !== "object" || parsed === null) return undefined;
			const notes = (parsed as { notes?: unknown }).notes;
			if (!Array.isArray(notes)) return undefined;
			return notes
				.filter(
					(note) =>
						typeof note === "object" &&
						note !== null &&
						typeof (note as { title?: unknown }).title === "string" &&
						typeof (note as { body?: unknown }).body === "string" &&
						(note as { title: string }).title.trim() !== "",
				)
				.map((note) => {
					const row = note as { title: string; body: string; confidence?: unknown };
					return {
						title: row.title.trim(),
						body: row.body,
						confidence:
							typeof row.confidence === "number" && row.confidence >= 0 && row.confidence <= 1
								? row.confidence
								: 0.6,
					};
				});
		} catch {
			return undefined;
		}
	};

	const clearConversationImpl = async (): Promise<true | string> => {
		const identity = store.collections.identitySessions.get("identity");
		const canSweep = identity?.state === "signed-in" && identity.allowlisted;
		const transcript = contextMessages();
		let kept = 0;
		if (canSweep && transcript.length > 0) {
			const notes = await runSweep(transcript);
			if (notes === undefined) {
				// A failed sweep leaves the chat UNcleared — nothing is silently lost.
				const message = "I couldn't finish reviewing the conversation, so I left it exactly as it was. Try /clear again in a moment.";
				store.dispatch({ type: "message.appended", actor: "system", text: message });
				return message;
			}
			for (const note of notes) {
				const path = `${note.title.replace(/[\\/:*?"<>|]/g, "-")}.md`;
				const existing = [...store.collections.worldDocuments.values()].find(
					(document) => document.path === path,
				);
				store.dispatch({
					type: "world.document.upserted",
					actor: "smithers",
					document: {
						id: existing?.id ?? crypto.randomUUID(),
						path,
						title: note.title,
						body: note.body.startsWith("#") ? note.body : `# ${note.title}\n\n${note.body}\n`,
						links: existing?.links ?? [],
						tags: existing?.tags ?? [],
						sources: [...new Set([...(existing?.sources ?? []), "chat-sweep"])],
						confidence: note.confidence,
					},
				});
				kept += 1;
			}
		}
		if (activeTurn !== undefined) void agent.cancelTurn(activeTurn.id);
		activeTurn = undefined;
		stopWorkflowPumps();
		store.dispatch({ type: "conversation.cleared", actor: "user", kept });
		return true;
	};

	const clearConversation = (): Promise<string | void> =>
		withToast("chat.clear", `Reviewing the conversation for what to keep…`, "Conversation reviewed", clearConversationImpl).then(
			(outcome) => (outcome === true ? undefined : outcome),
		);

	/*
	 * The browser tool + surface (§2d/§2d′): the server-side guarded fetch
	 * reads the page; the embedded card shows it (iframe when the site allows
	 * framing, the honest blocked state when not). The agent's invocation
	 * hands the extracted text back as the tool result — the transcript only
	 * ever carries the one-line act ("Smithers read <host>").
	 */
	const openBrowserImpl = async (url: string): Promise<true | string | { readonly value: string }> => {
		let outcome:
			| {
					status?: unknown;
					finalUrl?: unknown;
					text?: unknown;
					frameable?: unknown;
					blockReason?: unknown;
			  }
			| undefined;
		try {
			const response = await http(`${baseUrl}${TOOLS_BROWSER_FETCH_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ url }),
			});
			if (!response.ok) {
				const message = await errorMessageOf(response, "That page couldn't be read.");
				const card = browserCard(url, { error: message });
				store.dispatch({ type: "card.upsert", actor: commandActor, card });
				return message;
			}
			outcome = (await response.json().catch(() => undefined)) as typeof outcome;
		} catch {
			const message = "That page couldn't be read — the browser service didn't answer.";
			store.dispatch({ type: "card.upsert", actor: commandActor, card: browserCard(url, { error: message }) });
			return message;
		}
		if (outcome === undefined || typeof outcome.status !== "number") {
			const message = "The browser service answered in a shape I didn't understand.";
			store.dispatch({ type: "card.upsert", actor: commandActor, card: browserCard(url, { error: message }) });
			return message;
		}
		const card = browserCard(url, {
			finalUrl: typeof outcome.finalUrl === "string" ? outcome.finalUrl : url,
			status: outcome.status,
			frameable: outcome.frameable !== false,
			blockReason: typeof outcome.blockReason === "string" ? outcome.blockReason : null,
		});
		store.dispatch({ type: "card.upsert", actor: commandActor, card });
		const text = typeof outcome.text === "string" ? outcome.text : "";
		if (commandActor === "smithers") {
			// The read IS the tool result for the model; the card is the surface.
			return { value: text === "" ? `Read ${url} (HTTP ${outcome.status}) — the page had no readable text.` : text };
		}
		return true;
	};

	const browserCardId = (url: string): string => `browser-${url}`;

	const browserCard = (
		url: string,
		result:
			| { finalUrl: string; status: number; frameable: boolean; blockReason: string | null }
			| { error: string },
	): Card => {
		const id = browserCardId(url);
		const existing = store.collections.cards.get(id);
		let highest = -1;
		for (const message of store.collections.messages.values()) highest = Math.max(highest, message.ordinal);
		for (const card of store.collections.cards.values()) highest = Math.max(highest, card.ordinal);
		const payload: Extract<Card, { kind: "browser" }>["payload"] =
			"error" in result
				? { url, finalUrl: null, status: null, frameable: false, blockReason: null, error: result.error }
				: {
						url,
						finalUrl: result.finalUrl,
						status: result.status,
						frameable: result.frameable,
						blockReason: result.blockReason,
					};
		return {
			id,
			kind: "browser",
			title: (() => {
				try {
					return new URL(url).host;
				} catch {
					return url;
				}
			})(),
			status: "error" in result ? "error" : "active",
			createdAt: existing?.createdAt ?? Date.now(),
			ordinal: existing?.ordinal ?? highest + 1,
			payload,
		};
	};

	const openBrowser = (url: string): Promise<string | void | { readonly value: string }> => {
		let host = url;
		try {
			host = new URL(url).host;
		} catch {
			// The invalid-URL case is the impl's honest error.
		}
		return withToast("browser.fetch", `Reading ${host}…`, `Read ${host}`, () => openBrowserImpl(url)).then(
			(outcome) => {
				if (outcome === true) return undefined;
				return outcome;
			},
		);
	};

	/*
	 * Wave 11 — workflows in the conversation ("make me a workflow").
	 *
	 * Every act routes through the per-user gateway seam on the product
	 * Worker: provision/resume the workspace gateway for a WATCHED repo (the
	 * watched set is the universe — anything outside it routes to the
	 * chooser), then whitelisted RPCs. A run renders as an embedded run card
	 * (THE EMBED LAW) whose event pump resumes from `lastSeq` — stream loss
	 * is routine, never a silent stall; failures surface as the honest
	 * reconnecting state.
	 */
	const RUN_POLL_MS = workflowPollMs;
	const RUN_STEPS_TAIL = 8;
	/*
	 * Wave 12 §3 — the generous bound. A run the workspace never finishes is a
	 * real state (wave 11's credential-less create-workflow run is exactly it),
	 * and polling it until the tab closes is neither honest nor kind to the
	 * workspace. After this long with no event progress the card says so and the
	 * pump stops; stop/retry are the human's next acts, both registered commands.
	 */
	const RUN_QUIET_AFTER_MS = services.workflowQuietMs ?? 10 * 60 * 1000;

	const waitMs = (ms: number): Promise<void> =>
		new Promise((resolve) => {
			const timer = setTimeout(resolve, ms);
			unref(timer);
		});

	const workflowIdentityGuard = (): string | undefined => {
		const identity = store.collections.identitySessions.get("identity");
		if (identity?.state !== "signed-in") {
			return "Sign in with GitHub first — workflows run on your own workspace.";
		}
		if (!identity.allowlisted) {
			return "Workflows open up with the closed alpha — your account isn't allowlisted yet.";
		}
		return undefined;
	};

	/*
	 * Launch Checklist D-4 / AppState.ts:290-296's ruling: chat is
	 * complimentary and a $0 balance never pauses it, but a workflow run is
	 * non-complimentary work — the one place the pause discipline applies.
	 * `allowedToStartWork` only ever reads false after a definitive
	 * "ok"/"low"/"empty" balance answer (refreshBalanceImpl), so a down or
	 * unread billing seam never blocks a launch. `billing === undefined` is
	 * kept as an explicit defensive branch — `seed()` (AppStore.ts) always
	 * inserts `initialBillingAccount()` before the store resolves, so in
	 * practice the row always exists by the time a command can run; this
	 * guards the invariant rather than a state the store can actually
	 * produce. The refusal is dispatched into the transcript directly (not
	 * left to the generic toast channel) so it lands as an embedded chat
	 * message per THE EMBED LAW regardless of whether a button, slash
	 * command, or the agent triggered the launch; `surfaceCommandFailure`
	 * recognizes `ZERO_BALANCE_EXHAUSTED_TEXT` and skips its toast for
	 * pointer-driven triggers, so a button click doesn't double-surface the
	 * same refusal as both a transcript message and a toast.
	 */
	const zeroBalanceGuard = (): string | undefined => {
		const billing = store.collections.billingAccounts.get("billing");
		if (billing === undefined || billing.allowedToStartWork) return undefined;
		store.dispatch({ type: "message.appended", actor: "system", text: ZERO_BALANCE_EXHAUSTED_TEXT });
		return ZERO_BALANCE_EXHAUSTED_TEXT;
	};

	/**
	 * The watched set is the universe: the target repo, the wave-10 chooser
	 * route (nothing watched, or a repo outside the set), or — wave 12 §2, when
	 * the caller opts in — the genuine question of WHICH watched repo. One
	 * watched repo is not a question; more than one, with no argument, is.
	 */
	const workflowTargetRepoOrAsk = (
		preferred: string | undefined,
		askWhenAmbiguous: boolean,
	): { readonly repo: string } | { readonly chooser: string | null } | { readonly ask: ReadonlyArray<string> } => {
		const watched = store.collections.watchedRepos.get("watched");
		const selected = watched?.selected ?? null;
		if (selected === null || selected.length === 0) return { chooser: null };
		if (preferred !== undefined && !selected.includes(preferred)) return { chooser: preferred };
		if (preferred === undefined && askWhenAmbiguous && selected.length > 1) return { ask: selected };
		return { repo: preferred ?? selected[0] ?? "" };
	};

	/** The two-way form, for the calls that do not ask (list, run-by-name). */
	const workflowTargetRepo = (preferred?: string): { readonly repo: string } | { readonly chooser: string | null } => {
		const target = workflowTargetRepoOrAsk(preferred, false);
		return "ask" in target ? { chooser: null } : target;
	};

	/** The `owner/repo` shape the seam addresses — the same one the Worker refuses past. */
	const isWorkflowRepoArg = (value: string): boolean =>
		/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(value);

	/**
	 * `flow.create <description> [owner/repo]` — a trailing `owner/repo`
	 * token is the target, everything before it is the description. Anything
	 * that is not a repository name stays part of the description.
	 */
	const splitDescriptionAndRepo = (
		input: string,
	): { readonly description: string; readonly repo?: string } => {
		const words = input.trim().split(/\s+/);
		const last = words.at(-1);
		if (words.length > 1 && last !== undefined && isWorkflowRepoArg(last)) {
			return { description: words.slice(0, -1).join(" "), repo: last };
		}
		return { description: input.trim() };
	};

	const openChooserForWorkflow = async (missing: string | null): Promise<string> => {
		await openRepoChooser();
		return missing === null
			? "Choose which repositories I should watch first — the chooser is open."
			: `${missing} isn't one of your watched repositories — the chooser is open. Watching it is the one step that unlocks this.`;
	};

	const provisionWorkspaceImpl = async (repo: string): Promise<true | string> => {
		// A 409 means mid-provision: poll to a bounded deadline, never stampede.
		const deadline = Date.now() + RUN_POLL_MS * 36;
		for (;;) {
			let body: { status?: unknown; message?: unknown } | undefined;
			try {
				const response = await boundedFetch(`${baseUrl}${WORKFLOW_PROVISION_PATH}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ repo }),
				});
				if (!response.ok) {
					return await errorMessageOf(response, "The workspace couldn't be prepared.");
				}
				body = (await response.json().catch(() => undefined)) as typeof body;
			} catch {
				return "The workspace couldn't be prepared — the workflow service didn't answer in time.";
			}
			if (body?.status === "ready") return true;
			/*
			 * Wave 12 §4 — the watched set is a GITHUB set; a gateway needs a
			 * Smithers Cloud repository. When they don't coincide the honest
			 * answer is that fact, not the provision seam's raw HTTP failure.
			 */
			if (body?.status === "no-cloud-repo") {
				return `${repo} isn't on Smithers Cloud yet, so there's no workspace to run this on. Add it there and I'll pick it up, or point me at a repo that is.`;
			}
			if (body?.status === "provisioning") {
				if (Date.now() > deadline) {
					return `The workspace for ${repo} is still being prepared — try again in a moment.`;
				}
				await waitMs(RUN_POLL_MS);
				continue;
			}
			if (typeof body?.message === "string") return body.message;
			return "The workspace couldn't be prepared.";
		}
	};

	const provisionWorkspace = (repo: string): Promise<true | string> =>
		withToast(`flow.provision.${repo}`, `Preparing your ${repo} workspace…`, "Workspace ready", () =>
			provisionWorkspaceImpl(repo),
		);

	type WorkflowRpcResult =
		| { readonly status: "ok"; readonly payload: unknown }
		| { readonly status: "error"; readonly message: string };

	const workflowRpc = async (repo: string, method: string, params: unknown): Promise<WorkflowRpcResult> => {
		let body:
			| {
					status?: unknown;
					message?: unknown;
					ok?: unknown;
					payload?: unknown;
					error?: { message?: unknown } | unknown;
			  }
			| undefined;
		try {
			const response = await http(`${baseUrl}${WORKFLOW_RPC_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ repo, method, params }),
			});
			if (!response.ok) {
				return { status: "error", message: await errorMessageOf(response, "The workspace didn't answer.") };
			}
			body = (await response.json().catch(() => undefined)) as typeof body;
		} catch {
			return { status: "error", message: "The workspace didn't answer — the workflow service is unreachable." };
		}
		if (body?.ok === true) return { status: "ok", payload: body.payload };
		const gatewayError = body?.error;
		if (body?.ok === false) {
			return {
				status: "error",
				message:
					typeof gatewayError === "object" &&
					gatewayError !== null &&
					"message" in gatewayError &&
					typeof gatewayError.message === "string"
						? gatewayError.message
						: "The workspace refused the call.",
			};
		}
		if (typeof body?.message === "string") return { status: "error", message: body.message };
		return { status: "error", message: "The workspace answered in a shape I didn't understand." };
	};

	interface WorkflowSummary {
		readonly key: string;
		readonly description: string | null;
	}

	const parseWorkflowSummaries = (wire: unknown): WorkflowSummary[] =>
		(Array.isArray(wire) ? wire : [])
			.filter(
				(entry) =>
					typeof entry === "object" && entry !== null && typeof (entry as { key?: unknown }).key === "string",
			)
			.map((entry) => {
				const row = entry as { key: string; description?: unknown; readableName?: unknown };
				return {
					key: row.key,
					description:
						typeof row.description === "string" && row.description.trim() !== "" ? row.description : null,
				};
			});

	/** The relay SSE change stream pokes live pumps so progress lands the second it happens. */
	const runStreams = new Map<string, EventSource>();
	const pumpPokes = new Map<string, () => void>();
	const runPumps = new Map<string, { stopped: boolean }>();

	const liveRunCards = (repo?: string): Array<Extract<Card, { kind: "flow-run" }>> =>
		[...store.collections.cards.values()]
			.filter(
				(card) =>
					card.kind === "flow-run" &&
					(card.payload.phase === "launching" ||
						card.payload.phase === "running" ||
						card.payload.phase === "waiting-approval" ||
						card.payload.phase === "reconnecting") &&
					(repo === undefined || card.payload.repo === repo),
			) as Array<Extract<Card, { kind: "flow-run" }>>;

	const closeRunStreamIfIdle = (repo: string): void => {
		if (liveRunCards(repo).length > 0) return;
		runStreams.get(repo)?.close();
		runStreams.delete(repo);
	};

	const ensureRunStream = (repo: string): void => {
		if (typeof EventSource === "undefined" || runStreams.has(repo)) return;
		try {
			const source = new EventSource(`${baseUrl}${WORKFLOW_STREAM_PATH}?repo=${encodeURIComponent(repo)}`);
			// A change frame means fresh state exists NOW — poke this repo's pumps
			// instead of waiting out the poll cadence. EventSource reconnects on
			// its own and replays via Last-Event-ID through the seam; the poll
			// loop below is the floor, so a dead stream never stalls a card.
			source.addEventListener("change", () => {
				for (const card of liveRunCards(repo)) pumpPokes.get(card.id)?.();
			});
			runStreams.set(repo, source);
		} catch {
			// The poll cadence alone carries the run card.
		}
	};

	const pokeableWait = (cardId: string, ms: number): Promise<void> =>
		new Promise((resolve) => {
			const timer = setTimeout(() => {
				pumpPokes.delete(cardId);
				resolve();
			}, ms);
			unref(timer);
			pumpPokes.set(cardId, () => {
				clearTimeout(timer);
				pumpPokes.delete(cardId);
				resolve();
			});
		});

	const patchRunCard = (
		cardId: string,
		patch: Partial<Extract<Card, { kind: "flow-run" }>["payload"]>,
		status?: Card["status"],
	): void => {
		const card = store.collections.cards.get(cardId);
		if (card === undefined || card.kind !== "flow-run") return;
		store.dispatch({
			type: "card.updated",
			actor: "system",
			id: cardId,
			patch: { payload: { ...card.payload, ...patch }, ...(status === undefined ? {} : { status }) },
		});
	};

	/** One run event, in words. Unknown events stay silent — never raw payloads. */
	/**
	 * The engine's own error text for a node that could not run — the
	 * `AgentTraceEvent` capture-error carries the only sentence that actually
	 * explains it (e.g. a workspace VM with no AI-provider credential). One
	 * line, never a payload dump.
	 */
	const traceErrorOf = (payload: unknown): string | undefined => {
		if (typeof payload !== "object" || payload === null) return undefined;
		const trace = (payload as { trace?: { payload?: { error?: unknown } } }).trace;
		const error = trace?.payload?.error;
		return typeof error === "string" && error.trim() !== "" ? error.trim().slice(0, 240) : undefined;
	};

	const runEventWords = (event: unknown, payload: unknown): string | undefined => {
		const nodeId =
			typeof payload === "object" && payload !== null && "nodeId" in payload && typeof payload.nodeId === "string"
				? payload.nodeId
				: undefined;
		/*
		 * The engine's event vocabulary is PascalCase (`NodeStarted`,
		 * `RunFinished`, …) — the names the live gateway actually emits, read
		 * off a real 0.33 run stream. Frame/snapshot bookkeeping stays silent:
		 * it is machinery, not progress a human asked about.
		 */
		switch (event) {
			case "RunStarted":
				return "The run started.";
			case "NodeStarted":
				return nodeId === undefined ? undefined : `Working on ${nodeId}…`;
			case "NodeFinished":
				return nodeId === undefined ? undefined : `${nodeId} finished.`;
			case "NodeRetrying":
				return nodeId === undefined ? undefined : `Retrying ${nodeId}…`;
			case "NodeWaitingApproval":
			case "ApprovalRequested":
				return "Waiting for your approval.";
			case "NodeFailed":
				return nodeId === undefined ? "A step failed." : `${nodeId} failed.`;
			case "RunFailed":
				return "The run failed.";
			case "RunFinished":
				return "The run finished.";
			case "AgentTraceEvent": {
				// Only the capture errors say anything a human needs; the rest of
				// the agent trace is machinery.
				const error = traceErrorOf(payload);
				return error === undefined ? undefined : error;
			}
			default:
				return undefined;
		}
	};

	/** The terminal run events — authoritative even when `status` lags behind. */
	const TERMINAL_RUN_EVENTS: Readonly<Record<string, "completed" | "failed" | "cancelled">> = {
		RunFinished: "completed",
		RunFailed: "failed",
		RunCancelled: "cancelled",
	};

	/** The approval cards a run is waiting on, bound to the existing round trip. */
	const upsertRunApprovals = (runId: string, repo: string, wire: unknown): number => {
		let found = 0;
		for (const entry of Array.isArray(wire) ? wire : []) {
			if (typeof entry !== "object" || entry === null) continue;
			const approval = entry as {
				runId?: unknown;
				nodeId?: unknown;
				iteration?: unknown;
				requestTitle?: unknown;
				requestSummary?: unknown;
			};
			if (approval.runId !== runId || typeof approval.nodeId !== "string") continue;
			// The gateway serializes `iteration ?? 0`; a row that still arrives
			// without one is a gate the human must be able to decide, not a row
			// to drop on the floor — dropping it strands the run with no card.
			const iteration = typeof approval.iteration === "number" ? approval.iteration : 0;
			found += 1;
			const id = `approval-${runId}-${approval.nodeId}-${iteration}`;
			if (store.collections.cards.get(id) !== undefined) continue;
			const title = typeof approval.requestTitle === "string" ? approval.requestTitle : `Approval needed — ${approval.nodeId}`;
			const card: Card = {
				id,
				kind: "approval",
				title,
				status: "active",
				createdAt: Date.now(),
				ordinal: nextTranscriptOrdinal(),
				payload: {
					capability: title,
					...(typeof approval.requestSummary === "string" ? { detail: approval.requestSummary } : {}),
					runId,
					nodeId: approval.nodeId,
					iteration,
					repo,
				},
			};
			store.dispatch({ type: "card.upsert", actor: "system", card });
		}
		return found;
	};

	/** A gate this run is still parked on, as the transcript itself holds it. */
	const runAwaitsApproval = (runId: string): boolean =>
		[...store.collections.cards.values()].some(
			(entry) => entry.kind === "approval" && entry.payload.runId === runId && entry.payload.decision === undefined,
		);

	const whatHappenedWords = (result: WorkflowRpcResult): string | null => {
		if (result.status !== "ok") return null;
		const payload = result.payload;
		if (typeof payload === "string" && payload.trim() !== "") return payload.trim();
		if (typeof payload === "object" && payload !== null) {
			for (const key of ["summary", "text", "narrative", "message"]) {
				const value = (payload as Record<string, unknown>)[key];
				if (typeof value === "string" && value.trim() !== "") return value.trim();
			}
		}
		return null;
	};

	/*
	 * The run pump: poll per-run events with afterSeq resume (reconnect-and-
	 * replay — the relay's seq is per-run monotonic) plus the run state, until
	 * the run settles. Consecutive failures flip the card to the honest
	 * reconnecting state; the pump never stops silently. The SSE change
	 * stream pokes it for immediacy; the cadence is the floor.
	 */
	const pumpWorkflowRun = async (cardId: string): Promise<void> => {
		if (runPumps.has(cardId)) return;
		const pump = { stopped: false };
		runPumps.set(cardId, pump);
		let failures = 0;
		let repo = "";
		/** The engine's first stated reason a step could not run, if it gave one. */
		let failureDetail: string | undefined;
		/** A gate the engine announced whose approval row is not in hand yet. */
		let approvalPending = false;
		/** When this run last actually moved — the clock behind the quiet bound. */
		let lastProgressAt = Date.now();
		/** The last thing getRun said, so a repeated answer does not read as movement. */
		let lastRunStatus: string | undefined;
		try {
			for (;;) {
				if (pump.stopped) return;
				const card = store.collections.cards.get(cardId);
				if (card === undefined || card.kind !== "flow-run") return;
				if (
					card.payload.phase === "completed" ||
					card.payload.phase === "failed" ||
					card.payload.phase === "cancelled" ||
					card.payload.phase === "no-capacity" ||
					card.payload.phase === "quiet" ||
					card.payload.phase === "stopped"
				) {
					return;
				}
				/*
				 * §3: nothing has moved for a very long time. Say so and stop —
				 * an endlessly reconnecting or endlessly "running" card that
				 * nobody can act on is the silent stall in a different costume.
				 */
				const quietFor = Date.now() - lastProgressAt;
				if (quietFor >= RUN_QUIET_AFTER_MS) {
					patchRunCard(cardId, { phase: "quiet", quietForMs: quietFor });
					return;
				}
				repo = card.payload.repo;
				const { runId, lastSeq } = card.payload;
				ensureRunStream(repo);

				let rows: unknown[] | undefined;
				try {
					const response = await http(
						`${baseUrl}${WORKFLOW_EVENTS_PATH}?repo=${encodeURIComponent(repo)}&runId=${encodeURIComponent(runId)}&afterSeq=${lastSeq}`,
					);
					if (!response.ok) throw new Error("events failed");
					const body: unknown = await response.json().catch(() => undefined);
					// The relay REST envelope is {ok:true, data:[…]}; tolerate a bare array.
					const data =
						typeof body === "object" && body !== null && "data" in body
							? (body as { data?: unknown }).data
							: body;
					if (!Array.isArray(data)) throw new Error("events shape");
					rows = data;
				} catch {
					failures += 1;
					if (failures >= 2 && !pump.stopped) patchRunCard(cardId, { phase: "reconnecting" });
					await pokeableWait(cardId, RUN_POLL_MS);
					continue;
				}

				let newSeq = lastSeq;
				const newSteps: string[] = [];
				/*
				 * A terminal EVENT settles the card even when `getRun.status`
				 * lags behind it — the live gateway leaves a run reading
				 * "running" after its last node has already failed, and a card
				 * that polls that forever is exactly the silent stall §1 forbids.
				 */
				let terminalEvent: "completed" | "failed" | "cancelled" | undefined;
				let firstFailure: string | undefined;
				/*
				 * The engine announces its own gate (`NodeWaitingApproval` /
				 * `ApprovalRequested`). getRun's `runState` is DERIVED and the
				 * gateway computes it best-effort — when that computation fails
				 * the run record carries no `blocked` at all, and a card that
				 * only asks `blocked.kind` would leave a parked run with no
				 * approval card and no way for the human to unblock it. The
				 * event is authoritative here for the same reason the terminal
				 * event is above.
				 */
				let approvalEvent = false;
				for (const row of rows) {
					if (typeof row !== "object" || row === null) continue;
					const event = row as { seq?: unknown; event?: unknown; payload?: unknown };
					if (typeof event.seq === "number" && Number.isInteger(event.seq)) {
						newSeq = Math.max(newSeq, event.seq);
					}
					const words = runEventWords(event.event, event.payload);
					if (words !== undefined) newSteps.push(words);
					if (typeof event.event === "string" && event.event in TERMINAL_RUN_EVENTS) {
						terminalEvent = TERMINAL_RUN_EVENTS[event.event];
					}
					if (event.event === "NodeWaitingApproval" || event.event === "ApprovalRequested") {
						approvalEvent = true;
					}
					// The engine's own sentence for why a step could not run.
					if (firstFailure === undefined && event.event === "AgentTraceEvent") {
						firstFailure = traceErrorOf(event.payload);
					}
				}
				if (firstFailure !== undefined) failureDetail ??= firstFailure;

				// A stop landing mid-iteration must not be overwritten by the
				// answer that was already in flight when it arrived.
				if (pump.stopped) return;
				const run = await workflowRpc(repo, "getRun", { runId });
				if (pump.stopped) return;
				const runPayload =
					run.status === "ok" && typeof run.payload === "object" && run.payload !== null
						? (run.payload as {
								status?: unknown;
								runState?: { blocked?: { kind?: unknown } | null } | null;
								errorJson?: unknown;
						  })
						: undefined;
				const runStatus = typeof runPayload?.status === "string" ? runPayload.status : undefined;
				const blockedKind =
					typeof runPayload?.runState?.blocked?.kind === "string" ? runPayload.runState.blocked.kind : undefined;
				const statusTerminal =
					runStatus === "finished" ? "completed" : runStatus === "failed" ? "failed" : runStatus === "cancelled" ? "cancelled" : undefined;
				const settled = statusTerminal ?? terminalEvent;

				if (approvalEvent) approvalPending = true;
				if (blockedKind === "approval" || runStatus === "waiting-approval" || approvalPending) {
					const approvals = await workflowRpc(repo, "listApprovals", { filter: { runId } });
					// Keep asking until the gate is actually in hand: the parked
					// event can land a beat before the approval row is readable.
					if (approvals.status === "ok" && upsertRunApprovals(runId, repo, approvals.payload) > 0) {
						approvalPending = false;
					}
				}

				failures = 0;
				if (settled !== undefined) {
					const steps = [...card.payload.steps, ...newSteps].slice(-RUN_STEPS_TAIL);
					if (settled === "completed") {
						const result =
							whatHappenedWords(await workflowRpc(repo, "whatHappened", { runId })) ?? "The run finished.";
						patchRunCard(cardId, { phase: "completed", steps, lastSeq: newSeq, result }, "acted");
						store.dispatch({ type: "message.appended", actor: "system", text: result });
					} else {
						// Lead with the engine's own reason when it gave one; the
						// generic line is the fallback, never a cover for it.
						const detail =
							failureDetail ??
							(typeof runPayload?.errorJson === "string" ? runPayload.errorJson.slice(0, 300) : undefined);
						const message =
							settled === "failed"
								? `The run failed on your workspace${detail === undefined ? " — the card has what the gateway reported." : `: ${detail}`}`
								: "The run was cancelled.";
						patchRunCard(
							cardId,
							{
								phase: settled === "failed" ? "failed" : "cancelled",
								steps,
								lastSeq: newSeq,
								...(detail === undefined ? {} : { error: detail }),
							},
							"error",
						);
						store.dispatch({ type: "message.appended", actor: "system", text: message });
					}
					return;
				}

				/*
				 * Real movement resets the quiet clock: new events, a cursor that
				 * advanced, or a run that CHANGED what it says about itself. A
				 * getRun that keeps answering the same "running" is not progress —
				 * that is precisely the state §3 exists for.
				 */
				if (newSteps.length > 0 || newSeq > lastSeq || runStatus !== lastRunStatus) {
					lastProgressAt = Date.now();
				}
				lastRunStatus = runStatus;

				const phase = card.payload.phase === "launching" && newSteps.length === 0 && runStatus === undefined
					? card.payload.phase
					: runStatus === "waiting-approval" || blockedKind === "approval" || runAwaitsApproval(runId)
						? "waiting-approval"
						: "running";
				patchRunCard(cardId, {
					phase,
					steps: [...card.payload.steps, ...newSteps].slice(-RUN_STEPS_TAIL),
					lastSeq: newSeq,
				});
				await pokeableWait(cardId, RUN_POLL_MS);
			}
		} finally {
			/*
			 * Only tear down THIS pump's registrations. "Stop watching" then
			 * "Check again" can start a successor while this one is still
			 * unwinding its last await, and an unconditional delete here would
			 * strip the live pump out of the registry — leaving the SSE poke
			 * pointing at nothing and letting a second pump start beside it.
			 */
			if (runPumps.get(cardId) === pump) {
				pumpPokes.delete(cardId);
				runPumps.delete(cardId);
				if (repo !== "") closeRunStreamIfIdle(repo);
			}
		}
	};

	const upsertRunCard = (args: {
		readonly runId: string;
		readonly repo: string;
		readonly workflow: string;
		readonly title: string;
		readonly firstStep: string;
	}): string => {
		const cardId = `flow-run-${args.runId}`;
		const existing = store.collections.cards.get(cardId);
		const card: Card = {
			id: cardId,
			kind: "flow-run",
			title: args.title,
			status: "active",
			createdAt: existing?.createdAt ?? Date.now(),
			ordinal: existing?.ordinal ?? nextTranscriptOrdinal(),
			payload: {
				repo: args.repo,
				runId: args.runId,
				workflow: args.workflow,
				phase: "running",
				steps: [args.firstStep],
				result: null,
				lastSeq: 0,
			},
		};
		store.dispatch({ type: "card.upsert", actor: commandActor, card });
		void pumpWorkflowRun(cardId);
		return cardId;
	};

	const launchWorkflow = async (args: {
		readonly repo: string;
		readonly workflow: string;
		readonly input: Record<string, unknown>;
		readonly title: string;
	}): Promise<{ readonly runId: string } | string> => {
		const launch = await workflowRpc(args.repo, "launchRun", {
			workflow: args.workflow,
			input: args.input,
		});
		if (launch.status !== "ok") return launch.message;
		const payload = launch.payload;
		const runId =
			typeof payload === "object" && payload !== null && "runId" in payload && typeof payload.runId === "string"
				? payload.runId
				: undefined;
		if (runId === undefined) return "The run started but the workspace didn't name it — nothing is lost; ask me to check.";
		upsertRunCard({
			runId,
			repo: args.repo,
			workflow: args.workflow,
			title: args.title,
			firstStep: `Started ${args.workflow} on ${args.repo} (run ${runId}).`,
		});
		return { runId };
	};

	/*
	 * Wave 12 §2 — the which-repo question, embedded. It renders only when the
	 * answer is genuinely the user's (more than one watched repo, no argument);
	 * one act answers it, and the create resumes with the repo they named.
	 */
	const WORKFLOW_REPO_CARD_ID = "workflow-repo";

	const askWhichWatchedRepo = (
		description: string,
		repos: ReadonlyArray<string>,
	): { readonly value: string } => {
		const existing = store.collections.cards.get(WORKFLOW_REPO_CARD_ID);
		store.dispatch({
			type: "card.upsert",
			actor: commandActor,
			card: {
				id: WORKFLOW_REPO_CARD_ID,
				kind: "workflow-repo",
				title: "Which repository?",
				status: "active",
				createdAt: existing?.createdAt ?? Date.now(),
				ordinal: nextTranscriptOrdinal(),
				payload: { intent: "create", description, repos: [...repos], chosen: null },
			},
		});
		/*
		 * A QUESTION is not a failure. A bare string result marks the outcome
		 * `failed`, and live on canary the transcript read "Smithers tried
		 * /flow.create — failed: You watch 3 repositories…" beside the card
		 * that had just asked them, correctly, which one. The command did exactly
		 * what it should; the value carries the question to the model, and the
		 * card carries it to the human (§2b — values never render raw).
		 */
		return { value: `You watch ${repos.length} repositories — choose the one this workflow belongs to.` };
	};

	const chooseWorkflowRepo = async (fullName: string): Promise<string | void | { readonly value: string }> => {
		const card = store.collections.cards.get(WORKFLOW_REPO_CARD_ID);
		if (card === undefined || card.kind !== "workflow-repo") {
			return "There's no repository question open right now.";
		}
		if (card.payload.chosen !== null) {
			// A question is answered once. Two clicks landing before the card's
			// state came back would otherwise launch the same workflow twice, on
			// a seam where a launch is real work on the user's workspace.
			return `That question is already answered — I'm creating it on ${card.payload.chosen}.`;
		}
		if (!card.payload.repos.includes(fullName)) {
			return `${fullName} isn't one of the repositories in that question.`;
		}
		store.dispatch({
			type: "card.updated",
			actor: "user",
			id: WORKFLOW_REPO_CARD_ID,
			patch: { payload: { ...card.payload, chosen: fullName }, status: "acted" },
		});
		return createWorkflow(card.payload.description, fullName);
	};

	const createWorkflow = async (
		rawDescription: string,
		repoArg?: string,
	): Promise<string | void | { readonly value: string }> => {
		const guard = workflowIdentityGuard();
		if (guard !== undefined) return guard;
		const balanceGuard = zeroBalanceGuard();
		if (balanceGuard !== undefined) return balanceGuard;
		// §2: `flow.create <description> [owner/repo]` — one argument string
		// for both the slash form and the agent tool.
		const split = repoArg === undefined ? splitDescriptionAndRepo(rawDescription) : { description: rawDescription.trim(), repo: repoArg };
		const description = split.description;
		if (description === "") return "flow.create needs a description of what the workflow should do";
		const target = workflowTargetRepoOrAsk(split.repo, true);
		if ("chooser" in target) return openChooserForWorkflow(target.chooser);
		if ("ask" in target) return askWhichWatchedRepo(description, target.ask);
		const repo = target.repo;
		const provisioned = await provisionWorkspace(repo);
		if (provisioned !== true) return provisioned;
		/*
		 * No pre-flight `listWorkflows` gate here. The live gateway populates
		 * its global pack LAZILY — a cold `listWorkflows` answers with only the
		 * repo's own workflows and `create-workflow` appears moments later — so
		 * gating on that list refuses a workflow the workspace really has.
		 * `launchRun` resolves the registry on a miss and answers NOT_FOUND
		 * honestly, which is the truth worth surfacing.
		 */
		const launched = await launchWorkflow({
			repo,
			workflow: "create-workflow",
			input: { prompt: description },
			title: `Creating a workflow — ${repo}`,
		});
		if (typeof launched === "string") return launched;
		/*
		 * Wave 12 §1: a MINIMAL machine acknowledgment. Wave 11's paragraph of
		 * warnings was the model's only evidence and it rounded up anyway, so the
		 * result stops trying to talk the model out of lying: it states the fact
		 * the client already knows, and the claim surface is the client's.
		 */
		return { value: `run-started workflow=create-workflow run=${launched.runId} repo=${repo}` };
	};

	/**
	 * The workspace's workflows. A repository named explicitly IS the target —
	 * the GitHub pane's Flows tab passes the repository the user opened, which
	 * may not be one of the watched set — so it never resolves the watched list
	 * behind the caller's back and never opens the chooser over a repository
	 * that was named.
	 */
	const listWorkspaceWorkflows = async (
		explicit?: string,
	): Promise<string | void | { readonly value: string }> => {
		const guard = workflowIdentityGuard();
		if (guard !== undefined) return guard;
		let repo: string;
		if (explicit !== undefined && explicit !== "") {
			if (!isWorkflowRepoArg(explicit)) return `"${explicit}" is not an owner/repo name`;
			repo = explicit;
		} else {
			const target = workflowTargetRepo();
			if ("chooser" in target) return openChooserForWorkflow(target.chooser);
			repo = target.repo;
		}
		const provisioned = await provisionWorkspace(repo);
		if (provisioned !== true) return provisioned;
		const list = await workflowRpc(repo, "listWorkflows", {});
		if (list.status !== "ok") return list.message;
		const workflows = parseWorkflowSummaries(list.payload);
		const existing = store.collections.cards.get(`workflow-list-${repo}`);
		const card: Card = {
			id: `workflow-list-${repo}`,
			kind: "workflow-list",
			title: `Workflows — ${repo}`,
			status: "active",
			createdAt: existing?.createdAt ?? Date.now(),
			ordinal: nextTranscriptOrdinal(),
			payload: { repo, workflows },
		};
		store.dispatch({ type: "card.upsert", actor: commandActor, card });
		return {
			value:
				workflows.length === 0
					? `No workflows on ${repo} yet.`
					: `Workflows on ${repo}: ${workflows.map((workflow) => workflow.key).join(", ")}.`,
		};
	};

	const runWorkflow = async (name: string, repoArg?: string): Promise<string | void | { readonly value: string }> => {
		const guard = workflowIdentityGuard();
		if (guard !== undefined) return guard;
		const balanceGuard = zeroBalanceGuard();
		if (balanceGuard !== undefined) return balanceGuard;
		const target = workflowTargetRepo(repoArg);
		if ("chooser" in target) return openChooserForWorkflow(target.chooser);
		const repo = target.repo;
		const provisioned = await provisionWorkspace(repo);
		if (provisioned !== true) return provisioned;
		// Launch first (the gateway's registry is lazy — see createWorkflow); a
		// genuine miss comes back as the gateway's own NOT_FOUND, and only then
		// is it worth naming what the workspace does have.
		const launched = await launchWorkflow({
			repo,
			workflow: name,
			input: {},
			title: `${name} — ${repo}`,
		});
		if (typeof launched === "string") {
			if (!/unknown workflow/i.test(launched)) return launched;
			// A genuine miss: only now is it worth naming what the workspace has.
			const list = await workflowRpc(repo, "listWorkflows", {});
			const available =
				list.status === "ok"
					? parseWorkflowSummaries(list.payload)
							.map((workflow) => workflow.key)
							.slice(0, 8)
							.join(", ")
					: "";
			return `There's no workflow called ${name} on ${repo}${available === "" ? "." : ` — the workspace has: ${available}.`}`;
		}
		// The same minimal acknowledgment (§1): the card is the claim surface.
		return { value: `run-started workflow=${name} run=${launched.runId} repo=${repo}` };
	};

	/*
	 * Wave 12 §3 — the two acts a quiet run offers, both registered commands so
	 * the card's buttons dispatch through the one path everything else does.
	 * "Stop" is stop WATCHING: this seam has no cancelRun, and saying the run was
	 * cancelled would be the same kind of lie §1 is about.
	 */
	const runCardFor = (cardId: string): Extract<Card, { kind: "flow-run" }> | undefined => {
		const card = store.collections.cards.get(cardId);
		return card?.kind === "flow-run" ? card : undefined;
	};

	const stopWatchingRun = (cardId: string): string | void => {
		const card = runCardFor(cardId);
		if (card === undefined) return "That isn't a run card.";
		const pump = runPumps.get(cardId);
		if (pump !== undefined) pump.stopped = true;
		runPumps.delete(cardId);
		pumpPokes.get(cardId)?.();
		patchRunCard(cardId, {
			phase: "stopped",
			steps: [...card.payload.steps, "Stopped watching this run."].slice(-RUN_STEPS_TAIL),
		});
		closeRunStreamIfIdle(card.payload.repo);
		return undefined;
	};

	const retryRunWatch = (cardId: string): string | void => {
		const card = runCardFor(cardId);
		if (card === undefined) return "That isn't a run card.";
		patchRunCard(cardId, {
			phase: "running",
			steps: [...card.payload.steps, "Checking the run again…"].slice(-RUN_STEPS_TAIL),
		});
		void pumpWorkflowRun(cardId);
		return undefined;
	};

	/** Boot reconciliation: a live run card's pump resumes from its lastSeq. */
	const resumeWorkflowRuns = (): void => {
		for (const card of liveRunCards()) void pumpWorkflowRun(card.id);
	};

	const stopWorkflowPumps = (): void => {
		for (const pump of runPumps.values()) pump.stopped = true;
		runPumps.clear();
		pumpPokes.clear();
		for (const source of runStreams.values()) source.close();
		runStreams.clear();
	};

	const forwardApprovalDecision = async (
		card: Extract<Card, { kind: "approval" }>,
		decision: "approved" | "denied",
	): Promise<void> => {
		const { runId, nodeId, iteration, repo } = card.payload;
		let response: Response;
		try {
			response = await http(`${baseUrl}${APPROVAL_DECISION_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					runId,
					nodeId,
					iteration,
					decision: { approved: decision === "approved" },
					// Wave 11: a run's approval round-trips through the per-user
					// gateway for the repo the run lives on.
					...(repo === undefined ? {} : { repo }),
				}),
			});
		} catch {
			store.dispatch({
				type: "card.approval.decision.failed",
				actor: "system",
				id: card.id,
				message: "The decision could not reach the engine. Nothing was recorded — try again.",
			});
			return;
		}
		if (!response.ok) {
			store.dispatch({
				type: "card.approval.decision.failed",
				actor: "system",
				id: card.id,
				message: await errorMessageOf(
					response,
					"The engine did not accept the decision. Nothing was recorded — try again.",
				),
			});
			return;
		}
		const echo = (await response.json().catch(() => undefined)) as
			| { runId?: unknown; nodeId?: unknown; iteration?: unknown; approved?: unknown }
			| undefined;
		if (echo === undefined || typeof echo.approved !== "boolean") {
			store.dispatch({
				type: "card.approval.decision.failed",
				actor: "system",
				id: card.id,
				message: "The engine did not echo the decision, so nothing was recorded — try again.",
			});
			return;
		}
		// The card freezes from the server's echo, never from local optimism.
		store.dispatch({
			type: "card.approval.decided",
			actor: "user",
			id: card.id,
			decision: echo.approved ? "approved" : "denied",
			decidedAt: Date.now(),
		});
	};

	const connectLocalRepository = async (access: RepositoryAccess): Promise<void> => {
		const operation = store.collections.connectorOperations.get("connector-operation");
		if (operation?.phase !== "idle") return;
		store.dispatch({ type: "connector.local.requested", actor: "user", access });
		try {
			const result = await repositories.pickLocalRepository(access);
			switch (result.status) {
				case "connected":
					store.dispatch({
						type: "connector.local.connected",
						actor: "system",
						access,
						repository: result.repository,
					});
					break;
				case "cancelled":
					store.dispatch({ type: "connector.local.cancelled", actor: "user" });
					break;
				case "error":
					store.dispatch({
						type: "connector.local.failed",
						actor: "system",
						message: result.message,
					});
					break;
			}
		} catch {
			store.dispatch({
				type: "connector.local.failed",
				actor: "system",
				message: "The native repository picker stopped responding. Try again.",
			});
		}
	};

	const stop = (): void => {
		if (activeTurn === undefined) return;
		const turn = activeTurn;
		const turnId = turn.id;
		void agent.cancelTurn(turnId);
		activeTurn = undefined;
		/*
		 * §1: stopping does not un-launch the run, so the claim surface still
		 * belongs to the client. Anything the model streamed before the tool call
		 * is already rendered — settling here replaces it with the deterministic
		 * line instead of leaving a half-turn's claim standing.
		 */
		settleRunClaims(turn);
		store.dispatch({
			type: "message.response.cancelled",
			actor: "user",
			turnId,
			detail: "Stopped the current response.",
		});
	};

	const changeDraft = (draft: string): void => {
		store.dispatch({ type: "composer.changed", actor: "user", draft });
	};

	const makeConnectorReadOnly = (id: string): void => {
		store.dispatch({
			type: "connector.access.changed",
			actor: "user",
			id,
			access: "read",
		});
	};

	const removeConnector = (id: string): void => {
		store.dispatch({ type: "connector.removed", actor: "user", id });
	};

	/*
	 * A.34: an id-scoped act used to dispatch blindly, so a note id that does
	 * not exist was a silent no-op — the reducer dropped it and the human was
	 * told nothing. An act names what it could not find.
	 */
	const selectWorldDocument = (id: string): string | void => {
		if (store.collections.worldDocuments.get(id) === undefined) {
			return `There is no ${WORLD_DISPLAY_NAME} note with id ${id}.`;
		}
		store.dispatch({ type: "world.document.selected", actor: "user", id });
	};

	const changeWorldDocument = (id: string, body: string): void => {
		const document = store.collections.worldDocuments.get(id);
		if (document === undefined || document.body === body) return;
		store.dispatch({
			type: "world.document.upserted",
			actor: "user",
			document: updateDocumentBody(document, body),
		});
	};

	const createWorldDocument = (): void => {
		const path = documentPath(store);
		const title = path.replace(/\.md$/, "");
		store.dispatch({
			type: "world.document.upserted",
			actor: commandActor,
			document: {
				id: crypto.randomUUID(),
				path,
				title,
				body: `# ${title}\n\n`,
				links: [],
				tags: [],
				sources: ["user:world-editor"],
				confidence: 1,
			},
		});
	};

	/*
	 * §10.6 / §28.4 / A.34: deleting a note is not undoable, so `/world.delete`
	 * ASKS — from the trash button and from the composer alike. It used to
	 * delete outright whenever it was typed, because the only confirm lived in
	 * a component's local state and the flow bypassed it.
	 */
	const removeWorldDocument = (id: string): string | void => {
		if (store.collections.worldDocuments.get(id) === undefined) {
			return `There is no ${WORLD_DISPLAY_NAME} note with id ${id} to delete.`;
		}
		store.dispatch({ type: "world.delete.asked", actor: commandActor, id });
	};

	/** The human's answer to that question: yes. */
	const confirmWorldDelete = (): string | void => {
		const id = store.session().pendingWorldDeleteId ?? null;
		if (id === null) return "No note is waiting to be deleted.";
		store.dispatch({ type: "world.document.removed", actor: "user", id });
	};

	/** The human's answer to that question: no. */
	const cancelWorldDelete = (): void => {
		store.dispatch({ type: "world.delete.asked", actor: "user", id: null });
	};

	const decideApproval = (id: string, decision: "approved" | "denied"): void => {
		const card = store.collections.cards.get(id);
		if (card === undefined || card.kind !== "approval" || card.status === "acted") return;
		if (card.payload.pending === true) return;
		/*
		 * A chain approval park (DESIGN.md §14): the decision resolves against
		 * the runtime's pending ask, the card freezes, and the SAME lineage
		 * resumes — approved converges under the grant, denied surfaces as an
		 * observation the model routes around. Both decisions resume.
		 */
		if (card.payload.chain === true && card.payload.runId !== undefined) {
			const lineage = card.payload.runId;
			if (agent.resolveApproval === undefined) {
				store.dispatch({
					type: "card.approval.decision.failed",
					actor: "system",
					id,
					message: "This backend cannot resolve approvals.",
				});
				return;
			}
			/*
			 * A turn-lineage decision needs the turn seat free before anything
			 * is consumed: resolving first would burn the one-shot record and
			 * freeze the card while resumeChainTurn no-ops, stranding the park.
			 */
			if (
				card.payload.background !== true &&
				(store.session().phase !== "idle" || activeTurn !== undefined)
			) {
				store.dispatch({
					type: "card.approval.decision.failed",
					actor: "system",
					id,
					message: "Finish or stop the current turn first, then decide this approval.",
				});
				return;
			}
			// The persisted card reconstructs the ask after a reload.
			const ask =
				card.payload.flow === undefined
					? undefined
					: { name: card.payload.flow, claim: card.payload.capability };
			store.dispatch({ type: "card.approval.decision.pending", actor: "user", id });
			void agent.resolveApproval(lineage, decision, ask).then((resolved) => {
				if (!resolved) {
					store.dispatch({
						type: "card.approval.decision.failed",
						actor: "system",
						id,
						message: "That approval is no longer pending.",
					});
					return;
				}
				store.dispatch({
					type: "card.approval.decided",
					actor: "user",
					id,
					decision,
					decidedAt: Date.now(),
				});
				// A background lineage resumed inside the runtime; only a turn
				// lineage re-enters the turn lifecycle here.
				if (card.payload.background !== true) resumeChainTurn(lineage);
			});
			return;
		}
		const { runId, nodeId, iteration } = card.payload;
		if (runId === undefined || nodeId === undefined || iteration === undefined) {
			// A card without a run identity has no backend to decide against —
			// say so honestly instead of fake-freezing it.
			store.dispatch({
				type: "card.approval.decision.failed",
				actor: "system",
				id,
				message: "This approval is not linked to a run, so there is nothing to send the decision to.",
			});
			return;
		}
		store.dispatch({ type: "card.approval.decision.pending", actor: "user", id });
		void forwardApprovalDecision(card, decision);
	};

	/*
	 * Resume a parked chain lineage (DESIGN.md §14): same turn id, fresh
	 * startTurn — the chain replays its settled prefix and re-asks the seam
	 * under the recorded decision. The turn re-enters the ordinary frame
	 * lifecycle, so rendering and settlement need no special path.
	 */
	const resumeChainTurn = (lineage: string): void => {
		if (store.session().phase !== "idle" || activeTurn !== undefined) return;
		activeTurn = {
			id: lineage,
			receivedText: true,
			toolLegs: 0,
			toolItems: [],
			pendingCall: undefined,
			runLaunch: undefined,
			askClass: undefined,
			claimBuffer: "",
		};
		store.dispatch({ type: "chain.turn.resumed", actor: "system", turnId: lineage });
		void agent
			.startTurn({ runId: lineage, messages: contextMessages(), instructions: "" })
			.then((result) => {
				if (result.status === "error") {
					const turn = activeTurn;
					activeTurn = undefined;
					store.dispatch({
						type: "message.response.failed",
						actor: "system",
						turnId: turn?.id ?? lineage,
						message: result.message,
					});
				}
			});
	};

	/*
	 * /retry re-RUNS the last turn — it does not re-SEND the prompt.
	 *
	 * `send` appends a user message, so retrying through it grew the transcript
	 * a duplicate user/assistant pair per attempt and made every retry ship a
	 * longer history than the one before it. The turn keeps its id: the answer
	 * it produced is dropped and the same leg launches again over the context
	 * that produced it.
	 */
	const retryLastTurn = (): void => {
		if (store.session().phase !== "idle" || activeTurn !== undefined) return;
		const last = [...store.collections.messages.values()]
			.filter((message) => message.role === "user")
			.sort((left, right) => right.ordinal - left.ordinal)[0];
		const turnId = last?.id.match(/^message-(.+)-user$/)?.[1];
		if (turnId === undefined) return;
		store.dispatch({ type: "message.retried", actor: "user", turnId });
		if (store.session().phase !== "responding") return;
		activeTurn = {
			id: turnId,
			receivedText: false,
			toolLegs: 0,
			toolItems: [],
			pendingCall: undefined,
			runLaunch: undefined,
			askClass: impossibleAskOf(last?.text ?? ""),
			claimBuffer: "",
		};
		launchLeg(turnId, contextMessages());
	};

	const toggleTheme = (): void => {
		store.dispatch({
			type: "theme.changed",
			actor: "user",
			theme: store.session().theme === "dark" ? "light" : "dark",
		});
	};

	/*
	 * The color theme (/theme), the axis orthogonal to the light/dark toggle.
	 * Which palette to wear is the human's own choice, so an unrecognized key
	 * is never rounded to the nearest one: the answer is the list itself, one
	 * calm line, and a bare /theme states where they already are.
	 */
	const themePickerCard = (): Extract<Card, { kind: "theme-picker" }> | undefined => {
		const card = store.collections.cards.get(THEME_PICKER_CARD_ID);
		return card?.kind === "theme-picker" ? card : undefined;
	};

	/*
	 * Bare /theme answers with the picker card, not a sentence: one swatch per
	 * palette, each painted in its own colors, upserted to the transcript's
	 * tail like the repo chooser. An unrecognized key opens the same picker —
	 * the list of valid answers IS the interface.
	 */
	const openThemePicker = (selected: Palette): void => {
		const existing = themePickerCard();
		let highest = -1;
		for (const message of store.collections.messages.values()) highest = Math.max(highest, message.ordinal);
		for (const card of store.collections.cards.values()) highest = Math.max(highest, card.ordinal);
		store.dispatch({
			type: "card.upsert",
			actor: "user",
			card: {
				id: THEME_PICKER_CARD_ID,
				kind: "theme-picker",
				title: "Color themes",
				status: "active",
				createdAt: existing?.createdAt ?? Date.now(),
				ordinal: highest + 1,
				payload: { selected },
			},
		});
	};

	const setPalette = (args: string): string | void => {
		const requested = args.trim().toLowerCase();
		const current = store.session().palette ?? DEFAULT_PALETTE;
		if (requested === "") {
			openThemePicker(current);
			return;
		}
		if (!isPalette(requested)) {
			openThemePicker(current);
			return `theme needs one of: ${PALETTES.join(", ")}`;
		}
		store.dispatch({ type: "palette.changed", actor: "user", palette: requested });
		// The open picker follows the choice, so its "current" mark stays honest.
		const picker = themePickerCard();
		if (picker !== undefined) {
			store.dispatch({
				type: "card.upsert",
				actor: "user",
				card: { ...picker, payload: { selected: requested } },
			});
		}
	};

	/*
	 * The requirement axis (registry.ts commandRequirements): the registry's
	 * run path parks a user-invoked command here when a requirement is unmet,
	 * and the seams that can satisfy one (identity load, watched-repos
	 * confirm) resume it. Durable in the session row because sign-in is a
	 * full OAuth redirect. One parking spot, latest wins.
	 */
	const deferCommand = (name: string, args: string | null, requirement: string): void => {
		store.dispatch({ type: "command.deferred", actor: "user", name, args, requirement });
	};

	const noteCommandRun = (name: string): void => {
		store.dispatch({ type: "command.ran", actor: "user", name });
	};

	/*
	 * auth.prompt: the agent cannot navigate the user to OAuth (auth.sign-in
	 * is user-only — a model must not yank the page mid-turn), but it CAN
	 * hand the step over: one message whose action IS the sign-in button.
	 * Every identity state answers honestly, including a build with no seam.
	 */
	const promptSignIn = (): void => {
		const identity = store.collections.identitySessions.get("identity");
		if (identity?.state === "signed-in") {
			store.dispatch({
				type: "message.appended",
				actor: "system",
				text: `GitHub is already connected as ${identity.login ?? "you"}.`,
			});
			return;
		}
		if (identity === undefined || identity.state === "unavailable") {
			store.dispatch({
				type: "message.appended",
				actor: "system",
				text: "Sign-in isn't available on this build — no identity service is configured here. Use the deployed app to sign in.",
			});
			return;
		}
		store.dispatch({
			type: "message.appended",
			actor: "system",
			text: "One step connects GitHub: sign in, and Smithers can read the repositories you choose.",
			action: { flow: "auth.sign-in", label: "Sign in with GitHub" },
		});
	};

	/*
	 * The /flows answer: the LIVE visible catalog as one chat message —
	 * the slash menu caps at 8 for calm, so this is where "all of it" lives.
	 * Referenced before `commands` initializes; only ever called after.
	 */
	const showCommandCatalog = (): void => {
		const lines = commands
			.all()
			.filter((command) => command.hidden !== true)
			.map((command) => `- \`/${command.name}\` — ${command.summary}`);
		store.dispatch({
			type: "message.appended",
			actor: "system",
			text: `Everything Smithers can do right now:\n\n${lines.join("\n")}\n\nType \`/\` in the composer to filter these as you type.`,
		});
	};

	/*
	 * The agent's predicted follow-ups (will, 2026-08-19): "if it can predict
	 * what user might ask next like this case 'What is a flow' smithers should
	 * display those as default responses or the ability to trigger a flow as a
	 * / command".
	 *
	 * The boundary validates before anything reaches the store. A question is
	 * the user's own words, so it must be text a person would type — never
	 * empty, never a slash invocation smuggled in as prose. A flow must be one
	 * the HUMAN can invoke from the pill row: registered, listed, and not
	 * hidden id-scoped chrome. Everything else is refused by name in the tool
	 * result, so the model learns what it proposed wrongly instead of watching
	 * a pill silently not appear.
	 */
	const proposeSuggestions = (
		proposals: ReadonlyArray<{ kind: string; label: string; flow?: string; args?: string }>,
	): string | { readonly value: string } => {
		const listed = commands.all().filter((command) => command.hidden !== true);
		const accepted: Array<AgentSuggestion> = [];
		for (const proposal of proposals.slice(0, MAX_AGENT_SUGGESTIONS)) {
			const label = proposal.label.trim();
			if (label === "") return "every suggestion needs a label the user can read";
			if (proposal.kind === "question") {
				if (label.startsWith("/")) {
					return `"${label}" is a command, not a question — propose it as {"kind":"flow","flow":"${label.slice(1).split(/\s/)[0] ?? ""}"}`;
				}
				accepted.push({ kind: "question", label });
				continue;
			}
			if (proposal.kind !== "flow") {
				return `a suggestion's kind is "question" or "flow", not "${proposal.kind}"`;
			}
			const flow = (proposal.flow ?? "").trim().replace(/^\/+/, "");
			const target = listed.find((command) => command.name === flow);
			if (target === undefined) {
				return `no listed flow is named ${flow === "" ? "(nothing)" : flow} — suggest one from the catalog above`;
			}
			const args = proposal.args?.trim();
			accepted.push({
				kind: "flow",
				label,
				flow,
				...(args === undefined || args === "" ? {} : { args }),
			});
		}
		store.dispatch({ type: "agent.suggestions.proposed", actor: "smithers", suggestions: accepted });
		return {
			value:
				accepted.length === 0
					? "cleared the follow-up suggestions"
					: `offering ${accepted.length} follow-up${accepted.length === 1 ? "" : "s"}`,
		};
	};

	const reloadApp = (): void => {
		if (typeof window !== "undefined") window.location.reload();
	};

	/** A deferral older than this resumes nothing: firing it would surprise, not continue. */
	const deferralMaxAgeMs = 15 * 60 * 1000;

	const resumeDeferredCommand = (): void => {
		const pending = store.session().pendingCommand;
		if (pending === undefined || pending === null) return;
		const requirement = flowRequirements.find((candidate) => candidate.id === pending.requirement);
		// Still waiting (or the requirement id no longer exists): leave it parked.
		if (requirement !== undefined && !requirement.satisfied(commands.state())) return;
		store.dispatch({ type: "command.deferral.cleared", actor: "system" });
		if (requirement === undefined || Date.now() - pending.requestedAt > deferralMaxAgeMs) return;
		// The app acting on its own is announced (300ms law does not apply: this
		// IS the act, not its latency) — then the command re-enters the one run
		// path, where the NEXT unmet requirement, if any, parks it again.
		const key = `command.resume.${pending.name}`;
		store.dispatch({ type: "toast.shown", actor: "system", key, title: `Continuing /${pending.name}` });
		void commands.run(pending.name, pending.args ?? undefined).then((outcome) => {
			store.dispatch({
				type: "toast.resolved",
				actor: "system",
				key,
				status: outcome.status === "failed" ? "failed" : "ok",
				detail:
					outcome.status === "failed"
						? outcome.error
						: outcome.status === "unknown-command"
							? `/${pending.name} is no longer a command`
							: `/${pending.name} continued`,
			});
		});
	};

	/*
	 * The agent's entry point ALWAYS runs as actor smithers (wired through
	 * withAgentActor below) — whether it arrives through the streaming tool
	 * loop or a direct executeForAgent call — so agent invocations render
	 * embedded cards and record via:"agent", never user chrome.
	 */
	const commands = createCommandRegistry({
		changeDraft,
		withAgentActor: async <T>(work: () => Promise<T>): Promise<T> => {
			commandActor = "smithers";
			try {
				return await work();
			} finally {
				commandActor = "user";
			}
		},
		reset,
		stop,
		send,
		showChat,
		showWorld,
		showConnectors,
		showGithub,
		showFiles,
		openRepository,
		selectRepositoryTab,
		connectLocalRepository,
		makeConnectorReadOnly,
		removeConnector,
		selectWorldDocument,
		changeWorldDocument,
		createWorldDocument,
		removeWorldDocument,
		confirmWorldDelete,
		cancelWorldDelete,
		decideApproval,
		retryLastTurn,
		openRepoChooser,
		toggleWatchedRepo,
		selectAllWatchedRepos,
		selectNoWatchedRepos,
		confirmWatchedRepos,
		clearConversation,
		openBrowser,
		createWorkflow,
		listWorkspaceWorkflows,
		runWorkflow,
		chooseWorkflowRepo,
		stopWatchingRun,
		retryRunWatch,
		resumeWorkflowRuns,
		maximizeCard,
		minimizeCard,
		toggleActDetail,
		toggleDevtools,
		toggleSurfacesMenu,
		toggleConnectMenu,
		closeConnectMenu,
		setAgentBackend,
		debugSnapshot,
		debugEvents,
		debugChain,
		debugNet,
		netTap,
		resetGrants,
		debugSeams,
		toggleTheme,
		setPalette,
		loadSession,
		signIn,
		signOut,
		requestAccess,
		handleAuthReturn,
		deferCommand,
		resumeDeferredCommand,
		noteCommandRun,
		showCommandCatalog,
		promptSignIn,
		proposeSuggestions,
		reloadApp,
		listIssues: issuesSeam.listIssues,
		viewIssue: issuesSeam.viewIssue,
		createIssue: issuesSeam.createIssue,
		setIssueState: issuesSeam.setIssueState,
		commentOnIssue: issuesSeam.commentOnIssue,
		listLandings: landingsSeam.listLandings,
		viewLanding: landingsSeam.viewLanding,
		createLanding: landingsSeam.createLanding,
		landLanding: landingsSeam.landLanding,
		reviewLanding: landingsSeam.reviewLanding,
		startCheckout: billingSeam.startCheckout,
		openBillingPortal: billingSeam.openBillingPortal,
		listKeys: keysSeam.listKeys,
		removeKey: keysSeam.removeKey,
		listNotifications: notificationsSeam.listNotifications,
		markNotificationsRead: notificationsSeam.markNotificationsRead,
		viewEnvironment: environmentSeam.viewEnvironment,
		setEnvironmentVar: environmentSeam.setEnvironmentVar,
		importRepository: repoImportSeam.importRepository,
		listBookmarks: bookmarksSeam.listBookmarks,
		listFiles: filesSeam.listFiles,
		readFile: filesSeam.readFile,
		checkGitHubApp: appStatusSeam.checkGitHubApp,
		dismissToast,
		refreshBalance,
		showBalance,
		loadFirstRunReco,
		acceptRecommendation,
		editRecommendation,
		dismissRecommendation,
		refreshRecommendation,
		adminAllowlist,
		adminGrant,
		adminGrantConfirm,
		adminGrantCancel,
		adminRequests,
		adminQueueApprove,
		adminFeedback,
		adminHealth,
		snapshot: () => {
			const identity = store.collections.identitySessions.get("identity");
			const watched = store.collections.watchedRepos.get("watched");
			const signedIn = identity?.state === "signed-in";
			return {
				surface: store.session().surface,
				typing: store.session().phase === "responding",
				// Sign-in IS the GitHub connector (§2a′): a valid session means
				// work IS connected, so "connect" stops leading the next actions.
				hasConnectors: signedIn || [...store.collections.connectors.values()].length > 0,
				hasRecommendation: [...store.collections.cards.values()].some(
					(card) => card.kind === "reco" && card.status !== "acted" && card.payload.recommendation !== null,
				),
				// A Vite dev build unlocks the admin plugin (devtools, debug reads)
				// without a session — dev has no identity seam to grant admin, and
				// the machinery panel is exactly what dev needs. Vite serves DEV as
				// the boolean true; production builds and bun tests see
				// undefined/"" (tsc types the field string, hence the cast).
				admin:
					(signedIn && identity.admin) ||
					(import.meta.env?.DEV as boolean | string | undefined) === true,
				needsSelection: signedIn && identity.allowlisted && (watched === undefined || watched.selected === null),
				signedOut: identity?.state === "signed-out",
				recent: store.session().recentCommands ?? [],
				identity:
					identity === undefined
						? "unknown"
						: identity.state === "signed-in"
							? `signed-in as ${identity.login ?? "?"}`
							: identity.state,
			};
		},
	});

	/*
	 * §2.5 / §23.4 — identity is shared between tabs; the app's copy of it was
	 * not. The session cookie is per-origin, so signing in on one tab signs in
	 * every tab, yet a tab that had already read `/api/auth/session` kept
	 * rendering the signed-out card until someone reloaded it by hand — and the
	 * same asymmetry ran the other way after a sign-out.
	 *
	 * A tab re-reads the session whenever it comes back to the foreground, and
	 * a tab that changes identity itself tells its siblings at once. This is a
	 * host subscription, not React lifecycle, so it lives with the state it
	 * corrects.
	 */
	const IDENTITY_CHANNEL = "smithers.identity";
	const watchIdentityAcrossTabs = (): void => {
		if (typeof document === "undefined" || typeof window === "undefined") return;
		let reading = false;
		const reread = (): void => {
			if (reading || document.visibilityState === "hidden") return;
			reading = true;
			void loadSession().finally(() => {
				reading = false;
			});
		};
		document.addEventListener("visibilitychange", reread);
		window.addEventListener("focus", reread);
		if (typeof BroadcastChannel === "undefined") return;
		const channel = new BroadcastChannel(IDENTITY_CHANNEL);
		channel.onmessage = () => {
			// A sibling's identity changed: re-read the seam rather than trust
			// the message — the cookie is the authority, not the announcement.
			void loadSession();
		};
		identityChanged = () => {
			channel.postMessage("changed");
		};
	};

	watchIdentityAcrossTabs();

	const runCommand = (name: string): boolean => {
		if (commands.find(name) === undefined) return false;
		void commands.run(name).then((outcome) => surfaceCommandFailure(name, outcome));
		return true;
	};

	const runCommandArgs = (name: string, args: string): boolean => {
		if (commands.find(name) === undefined) return false;
		void commands.run(name, args).then((outcome) => surfaceCommandFailure(name, outcome));
		return true;
	};

	return {
		store,
		nativeAgentAvailable: agent.available,
		nativeRepositoriesAvailable: repositories.available,
		tappedFetch: http,
		commands,
		slashItems: (needle) => commands.slashItems(needle),
		changeDraft,
		reset,
		stop,
		send,
		showChat,
		showWorld,
		showConnectors,
		showGithub,
		showFiles,
		openRepository,
		selectRepositoryTab,
		runCommand,
		runCommandArgs,
		connectLocalRepository,
		makeConnectorReadOnly,
		removeConnector,
		selectWorldDocument,
		changeWorldDocument,
		createWorldDocument,
		removeWorldDocument,
		confirmWorldDelete,
		cancelWorldDelete,
		decideApproval,
		retryLastTurn,
		openRepoChooser,
		toggleWatchedRepo,
		selectAllWatchedRepos,
		selectNoWatchedRepos,
		confirmWatchedRepos,
		clearConversation,
		openBrowser,
		createWorkflow,
		listWorkspaceWorkflows,
		runWorkflow,
		chooseWorkflowRepo,
		stopWatchingRun,
		retryRunWatch,
		resumeWorkflowRuns,
		maximizeCard,
		minimizeCard,
		toggleActDetail,
		toggleDevtools,
		toggleSurfacesMenu,
		toggleConnectMenu,
		closeConnectMenu,
		setAgentBackend,
		debugSnapshot,
		debugEvents,
		debugChain,
		debugNet,
		netTap,
		resetGrants,
		debugSeams,
		toggleTheme,
		setPalette,
		loadSession,
		signIn,
		signOut,
		requestAccess,
		handleAuthReturn,
		deferCommand,
		resumeDeferredCommand,
		noteCommandRun,
		showCommandCatalog,
		promptSignIn,
		proposeSuggestions,
		reloadApp,
		listIssues: issuesSeam.listIssues,
		viewIssue: issuesSeam.viewIssue,
		createIssue: issuesSeam.createIssue,
		setIssueState: issuesSeam.setIssueState,
		commentOnIssue: issuesSeam.commentOnIssue,
		listLandings: landingsSeam.listLandings,
		viewLanding: landingsSeam.viewLanding,
		createLanding: landingsSeam.createLanding,
		landLanding: landingsSeam.landLanding,
		reviewLanding: landingsSeam.reviewLanding,
		startCheckout: billingSeam.startCheckout,
		openBillingPortal: billingSeam.openBillingPortal,
		listKeys: keysSeam.listKeys,
		removeKey: keysSeam.removeKey,
		listNotifications: notificationsSeam.listNotifications,
		markNotificationsRead: notificationsSeam.markNotificationsRead,
		viewEnvironment: environmentSeam.viewEnvironment,
		setEnvironmentVar: environmentSeam.setEnvironmentVar,
		importRepository: repoImportSeam.importRepository,
		listBookmarks: bookmarksSeam.listBookmarks,
		listFiles: filesSeam.listFiles,
		readFile: filesSeam.readFile,
		checkGitHubApp: appStatusSeam.checkGitHubApp,
		dismissToast,
		refreshBalance,
		showBalance,
		loadFirstRunReco,
		acceptRecommendation,
		editRecommendation,
		dismissRecommendation,
		refreshRecommendation,
		adminAllowlist,
		adminGrant,
		adminGrantConfirm,
		adminGrantCancel,
		adminRequests,
		adminQueueApprove,
		adminFeedback,
		adminHealth,
	};
};
