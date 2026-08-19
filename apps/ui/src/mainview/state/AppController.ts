import type { RepositoryAccess } from "smithers-shared/NativeRepository";
import type { AgentChatMessage, AgentTurnFrame, FetchLike } from "smithers-shared/NativeAgent";
import {
	APPROVAL_DECISION_PATH,
	WORKFLOW_EVENTS_PATH,
	WORKFLOW_PROVISION_PATH,
	WORKFLOW_RPC_PATH,
	WORKFLOW_STREAM_PATH,
} from "smithers-shared/AgentApiRoutes";
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge";
import { createCommandRegistry } from "../flows/Commands";
import type { CommandRegistry } from "../flows/Commands";
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
import type { ImpossibleAskClass } from "./Instructions";
import { smithersInstructions } from "./Instructions";
import { agentVisibleCatalog } from "../flows/agentTools";
import { CardPatchSchema, CardSchema } from "./AppState";
import type { Card } from "./AppState";
import type { AppStore } from "./AppStore";
import { AGENT_RUNTIME_CONTEXT_VERSION } from "smithers-shared/AgentContext";
import type { AgentRuntimeContext } from "smithers-shared/AgentContext";
import { createControllerContext } from "./controller/context";
import type { ActiveTurn, PendingToolCall } from "./controller/context";
import { createFailureController, ZERO_BALANCE_EXHAUSTED_TEXT } from "./controller/failures";
import { createWorldController } from "./controller/world";
import { createPresentationController } from "./controller/presentation";
import { createConnectorController } from "./controller/connectors";
import { createAuthBillingController } from "./controller/auth-billing";
import { createWorkflowController } from "./controller/workflows";
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
const CHAIN_SURFACE_CALLS = new Set(["author", "say", "card.show", "card.update"]);
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
	readonly listWorkspaceWorkflows: () => Promise<string | void | { readonly value: string }>;
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
	/* The admin dev-tools panel + debug reads (§2b/§2d; admin registry only). */
	readonly toggleDevtools: () => void;
	/** Report what drives a turn (admin /debug.backend; DESIGN.md §14). */
	readonly describeAgentBackend: (backend: string) => string | { readonly value: string };
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
	const ctx = createControllerContext(store, repositories, agent, services);
	const { baseUrl, http, boundedFetch, errorMessageOf, unref, workflowPollMs } = ctx;
	const { withToast, dismissToast, surfaceCommandFailure } = createFailureController(ctx);
	ctx.withToast = withToast;

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
		actor: () => ctx.commandActor,
		nextOrdinal: nextTranscriptOrdinal,
	};
	const issuesSeam = createIssuesSeam(seamCtx);
	const landingsSeam = createLandingsSeam(seamCtx);
	const billingSeam = createBillingSeam(seamCtx);
	const keysSeam = createKeysSeam(seamCtx);
	const notificationsSeam = createNotificationsSeam(seamCtx);
	const environmentSeam = createEnvironmentSeam(seamCtx);
	const repoImportSeam = createRepoImportSeam(seamCtx);
	const bookmarksSeam = createBookmarksSeam(seamCtx);
	const filesSeam = createFilesSeam(seamCtx);
	const appStatusSeam = createAppStatusSeam(seamCtx);

	const {
		handleAuthReturn,
		loadSession,
		signIn,
		signOut,
		requestAccess,
		refreshBalance,
		showBalance,
		adminAllowlist,
		adminGrant,
		adminGrantConfirm,
		adminGrantCancel,
		adminRequests,
		adminQueueApprove,
		adminFeedback,
		adminHealth,
		settleTurnBilling,
		watchIdentityAcrossTabs,
	} = createAuthBillingController(ctx, nextTranscriptOrdinal);

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
	ctx.contextMessages = contextMessages;

	/*
	 * The hidden runtime context, freshly derived from live collections on EVERY
	 * turn leg (never cached): the server boundary renders it into the upstream
	 * instructions, so the model truthfully knows it runs inside the Smithers
	 * product. It is never dispatched, so it never enters the persisted visible
	 * transcript; it carries no secrets (only state the client already holds).
	 */
	const agentRuntimeContext = (): AgentRuntimeContext => {
		const snapshot = store.agentContextSnapshot();
		const current = store.session();
		const identity = store.collections.identitySessions.get("identity");
		const watched = store.collections.watchedRepos.get("watched");
		const billingAccount = store.collections.billingAccounts.get("billing");
		const selected =
			current.selectedWorldDocumentId === null
				? undefined
				: store.collections.worldDocuments.get(current.selectedWorldDocumentId);
		return {
			version: AGENT_RUNTIME_CONTEXT_VERSION,
			product: "smithers",
			capturedAt: snapshot.capturedAt,
			revision: snapshot.revision,
			surface: current.surface,
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
			 * §22.7: the client holds the balance; the model did not, so asked
			 * for it, it answered "$0.00" one line above a card its own tool call
			 * had just rendered reading "$519 left".
			 */
			billing:
				billingAccount === undefined
					? null
					: {
							state: billingAccount.state,
							totalUsd: billingAccount.totalUsd,
							lifetimeChargedUsd: billingAccount.lifetimeChargedUsd,
							chargeCount: billingAccount.chargeCount,
						},
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
				if (result.status !== "error" || ctx.activeTurn?.id !== turnId) return;
				const turn = ctx.activeTurn;
				ctx.activeTurn = undefined;
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
				if (ctx.activeTurn?.id !== turnId) return;
				const turn = ctx.activeTurn;
				ctx.activeTurn = undefined;
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
		if (ctx.activeTurn?.id !== turn.id) return;
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
		store.dispatch({
			type: "message.tool.executed",
			actor: "smithers",
			turnId: turn.id,
			text: toolActLine(call, result),
		});
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
		if (frame.runId !== ctx.activeTurn?.id) return;
		if (frame.type === "card" || frame.type === "card.update") {
			handleCardFrame(frame);
			return;
		}
		if (frame.type === "tool_call") {
			// The model asked for a command; the done frame right after it ends
			// this leg, and the continuation is driven from there.
			ctx.activeTurn.pendingCall = { callId: frame.call_id, name: frame.name, args: frame.arguments };
			return;
		}
		if (frame.type === "delta") {
			if (frame.text === "") return;
			if (frame.kind === "text") {
				ctx.activeTurn.receivedText = true;
				/*
				 * Wave 12 §1: after a run launch the model's words are held until
				 * the turn settles, so a claim is never rendered even for the beat
				 * it would take to stream. Reasoning is unaffected — it is not the
				 * answer, and the substitution replaces the answer.
				 * Wave 13c: the same hold applies when the user's ask named an
				 * impossible class — the offer is reviewed before it renders.
				 */
				if (ctx.activeTurn.runLaunch !== undefined || ctx.activeTurn.askClass !== undefined) {
					ctx.activeTurn.claimBuffer += frame.text;
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
			ctx.activeTurn.receivedText = true;
			return;
		}
		if (frame.type === "call.settled") {
			// Wave 12 parity: a settled launch call arms the deterministic claim
			// surface exactly as the tool loop did, so the model's prose about
			// the run substitutes at settle instead of rendering as a claim.
			if (RUN_LAUNCH_COMMANDS.includes(frame.name)) {
				ctx.activeTurn.runLaunch = frame.name;
			}
			if (!CHAIN_SURFACE_CALLS.has(frame.name) && !frame.name.startsWith("sys/")) {
				store.dispatch({
					type: "message.tool.executed",
					actor: "smithers",
					turnId: frame.runId,
					text: `Smithers ran /${frame.name}`,
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
			store.dispatch({
				type: "message.tool.executed",
				actor: "smithers",
				turnId: frame.runId,
				text: "Smithers adjusted its approach",
			});
			return;
		}
		if (frame.type === "steering.drained") {
			store.dispatch({
				type: "message.tool.executed",
				actor: "smithers",
				turnId: frame.runId,
				text: "Smithers picked up your note",
			});
			return;
		}
		if (frame.type !== "done") return;
		const turn = ctx.activeTurn;
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
				ctx.activeTurn = undefined;
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
		ctx.activeTurn = undefined;
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
			const turn = ctx.activeTurn;
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
		ctx.activeTurn = {
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
		store.dispatch({ type: "message.submitted", actor: ctx.commandActor, turnId, text: prompt });
		launchLeg(turnId, contextMessages());
	};

	const reset = (): void => {
		if (ctx.activeTurn !== undefined) void agent.cancelTurn(ctx.activeTurn.id);
		ctx.activeTurn = undefined;
		stopWorkflowPumps();
		store.dispatch({ type: "conversation.reset", actor: "user" });
	};

	const {
		showChat, showWorld, showConnectors, maximizeCard, minimizeCard, toggleDevtools,
		toggleSurfacesMenu, toggleConnectMenu, closeConnectMenu, describeAgentBackend,
		debugSnapshot, debugEvents, debugChain, netTap, debugNet, resetGrants, debugSeams,
		openBrowser, toggleTheme, setPalette,
	} = createPresentationController(ctx, adminHealth);

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
		ctx.runStreams.get(repo)?.close();
		ctx.runStreams.delete(repo);
	};

	const ensureRunStream = (repo: string): void => {
		if (typeof EventSource === "undefined" || ctx.runStreams.has(repo)) return;
		try {
			const source = new EventSource(`${baseUrl}${WORKFLOW_STREAM_PATH}?repo=${encodeURIComponent(repo)}`);
			// A change frame means fresh state exists NOW — poke this repo's pumps
			// instead of waiting out the poll cadence. EventSource reconnects on
			// its own and replays via Last-Event-ID through the seam; the poll
			// loop below is the floor, so a dead stream never stalls a card.
			source.addEventListener("change", () => {
				for (const card of liveRunCards(repo)) ctx.pumpPokes.get(card.id)?.();
			});
			ctx.runStreams.set(repo, source);
		} catch {
			// The poll cadence alone carries the run card.
		}
	};

	const pokeableWait = (cardId: string, ms: number): Promise<void> =>
		new Promise((resolve) => {
			const timer = setTimeout(() => {
				ctx.pumpPokes.delete(cardId);
				resolve();
			}, ms);
			unref(timer);
			ctx.pumpPokes.set(cardId, () => {
				clearTimeout(timer);
				ctx.pumpPokes.delete(cardId);
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
		if (ctx.runPumps.has(cardId)) return;
		const pump = { stopped: false };
		ctx.runPumps.set(cardId, pump);
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
			if (ctx.runPumps.get(cardId) === pump) {
				ctx.pumpPokes.delete(cardId);
				ctx.runPumps.delete(cardId);
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
		store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card });
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
			actor: ctx.commandActor,
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

	const listWorkspaceWorkflows = async (): Promise<string | void | { readonly value: string }> => {
		const guard = workflowIdentityGuard();
		if (guard !== undefined) return guard;
		const target = workflowTargetRepo();
		if ("chooser" in target) return openChooserForWorkflow(target.chooser);
		const repo = target.repo;
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
		store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card });
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
		const pump = ctx.runPumps.get(cardId);
		if (pump !== undefined) pump.stopped = true;
		ctx.runPumps.delete(cardId);
		ctx.pumpPokes.get(cardId)?.();
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
	ctx.resumeWorkflowRuns = resumeWorkflowRuns;

	const stopWorkflowPumps = (): void => {
		for (const pump of ctx.runPumps.values()) pump.stopped = true;
		ctx.runPumps.clear();
		ctx.pumpPokes.clear();
		for (const source of ctx.runStreams.values()) source.close();
		ctx.runStreams.clear();
	};
	ctx.stopWorkflowPumps = stopWorkflowPumps;
	const {
		clearConversation,
		selectWorldDocument,
		changeWorldDocument,
		createWorldDocument,
		removeWorldDocument,
		confirmWorldDelete,
		cancelWorldDelete,
	} = createWorldController(ctx);

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


	const stop = (): void => {
		if (ctx.activeTurn === undefined) return;
		const turn = ctx.activeTurn;
		const turnId = turn.id;
		void agent.cancelTurn(turnId);
		ctx.activeTurn = undefined;
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
				(store.session().phase !== "idle" || ctx.activeTurn !== undefined)
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
		if (store.session().phase !== "idle" || ctx.activeTurn !== undefined) return;
		ctx.activeTurn = {
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
					const turn = ctx.activeTurn;
					ctx.activeTurn = undefined;
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
		if (store.session().phase !== "idle" || ctx.activeTurn !== undefined) return;
		const last = [...store.collections.messages.values()]
			.filter((message) => message.role === "user")
			.sort((left, right) => right.ordinal - left.ordinal)[0];
		const turnId = last?.id.match(/^message-(.+)-user$/)?.[1];
		if (turnId === undefined) return;
		store.dispatch({ type: "message.retried", actor: "user", turnId });
		if (store.session().phase !== "responding") return;
		ctx.activeTurn = {
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
	ctx.resumeDeferredCommand = resumeDeferredCommand;

	const {
		openRepoChooser,
		toggleWatchedRepo,
		selectAllWatchedRepos,
		selectNoWatchedRepos,
		confirmWatchedRepos,
		loadFirstRunReco,
		acceptRecommendation,
		editRecommendation,
		dismissRecommendation,
		refreshRecommendation,
		connectLocalRepository,
		makeConnectorReadOnly,
		removeConnector,
	} = createConnectorController(ctx, send, promptSignIn);

	/*
	 * The agent's entry point ALWAYS runs as actor smithers (wired through
	 * withAgentActor below) — whether it arrives through the streaming tool
	 * loop or a direct executeForAgent call — so agent invocations render
	 * embedded cards and record via:"agent", never user chrome.
	 */
	const commands = createCommandRegistry({
		changeDraft,
		withAgentActor: async <T>(work: () => Promise<T>): Promise<T> => {
			ctx.commandActor = "smithers";
			try {
				return await work();
			} finally {
				ctx.commandActor = "user";
			}
		},
		reset,
		stop,
		send,
		showChat,
		showWorld,
		showConnectors,
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
		toggleDevtools,
		toggleSurfacesMenu,
		toggleConnectMenu,
		closeConnectMenu,
		describeAgentBackend,
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
	ctx.commands = commands;

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
		toggleDevtools,
		toggleSurfacesMenu,
		toggleConnectMenu,
		closeConnectMenu,
		describeAgentBackend,
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
