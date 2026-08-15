/*
 * The binding half of the command registry, ported from flows/ui
 * Commands.ts: every interactive affordance in the app is a registered
 * command, and every trigger (button, pill, slash menu, agent tool) dispatches
 * through the one `run` path below. Launch law: a button with no command
 * behind it is a launch blocker (parity.test.ts gates this).
 */
import type { RepositoryAccess } from "../../shared/NativeRepository";
import { splitTrailingRepo } from "../state/RepoContext";
import type { AppController } from "../state/AppController";
import { PALETTES, WORLD_DISPLAY_NAME } from "../state/AppState";
import type { AgentToolCall, AgentToolSpec } from "./agentTools";
import { agentToolSpecs, executeAgentToolCall, userOnlyError } from "./agentTools";
import type { CommandMeta, CommandState, SlashItem } from "./registry";
import { canonical, commandRequirements, recommendedNames, slashItems, unmetRequirements } from "./registry";

/**
 * What a command execution resolves: undefined, an honest error string, or a
 * success VALUE (`{ value }`) — the payload a tool act hands back to the
 * model (e.g. the browser tool's extracted text). Values never render raw in
 * the transcript (§2b); only executeForAgent reads them.
 */
export type CommandResult = void | string | { readonly value: string };

export interface Command extends CommandMeta {
	readonly execute: (args?: string) => CommandResult | Promise<CommandResult>;
}

export type CommandOutcome =
	| { readonly status: "executed"; readonly value?: string }
	| { readonly status: "unknown-command" }
	| { readonly status: "failed"; readonly error: string };

/**
 * The controller actions commands bind to. This is the AppController surface
 * minus the command methods themselves, so the registry never calls back
 * through its own dispatch path.
 */
export type CommandActions = Omit<
	AppController,
	"store" | "nativeAgentAvailable" | "nativeRepositoriesAvailable" | "slashCommands" | "slashItems" | "runCommand" | "runCommandArgs" | "commands" | "tappedFetch"
> & {
	readonly snapshot: () => CommandState;
	/*
	 * Run work as the AGENT actor: every agent invocation — the streaming
	 * tool loop or a direct executeForAgent — dispatches under actor
	 * smithers, so agent-driven commands render embedded cards and record
	 * via:"agent", never user chrome (THE EMBED LAW, §2c″).
	 */
	readonly withAgentActor: <T>(work: () => Promise<T>) => Promise<T>;
};

export interface CommandRegistry {
	readonly all: () => ReadonlyArray<Command>;
	readonly find: (name: string) => Command | undefined;
	readonly state: () => CommandState;
	readonly slashItems: (needle: string) => Array<SlashItem<Command>>;
	readonly recommended: () => Command;
	readonly run: (name: string, args?: string) => Promise<CommandOutcome>;
	/**
	 * `run` at the agent boundary (requirement axis): an unmet requirement is
	 * an honest failure carrying the reason — never a deferral, because a model
	 * must not enqueue work that fires after its turn ends.
	 */
	readonly runAsAgent: (name: string, args?: string) => Promise<CommandOutcome>;
	/**
	 * The agent's entry point (Wave 3b tool loop): one tool call through the
	 * identical run path buttons and slash use. The result is an honest string
	 * that round-trips to the model as the tool output.
	 */
	readonly executeForAgent: (call: AgentToolCall) => Promise<string>;
	/**
	 * The chain catalog's door: one command as the agent actor, answered as a
	 * TYPED outcome. The string channel executeForAgent returns cannot
	 * distinguish a failure from a success value that happens to start with a
	 * failure prefix; this path never sniffs strings.
	 */
	readonly runForAgent: (name: string, args?: string) => Promise<CommandOutcome>;
	readonly toolSpecs: () => ReadonlyArray<AgentToolSpec>;
}

export const createCommandRegistry = (actions: CommandActions): CommandRegistry => {
	const baseCommands: ReadonlyArray<Command> = [
		{
			name: "connect",
			summary: "Connect work to Smithers",
			execute: () => actions.showConnectors(),
		},
		{
			name: "world",
			summary: `See what Smithers understands (${WORLD_DISPLAY_NAME})`,
			execute: () => actions.showWorld(),
		},
		{
			/*
			 * The color theme, the axis orthogonal to light/dark (/dark-mode
			 * below): `/theme <key>` wears a palette, bare `/theme` answers
			 * with the list and where the human already is. User-only browser
			 * chrome, like every other look-and-feel control.
			 */
			name: "theme",
			summary: "Set the color theme",
			trigger: "user",
			acceptsArgs: true,
			args: PALETTES.join(" | "),
			execute: (args) => actions.setPalette(args ?? ""),
		},
		{
			/*
			 * C-1 (wave 13): the composer's surfaces-menu trigger is a command
			 * like every other affordance — the button dispatches /surfaces,
			 * and /surfaces typed opens the same menu. User-only browser
			 * mechanics, so it never enters the agent's tool catalog.
			 */
			name: "surfaces",
			summary: "Open the surfaces menu",
			trigger: "user",
			execute: () => actions.toggleSurfacesMenu(),
		},
		{
			/*
			 * The light/dark toggle, canonical under its own name since
			 * /theme became the palette command. Listed, because it is the
			 * one control the corner button dispatches.
			 */
			name: "dark-mode",
			summary: "Toggle light and dark mode",
			trigger: "user",
			execute: () => actions.toggleTheme(),
		},
		{ name: "chat", summary: "Back to the conversation", execute: () => actions.showChat() },
		{ name: "retry", summary: "Retry the last turn", execute: () => actions.retryLastTurn() },
		{ name: "chat.stop", summary: "Stop the current response", trigger: "user", execute: () => actions.stop() },
		{ name: "stop", summary: "Stop the current response", aliasOf: "chat.stop", hidden: true, trigger: "user", execute: () => actions.stop() },
		{
			name: "send",
			summary: "Submit the composer",
			trigger: "user",
			acceptsArgs: true,
			args: "<text>",
			execute: (args) => {
				const text = args?.trim() ?? "";
				if (text === "") return "send needs the text to submit";
				actions.send(text);
				return undefined;
			},
		},
		{
			/*
			 * Wave 10 onboarding — the repo chooser, one command three ways:
			 * the card's confirm, /repos.watch, and the agent tool ("watch my
			 * flows repo too" resolves here). An optional repo argument
			 * pre-selects it. Re-running reopens the chooser pre-filled with
			 * the current selection.
			 */
			name: "repos.watch",
			summary: "Choose which repositories Smithers watches",
			acceptsArgs: true,
			args: "[repo]",
			requires: ["signed-in"],
			execute: (args) => actions.openRepoChooser(args?.trim() === "" || args === undefined ? undefined : args.trim()),
		},
		{
			name: "repos.watch.toggle",
			summary: "Toggle a repository in the chooser",
			hidden: true,
			trigger: "user",
			acceptsArgs: true,
			args: "<fullName>",
			execute: (args) => {
				const name = args?.trim() ?? "";
				if (name === "") return "repos.watch.toggle needs a repository name";
				actions.toggleWatchedRepo(name);
				return undefined;
			},
		},
		{
			name: "repos.watch.all",
			summary: "Select every repository in the chooser",
			hidden: true,
			trigger: "user",
			execute: () => actions.selectAllWatchedRepos(),
		},
		{
			name: "repos.watch.none",
			summary: "Select no repositories in the chooser",
			hidden: true,
			trigger: "user",
			execute: () => actions.selectNoWatchedRepos(),
		},
		{
			name: "repos.watch.confirm",
			summary: "Confirm the watched-repositories selection",
			hidden: true,
			trigger: "user",
			execute: () => actions.confirmWatchedRepos(),
		},
		{
			/*
			 * /clear (§2h): sweep the outgoing transcript for what belongs in
			 * world, keep it, THEN clear — a failed sweep clears nothing.
			 */
			name: "clear",
			summary: "Clear the chat, keeping anything worth remembering",
			trigger: "user",
			execute: () => actions.clearConversation(),
		},
		{
			/* The browser tool + surface (§2d/§2d′): read a page; embed its card. */
			name: "browser",
			summary: "Open a web page as a card Smithers can read",
			acceptsArgs: true,
			args: "<url>",
			execute: (args) => {
				const url = args?.trim() ?? "";
				if (url === "") return "browser needs a URL: /browser https://example.com";
				return actions.openBrowser(url);
			},
		},
		{
			/*
			 * Wave 11 — "make me a workflow". The agent invokes this with the
			 * user's description; the run renders as an embedded run card
			 * tracked live from the relay event stream (THE EMBED LAW).
			 */
			name: "workflow.create",
			summary: "Create a Smithers workflow from a description",
			acceptsArgs: true,
			requires: ["signed-in", "repos-selected"],
			/*
			 * Wave 12 §2: a trailing `owner/repo` names the target. Without one
			 * and with more than one watched repo, the chooser-among-watched asks
			 * — the target is a genuine user choice, not a guess.
			 */
			args: "<description> [owner/repo]",
			execute: (args) => {
				const description = args?.trim() ?? "";
				if (description === "") {
					return "workflow.create needs a description of what the workflow should do";
				}
				return actions.createWorkflow(description);
			},
		},
		{
			/*
			 * The answer to the which-repo question — one act, from the card.
			 *
			 * `trigger: "user"` is load-bearing, not decoration. §2 exists because
			 * the target is a GENUINE user choice and nothing may be provisioned on
			 * a guess; a model that can execute this by name answers the human's
			 * question for them and provisions on ITS guess, which is wave 10 §2a
			 * ("a deterministic affordance must not route through the model") one
			 * gate over. Hidden keeps it out of the tool catalog; user-only keeps
			 * it un-executable even by a model that guesses the name.
			 */
			name: "workflow.repo.choose",
			summary: "Choose which watched repository a workflow belongs to",
			hidden: true,
			trigger: "user",
			acceptsArgs: true,
			args: "<owner/repo>",
			execute: (args) => {
				const name = args?.trim() ?? "";
				if (name === "") return "workflow.repo.choose needs a repository name";
				return actions.chooseWorkflowRepo(name);
			},
		},
		{
			/*
			 * Wave 12 §3 — the acts a run that has gone quiet offers. Both are the
			 * human's decision about their own watch, bound to the card's buttons:
			 * hidden from the slash menu and the tool catalog, and user-only so the
			 * model cannot stop (or restart) a watch on the human's behalf.
			 */
			name: "workflow.run.stop",
			summary: "Stop watching a run",
			hidden: true,
			trigger: "user",
			acceptsArgs: true,
			args: "<cardId>",
			execute: (args) => {
				const id = args?.trim() ?? "";
				if (id === "") return "workflow.run.stop needs the card id";
				return actions.stopWatchingRun(id);
			},
		},
		{
			name: "workflow.run.retry",
			summary: "Check a run again",
			hidden: true,
			trigger: "user",
			acceptsArgs: true,
			args: "<cardId>",
			execute: (args) => {
				const id = args?.trim() ?? "";
				if (id === "") return "workflow.run.retry needs the card id";
				return actions.retryRunWatch(id);
			},
		},
		{
			name: "workflow.list",
			summary: "List the workflows on your workspace",
			requires: ["signed-in"],
			execute: () => actions.listWorkspaceWorkflows(),
		},
		{
			name: "workflow.run",
			summary: "Run a workflow on your workspace",
			acceptsArgs: true,
			args: "<name> [owner/repo]",
			requires: ["signed-in", "repos-selected"],
			execute: (args) => {
				const [name, repo] = (args?.trim() ?? "").split(/\s+/);
				if (name === undefined || name === "") return "workflow.run needs a workflow name: /workflow.run create-workflow";
				return actions.runWorkflow(name, repo === undefined || repo === "" ? undefined : repo);
			},
		},
		{
			/* Maximize is the user's explicit act alone (THE EMBED LAW). */
			name: "card.maximize",
			summary: "Maximize a card",
			hidden: true,
			trigger: "user",
			acceptsArgs: true,
			args: "<cardId>",
			execute: (args) => {
				const id = args?.trim() ?? "";
				if (id === "") return "card.maximize needs the card id";
				actions.maximizeCard(id);
				return undefined;
			},
		},
		{
			name: "card.minimize",
			summary: "Minimize the maximized card",
			hidden: true,
			trigger: "user",
			execute: () => actions.minimizeCard(),
		},
		{
			name: "copy-message",
			summary: "Copy a message to the clipboard",
			hidden: true,
			trigger: "user",
			acceptsArgs: true,
			args: "<text>",
			execute: (args) => {
				const text = args ?? "";
				if (text === "") return "copy-message needs the text to copy";
				void navigator.clipboard?.writeText(text);
				return undefined;
			},
		},
		{
			name: "approval.approve",
			summary: "Approve a pending approval card",
			hidden: true,
			acceptsArgs: true,
			args: "<cardId>",
			execute: (args) => {
				const id = args?.trim() ?? "";
				if (id === "") return "approval.approve needs the card id";
				actions.decideApproval(id, "approved");
				return undefined;
			},
		},
		{
			name: "approval.deny",
			summary: "Deny a pending approval card",
			hidden: true,
			acceptsArgs: true,
			args: "<cardId>",
			execute: (args) => {
				const id = args?.trim() ?? "";
				if (id === "") return "approval.deny needs the card id";
				actions.decideApproval(id, "denied");
				return undefined;
			},
		},
		{
			name: "connector.add",
			summary: "Connect a local repository",
			hidden: true,
			acceptsArgs: true,
			args: "<read|read-write>",
			execute: async (args) => {
				const access = args?.trim() ?? "";
				if (access !== "read" && access !== "read-write") {
					return "connector.add needs an access level: read or read-write";
				}
				await actions.connectLocalRepository(access as RepositoryAccess);
				return undefined;
			},
		},
		{
			name: "connector.downgrade",
			summary: "Make a connector read-only",
			hidden: true,
			acceptsArgs: true,
			args: "<connectorId>",
			execute: (args) => {
				const id = args?.trim() ?? "";
				if (id === "") return "connector.downgrade needs the connector id";
				actions.makeConnectorReadOnly(id);
				return undefined;
			},
		},
		{
			name: "connector.remove",
			summary: "Disconnect a repository",
			hidden: true,
			acceptsArgs: true,
			args: "<connectorId>",
			execute: (args) => {
				const id = args?.trim() ?? "";
				if (id === "") return "connector.remove needs the connector id";
				actions.removeConnector(id);
				return undefined;
			},
		},
		{
			name: "world.new-note",
			summary: "Create a world note",
			hidden: true,
			execute: () => actions.createWorldDocument(),
		},
		{
			name: "world.select",
			summary: "Open a world note",
			hidden: true,
			acceptsArgs: true,
			args: "<documentId>",
			execute: (args) => {
				const id = args?.trim() ?? "";
				if (id === "") return "world.select needs the document id";
				actions.selectWorldDocument(id);
				return undefined;
			},
		},
		{
			name: "world.delete",
			summary: "Delete a world note",
			hidden: true,
			acceptsArgs: true,
			args: "<documentId>",
			execute: (args) => {
				const id = args?.trim() ?? "";
				if (id === "") return "world.delete needs the document id";
				actions.removeWorldDocument(id);
				return undefined;
			},
		},
		{
			name: "auth.sign-in",
			summary: "Sign in with GitHub",
			trigger: "user",
			execute: () => actions.signIn(),
		},
		{
			/*
			 * The agent's door to login: it cannot run auth.sign-in (user-only —
			 * navigation is the human's act), but it CAN render the step. The
			 * message's action IS the sign-in button, one click away.
			 */
			name: "auth.prompt",
			summary: "Offer the GitHub sign-in step in the chat",
			execute: () => actions.promptSignIn(),
		},
		{
			name: "auth.sign-out",
			summary: "Sign out of Smithers",
			trigger: "user",
			execute: () => actions.signOut(),
		},
		{
			name: "auth.request-access",
			summary: "Request access to Smithers",
			trigger: "user",
			requires: ["signed-in"],
			execute: () => actions.requestAccess(),
		},
		{
			name: "toast.dismiss",
			summary: "Dismiss a toast notification",
			hidden: true,
			trigger: "user",
			acceptsArgs: true,
			args: "<toastId>",
			execute: (args) => {
				const id = args?.trim() ?? "";
				if (id === "") return "toast.dismiss needs the toast id";
				actions.dismissToast(id);
				return undefined;
			},
		},
		{
			name: "billing.balance",
			summary: "Show your balance",
			requires: ["signed-in"],
			execute: () => actions.showBalance(),
		},
		{
			name: "reco.accept",
			summary: "Accept the current recommendation",
			acceptsArgs: true,
			args: "[cardId]",
			execute: (args) => actions.acceptRecommendation(args?.trim() === "" ? undefined : args?.trim()),
		},
		{
			name: "reco.edit",
			summary: "Edit the current recommendation before running it",
			acceptsArgs: true,
			args: "[cardId]",
			execute: (args) => actions.editRecommendation(args?.trim() === "" ? undefined : args?.trim()),
		},
		{
			name: "reco.dismiss",
			summary: "Dismiss the current recommendation",
			acceptsArgs: true,
			args: "[cardId]",
			execute: (args) => actions.dismissRecommendation(args?.trim() === "" ? undefined : args?.trim()),
		},
		{
			name: "reco.refresh",
			summary: "Read the recommendation again",
			requires: ["signed-in"],
			execute: () => actions.refreshRecommendation(),
		},
		/*
		 * The multi-parity domain commands (MULTI-ACTIONS-GAP.md): issues, PRs
		 * (landings — a land QUEUES, it never "merges"), billing checkout, BYOK
		 * keys, notifications, the agent environment, and repo import.
		 * Repo-scoped commands take a trailing owner/repo token (the
		 * workflow.create precedent); absent one, a single watched repository is
		 * the target and several are an honest choice (RepoContext.ts). They
		 * require signed-in only — an explicit owner/repo must not defer into
		 * the watched-repos chooser.
		 */
		{
			name: "repos.import",
			summary: "Import a GitHub repository into Smithers Cloud",
			acceptsArgs: true,
			args: "[owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				if (rest !== "") return "repos.import takes just an owner/repo name";
				return actions.importRepository(repo);
			},
		},
		{
			name: "issues.list",
			summary: "List a repository's issues",
			acceptsArgs: true,
			args: "[open|closed|all] [owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				const filter = rest === "" ? "open" : rest;
				if (filter !== "open" && filter !== "closed" && filter !== "all") {
					return "issues.list takes open, closed, or all";
				}
				return actions.listIssues(filter, repo);
			},
		},
		{
			name: "issues.view",
			summary: "Open an issue with its comments",
			acceptsArgs: true,
			args: "<number> [owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				const number = Number(rest);
				if (!Number.isInteger(number) || number <= 0) return "issues.view needs an issue number";
				return actions.viewIssue(number, repo);
			},
		},
		{
			name: "issues.create",
			summary: "Create an issue",
			acceptsArgs: true,
			args: "<title> [owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				if (rest === "") return "issues.create needs a title";
				return actions.createIssue(rest, repo);
			},
		},
		{
			name: "issues.close",
			summary: "Close an issue",
			acceptsArgs: true,
			args: "<number> [owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				const number = Number(rest);
				if (!Number.isInteger(number) || number <= 0) return "issues.close needs an issue number";
				return actions.setIssueState(number, "closed", repo);
			},
		},
		{
			name: "issues.reopen",
			summary: "Reopen a closed issue",
			acceptsArgs: true,
			args: "<number> [owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				const number = Number(rest);
				if (!Number.isInteger(number) || number <= 0) return "issues.reopen needs an issue number";
				return actions.setIssueState(number, "open", repo);
			},
		},
		{
			name: "issues.comment",
			summary: "Comment on an issue",
			acceptsArgs: true,
			args: "<number> <text> [owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				const [head, ...tail] = rest.split(/\s+/);
				const number = Number(head);
				const text = tail.join(" ").trim();
				if (!Number.isInteger(number) || number <= 0) return "issues.comment needs an issue number";
				if (text === "") return "issues.comment needs the comment text";
				return actions.commentOnIssue(number, text, repo);
			},
		},
		{
			name: "prs.list",
			summary: "List a repository's pull requests",
			acceptsArgs: true,
			args: "[owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				if (rest !== "") return "prs.list takes just an owner/repo name";
				return actions.listLandings(repo);
			},
		},
		{
			name: "prs.view",
			summary: "Open a pull request with reviews and checks",
			acceptsArgs: true,
			args: "<number> [owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				const number = Number(rest);
				if (!Number.isInteger(number) || number <= 0) return "prs.view needs a pull request number";
				return actions.viewLanding(number, repo);
			},
		},
		{
			name: "prs.create",
			summary: "Open a pull request",
			acceptsArgs: true,
			args: "<title> [from:<bookmark>] [owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				// The source bookmark rides as a `from:<name>` token anywhere in the
				// text; /branches.list shows the choices.
				const tokens = rest.split(/\s+/).filter((token) => token !== "");
				const fromToken = tokens.find((token) => token.startsWith("from:"));
				const from = fromToken?.slice("from:".length);
				const title = tokens.filter((token) => !token.startsWith("from:")).join(" ");
				if (title === "") return "prs.create needs a title";
				if (fromToken !== undefined && (from === undefined || from === "")) {
					return "prs.create's from: token needs a bookmark name — see /branches.list";
				}
				return actions.createLanding(title, repo, from);
			},
		},
		{
			/*
			 * Landing is the human's consequential act (it queues a merge):
			 * user-only, like workflow.repo.choose — the model can show the PR
			 * card, never queue the land itself.
			 */
			name: "prs.land",
			summary: "Land a pull request (queues the merge)",
			trigger: "user",
			acceptsArgs: true,
			args: "<number> [owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				const number = Number(rest);
				if (!Number.isInteger(number) || number <= 0) return "prs.land needs a pull request number";
				return actions.landLanding(number, repo);
			},
		},
		{
			name: "prs.review",
			summary: "Review a pull request",
			acceptsArgs: true,
			args: "<number> approve|request-changes|comment [text] [owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				const [head, verdict, ...tail] = rest.split(/\s+/);
				const number = Number(head);
				if (!Number.isInteger(number) || number <= 0) return "prs.review needs a pull request number";
				const type =
					verdict === "approve" ? "approve"
					: verdict === "request-changes" ? "request_changes"
					: verdict === "comment" ? "comment"
					: undefined;
				if (type === undefined) return "prs.review needs a verdict: approve, request-changes, or comment";
				return actions.reviewLanding(number, type, tail.join(" ").trim(), repo);
			},
		},
		{
			/* Payment flows are the human's act alone: user-only, like sign-in. */
			name: "billing.upgrade",
			summary: "Upgrade your plan (opens Stripe checkout)",
			trigger: "user",
			acceptsArgs: true,
			args: "[plan]",
			requires: ["signed-in"],
			execute: (args) => actions.startCheckout(args?.trim() === "" ? undefined : args?.trim()),
		},
		{
			name: "billing.portal",
			summary: "Manage billing (opens the Stripe portal)",
			trigger: "user",
			requires: ["signed-in"],
			execute: () => actions.openBillingPortal(),
		},
		{
			name: "keys.list",
			summary: "List your provider API keys (masked)",
			requires: ["signed-in"],
			execute: () => actions.listKeys(),
		},
		{
			/* Removing a credential is the human's destructive act: user-only. */
			name: "keys.remove",
			summary: "Remove a provider API key",
			trigger: "user",
			acceptsArgs: true,
			args: "<provider>",
			requires: ["signed-in"],
			execute: (args) => {
				const provider = args?.trim() ?? "";
				if (provider === "") return "keys.remove needs the provider name";
				return actions.removeKey(provider);
			},
		},
		{
			name: "notifications.list",
			summary: "Show your notifications",
			requires: ["signed-in"],
			execute: () => actions.listNotifications(),
		},
		{
			name: "notifications.read",
			summary: "Mark every notification read",
			requires: ["signed-in"],
			execute: () => actions.markNotificationsRead(),
		},
		{
			name: "env.view",
			summary: "Show a repository's agent environment",
			acceptsArgs: true,
			args: "[owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				if (rest !== "") return "env.view takes just an owner/repo name";
				return actions.viewEnvironment(repo);
			},
		},
		{
			name: "env.set",
			summary: "Set an agent-environment variable",
			acceptsArgs: true,
			args: "<NAME=value> [owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				if (rest === "") return "env.set needs a NAME=value pair";
				return actions.setEnvironmentVar(rest, repo);
			},
		},
		{
			name: "branches.list",
			summary: "List a repository's branches (bookmarks)",
			acceptsArgs: true,
			args: "[owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				if (rest !== "") return "branches.list takes just an owner/repo name";
				return actions.listBookmarks(repo);
			},
		},
		{
			/*
			 * Files commands parse the PATH as the first token, always — a lone
			 * `src/x` is a path, never a repo (deterministic beats clever); name
			 * the repo as a second token to cross repositories.
			 */
			name: "files.list",
			summary: "List a repository directory",
			acceptsArgs: true,
			args: "[path] [owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const tokens = (args ?? "").trim().split(/\s+/).filter((token) => token !== "");
				if (tokens.length > 2) return "files.list takes a path and optionally an owner/repo";
				const [first, second] = tokens;
				return actions.listFiles(first ?? "", second);
			},
		},
		{
			name: "files.read",
			summary: "Read a file from a repository",
			acceptsArgs: true,
			args: "<path> [owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const tokens = (args ?? "").trim().split(/\s+/).filter((token) => token !== "");
				const [path, repo] = tokens;
				if (path === undefined || path === "") return "files.read needs a file path";
				if (tokens.length > 2) return "files.read takes a path and optionally an owner/repo";
				return actions.readFile(path, repo);
			},
		},
		{
			name: "repos.app",
			summary: "Check the Smithers GitHub App on a repository",
			acceptsArgs: true,
			args: "[owner/repo]",
			requires: ["signed-in"],
			execute: (args) => {
				const { rest, repo } = splitTrailingRepo(args);
				if (rest !== "") return "repos.app takes just an owner/repo name";
				return actions.checkGitHubApp(repo);
			},
		},
		{
			/* The one-keystroke recovery: reload the window (dev loop, stuck states). */
			name: "reload",
			summary: "Reload the app",
			trigger: "user",
			execute: () => actions.reloadApp(),
		},
		{
			/*
			 * The full catalog as a chat message: the slash menu caps at 8 for
			 * calm, so THIS is where "show me everything" lives — for the user
			 * typed, and for the agent answering "what can you do".
			 */
			name: "commands",
			summary: "List everything Smithers can do",
			execute: () => actions.showCommandCatalog(),
		},
	];

	/*
	 * The admin plugin (Launch Checklist §E — non-enumerable): these commands
	 * REGISTER ONLY when the validated session carries admin:true. For every
	 * other session they are absent from the registry — not hidden, not
	 * disabled — so the enumeration surface (slash menu, agent tool list) of a
	 * non-admin session contains no trace of them, and a direct /name
	 * invocation resolves exactly like any typo.
	 */
	const adminCommands: ReadonlyArray<Command> = [
		{
			/*
			 * The bare reset is admin-only dev tooling (§2): no sweep, nothing
			 * kept. Users get /clear instead. Registered ONLY for admin:true
			 * sessions — for everyone else a direct /reset resolves exactly
			 * like any typo, and no button renders.
			 */
			name: "reset",
			summary: "Start a fresh conversation (dev tooling — nothing is kept)",
			trigger: "user",
			execute: () => actions.reset(),
		},
		{
			/* The admin dev-tools panel (§2b/§2d): the machinery, visible. */
			name: "admin.devtools",
			summary: "Toggle the dev-tools panel",
			trigger: "user",
			execute: () => actions.toggleDevtools(),
		},
		{
			/*
			 * DESIGN.md §14: flip which backend drives a turn. user-only — the
			 * agent must never switch its own engine.
			 */
			name: "debug.backend",
			summary: "Switch the agent backend (proxy | chain)",
			trigger: "user",
			acceptsArgs: true,
			args: "proxy | chain",
			execute: (args) => actions.setAgentBackend(args ?? ""),
		},
		{
			/* The debug reads — one typed surface the panel AND the agent share. */
			name: "debug.snapshot",
			summary: "Read the app state snapshot",
			execute: () => actions.debugSnapshot(),
		},
		{
			name: "debug.events",
			summary: "Read the transition journal tail",
			execute: () => actions.debugEvents(),
		},
		{
			/* Debug mode's chain x-ray (§14): the journal fold, as data. */
			name: "debug.chain",
			summary: "Read the chain journal x-ray",
			execute: () => actions.debugChain(),
		},
		{
			/* Debug mode's wire tap (§14): the controller's fetch ring. */
			name: "debug.net",
			summary: "Read the network tap",
			execute: () => actions.debugNet(),
		},
		{
			/* The session tier's revocation (§14): drop every chain grant. */
			name: "debug.grants.reset",
			summary: "Revoke the chain's session grants",
			trigger: "user",
			execute: () => actions.resetGrants(),
		},
		{
			name: "debug.seams",
			summary: "Probe seam and upstream health",
			execute: () => actions.debugSeams(),
		},
		{
			name: "admin.allowlist.add",
			summary: "Add a GitHub login to the allowlist",
			acceptsArgs: true,
			args: "<login>",
			execute: (args) => {
				const login = args?.trim() ?? "";
				if (login === "") return "admin.allowlist.add needs a login";
				return actions.adminAllowlist("add", login);
			},
		},
		{
			name: "admin.allowlist.remove",
			summary: "Remove a GitHub login from the allowlist",
			acceptsArgs: true,
			args: "<login>",
			execute: (args) => {
				const login = args?.trim() ?? "";
				if (login === "") return "admin.allowlist.remove needs a login";
				return actions.adminAllowlist("remove", login);
			},
		},
		{
			name: "admin.grant",
			summary: "Grant balance to a login (asks for confirmation first)",
			acceptsArgs: true,
			args: "<amountUsd> <login>",
			execute: (args) => {
				const [amountRaw, login] = (args?.trim() ?? "").split(/\s+/);
				const amountUsd = Number(amountRaw);
				if (amountRaw === undefined || !Number.isFinite(amountUsd) || amountUsd <= 0 || login === undefined || login === "") {
					return "admin.grant needs an amount in dollars and a login: /admin.grant 25 octocat";
				}
				return actions.adminGrant(amountUsd, login);
			},
		},
		{
			name: "admin.grant.confirm",
			summary: "Confirm a pending balance grant",
			hidden: true,
			acceptsArgs: true,
			args: "<cardId>",
			execute: (args) => {
				const id = args?.trim() ?? "";
				if (id === "") return "admin.grant.confirm needs the card id";
				return actions.adminGrantConfirm(id);
			},
		},
		{
			name: "admin.grant.cancel",
			summary: "Cancel a pending balance grant",
			hidden: true,
			acceptsArgs: true,
			args: "<cardId>",
			execute: (args) => {
				const id = args?.trim() ?? "";
				if (id === "") return "admin.grant.cancel needs the card id";
				return actions.adminGrantCancel(id);
			},
		},
		{
			name: "admin.requests",
			summary: "Show the request-access queue",
			execute: () => actions.adminRequests(),
		},
		{
			name: "admin.queue.approve",
			summary: "Approve a request-access queue entry",
			hidden: true,
			acceptsArgs: true,
			args: "<login>",
			execute: (args) => {
				const login = args?.trim() ?? "";
				if (login === "") return "admin.queue.approve needs a login";
				return actions.adminQueueApprove(login);
			},
		},
		{
			name: "admin.feedback",
			summary: "Show the recommendation feedback log",
			execute: () => actions.adminFeedback(),
		},
		{
			name: "admin.health",
			summary: "What failed overnight? Service health, charges, queue depth",
			execute: () => actions.adminHealth(),
		},
	];

	const commands = (): ReadonlyArray<Command> =>
		actions.snapshot().admin ? [...baseCommands, ...adminCommands] : baseCommands;

	const find = (name: string): Command | undefined =>
		commands().find((command) => command.name === name);

	/**
	 * The one execution path every trigger (button, pill, slash, agent) shares.
	 * The requirement axis resolves FIRST: a user-invoked command with an unmet
	 * requirement parks durably (actions.deferCommand) and the requirement's
	 * fulfilling command runs in its place — the controller resumes the parked
	 * command when the requirement's predicate flips true. Requirements resolve
	 * one at a time against live state, so a command needing sign-in AND a repo
	 * selection steps through both. `seen` guards a misconfigured requirement
	 * table (a fulfill cycle) with an honest failure instead of recursion.
	 */
	const runAs = async (
		invoker: "user" | "agent",
		name: string,
		args?: string,
		seen: ReadonlySet<string> = new Set(),
	): Promise<CommandOutcome> => {
		const command = find(name);
		if (command === undefined) return { status: "unknown-command" };
		const targetName = canonical(name, commands());
		const target = find(targetName) ?? command;
		const unmet = unmetRequirements(target, actions.snapshot(), commandRequirements)[0];
		if (unmet !== undefined) {
			if (invoker === "agent") {
				/*
				 * The machinery renders the missing sign-in step ITSELF — a model
				 * told about auth.prompt sometimes writes the name as prose
				 * instead of invoking it, and prose is not a button.
				 */
				if (unmet.id === "signed-in") {
					actions.promptSignIn();
					return {
						status: "failed",
						error: `${unmet.reason} — the sign-in step is already rendered in the chat; point the user at it`,
					};
				}
				return { status: "failed", error: `${unmet.reason} — /${target.name} waits on that` };
			}
			if (seen.has(unmet.fulfill)) {
				return {
					status: "failed",
					error: `${unmet.reason} — and /${unmet.fulfill} could not fulfill it`,
				};
			}
			actions.deferCommand(target.name, args ?? null, unmet.id);
			return runAs("user", unmet.fulfill, undefined, new Set([...seen, unmet.fulfill]));
		}
		const result = await target.execute(args);
		if (typeof result === "string") return { status: "failed", error: result };
		// A successful, user-invoked, LISTED command feeds the slash menu's
		// recency ranking; hidden id-scoped acts never rank.
		if (invoker === "user" && target.hidden !== true) actions.noteCommandRun(target.name);
		if (typeof result === "object" && result !== null) return { status: "executed", value: result.value };
		return { status: "executed" };
	};

	const run = (name: string, args?: string): Promise<CommandOutcome> => runAs("user", name, args);

	const registry: CommandRegistry = {
		all: commands,
		find,
		state: actions.snapshot,
		slashItems: (needle) => slashItems(actions.snapshot(), needle, commands()),
		recommended: () => {
			const name = recommendedNames(actions.snapshot())[0];
			const command = name === undefined ? undefined : find(name);
			if (command === undefined) throw new Error("The recommended command is not registered");
			return command;
		},
		run,
		runAsAgent: (name, args) => runAs("agent", name, args),
		executeForAgent: (call) => actions.withAgentActor(() => executeAgentToolCall(registry, call)),
		runForAgent: (name, args) =>
			actions.withAgentActor(async () => {
				const clean = name.trim().replace(/^\/+/, "");
				const target = commands().find((command) => command.name === clean);
				if (target !== undefined && target.trigger === "user") {
					return { status: "failed", error: userOnlyError(clean) };
				}
				return runAs("agent", clean, args);
			}),
		toolSpecs: () => agentToolSpecs,
	};
	return registry;
};
