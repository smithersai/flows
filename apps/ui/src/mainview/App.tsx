import {
	Badge,
	Button,
	ChatComposer,
	ChatMessage,
	ChatTranscript,
	EmptyState,
	FileTree,
	Markdown,
	Marker,
	Reasoning,
	SmithersUiStyles,
	Suggestion,
	SuggestionGroup,
} from "@smthrs/ui";
import {
	MarkdownEditor,
	MarkdownEditorStyles,
} from "@smthrs/ui/adapters/markdown-editor";
import {
	BookOpen,
	ChevronDown,
	Copy,
	FolderGit2,
	GitPullRequest,
	HardDrive,
	Moon,
	Plug,
	Plus,
	RotateCcw,
	Server,
	Sparkles,
	Sun,
	Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { CardView } from "./ChatCards";
import { ConnectorsSurface } from "./ConnectorsSurface";
import { DevtoolsPanel } from "./DevtoolsPanel";
import { ConfirmDialog, SurfaceHeader } from "./SurfaceChrome";
import { ToastStack } from "./ToastStack";
import type { AppController } from "./state/AppController";
import { scrubToolEcho } from "./state/MessageScrub";
import type { Card, Message, Suggestion as SuggestionBinding } from "./state/AppState";
import { WORLD_DISPLAY_NAME } from "./state/AppState";

const timeLabel = (createdAt: number) =>
	new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const systemNoteLabel = (message: Message): string => {
	if (message.statusDetail !== undefined) return `Turn interrupted — ${message.statusDetail}`;
	return message.status === "failed" ? "Turn failed" : "Turn interrupted";
};

type TranscriptEntry =
	| { readonly kind: "message"; readonly message: Message }
	| { readonly kind: "card"; readonly card: Card };

const entryOrdinal = (entry: TranscriptEntry): number =>
	entry.kind === "message" ? entry.message.ordinal : entry.card.ordinal;

const entryCreatedAt = (entry: TranscriptEntry): number =>
	entry.kind === "message" ? entry.message.createdAt : entry.card.createdAt;

function CopyMessageButton({
	text,
	onCopy,
}: {
	readonly text: string;
	readonly onCopy: (text: string) => void;
}) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			variant="ghost"
			size="icon"
			className="message-action"
			data-flow="copy-message"
			aria-label={copied ? "Copied" : "Copy message"}
			title={copied ? "Copied" : "Copy message"}
			onClick={() => {
				onCopy(text);
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1200);
			}}
		>
			{copied ? <span className="message-action-copied">Copied</span> : <Copy size={12} />}
		</Button>
	);
}

/*
 * The composer's surface menu (§2c′): the surface buttons collapse into ONE
 * compact dropdown so the toolbar never accumulates horizontally. Every
 * entry is a direct command binding (never a prompt string), state-aware,
 * keyboard-complete (ArrowDown opens, arrows move, Enter invokes, Escape
 * closes). `/` remains the full command surface; this is the pointer subset.
 *
 * C-1 (wave 13): the trigger itself is the /surfaces command — the open state
 * lives in the session collection and the button dispatches through the
 * registry, so the affordance and the command are the same act.
 */
function ComposerMenu({
	controller,
	surface,
	open,
}: {
	readonly controller: AppController;
	readonly surface: "chat" | "world" | "connectors";
	readonly open: boolean;
}) {
	const [highlighted, setHighlighted] = useState(0);
	const menuRef = useRef<HTMLDivElement>(null);

	/* A pointer press outside the menu dismisses it without moving focus. */
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent): void => {
			const root = menuRef.current;
			if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
				controller.runCommand("surfaces");
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open, controller]);

	const entries = [
		{
			command: "connect",
			label: "Connect",
			icon: <Plug size={14} aria-hidden="true" />,
			active: surface === "connectors",
		},
		{
			command: "world",
			label: WORLD_DISPLAY_NAME,
			icon: <BookOpen size={14} aria-hidden="true" />,
			active: surface === "world",
		},
	] as const;

	const openMenu = (): void => {
		setHighlighted(0);
		controller.runCommand("surfaces");
		requestAnimationFrame(() => {
			document.querySelector<HTMLButtonElement>(".composer-menu-item")?.focus();
		});
	};

	const closeMenu = (): void => {
		controller.runCommand("surfaces");
		requestAnimationFrame(() => {
			document.querySelector<HTMLButtonElement>(".composer-menu-trigger")?.focus();
		});
	};

	const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
		if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			if (open) {
				closeMenu();
			} else {
				openMenu();
			}
		}
	};

	const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			closeMenu();
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const next =
				event.key === "ArrowDown"
					? (highlighted + 1) % entries.length
					: (highlighted + entries.length - 1) % entries.length;
			setHighlighted(next);
			document
				.querySelectorAll<HTMLButtonElement>(".composer-menu-item")
				.item(next)
				?.focus();
		}
	};

	return (
		<div className="composer-menu" ref={menuRef}>
			<Button
				variant="ghost"
				size="sm"
				className="composer-action composer-menu-trigger"
				data-flow="surfaces"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label="Surfaces"
				title="Surfaces"
				onClick={() => (open ? closeMenu() : openMenu())}
				onKeyDown={onTriggerKeyDown}
			>
				<Plug size={14} aria-hidden="true" />
				<ChevronDown size={12} aria-hidden="true" />
			</Button>
			{open ? (
				<div className="composer-menu-list" role="menu" aria-label="Surfaces" onKeyDown={onMenuKeyDown}>
					{entries.map((entry, index) => (
						<button
							type="button"
							key={entry.command}
							role="menuitem"
							className="composer-menu-item"
							data-flow={entry.command}
							data-active={entry.active}
							aria-pressed={entry.active}
							tabIndex={index === highlighted ? 0 : -1}
							onFocus={() => setHighlighted(index)}
							onClick={() => {
								if (open) controller.runCommand("surfaces");
								controller.runCommand(entry.command);
							}}
						>
							{entry.icon}
							{entry.label}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}

/*
 * The composer's connect corner (bottom-left): the connection state as a chip,
 * the repository origins as a menu. Disconnected it reads "Connect";
 * connected it names the repository (`+N` for the rest) or the GitHub login.
 * Every entry is a command binding: local repositories pick through
 * connector.add, GitHub through auth.sign-in / repos.watch, Smithers Cloud
 * stays an honest "coming soon", and full management is one entry away
 * through /connect.
 */
function ComposerConnect({ controller }: { readonly controller: AppController }) {
	const { collections } = controller.store;
	const { data: connectorRows } = useLiveQuery(collections.connectors);
	const { data: operationRows } = useLiveQuery(collections.connectorOperations);
	const { data: identityRows } = useLiveQuery(collections.identitySessions);
	const [open, setOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	/* A pointer press outside the menu dismisses it without moving focus. */
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent): void => {
			const root = menuRef.current;
			if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);

	const connectors = [...connectorRows].sort((left, right) => left.name.localeCompare(right.name));
	const operation =
		operationRows.find((candidate) => candidate.id === "connector-operation") ??
		collections.connectorOperations.get("connector-operation");
	const selecting = operation?.phase === "selecting-local-repository";
	const identity = identityRows[0];
	const signedIn = identity?.state === "signed-in";
	const connected = signedIn || connectors.length > 0;
	const label =
		connectors.length > 0
			? `${connectors[0].name}${connectors.length > 1 ? ` +${connectors.length - 1}` : ""}`
			: signedIn
				? `GitHub · ${identity?.login ?? "connected"}`
				: "Connect";

	const toggleConnectMenu = (): void => {
		setOpen(!open);
		if (!open) {
			requestAnimationFrame(() => {
				document
					.querySelector<HTMLButtonElement>(".composer-connect-list .composer-menu-item:enabled")
					?.focus();
			});
		}
	};

	const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			setOpen(false);
			document.querySelector<HTMLButtonElement>(".composer-connect-trigger")?.focus();
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const items = Array.from(
				event.currentTarget.querySelectorAll<HTMLButtonElement>(".composer-menu-item:enabled"),
			);
			if (items.length === 0) return;
			const current = items.indexOf(document.activeElement as HTMLButtonElement);
			const next =
				event.key === "ArrowDown"
					? (current + 1) % items.length
					: (current - 1 + items.length) % items.length;
			items[next]?.focus();
		}
	};

	return (
		<div className="composer-menu composer-connect" ref={menuRef}>
			<Button
				variant="ghost"
				size="sm"
				className="composer-action composer-connect-trigger"
				data-flow="connect"
				data-connected={connected}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={connected ? `Connected: ${label}` : "Connect a repository"}
				title={connected ? "Connected repositories" : "Connect a repository"}
				onClick={toggleConnectMenu}
			>
				{connectors.length > 0 ? (
					<FolderGit2 size={14} aria-hidden="true" />
				) : (
					<Plug size={14} aria-hidden="true" />
				)}
				<span className="composer-connect-label">{label}</span>
				<ChevronDown size={12} aria-hidden="true" />
			</Button>
			{open ? (
				<div
					className="composer-menu-list composer-connect-list"
					role="menu"
					aria-label="Repository connections"
					onKeyDown={onMenuKeyDown}
				>
					{connectors.map((connector) => (
						<button
							type="button"
							key={connector.id}
							role="menuitem"
							className="composer-menu-item"
							data-flow="connect"
							data-active="true"
							onClick={() => {
								setOpen(false);
								controller.runCommand("connect");
							}}
						>
							<FolderGit2 size={14} aria-hidden="true" />
							<span className="composer-connect-name">{connector.name}</span>
							<span className="composer-connect-branch">{connector.branch ?? "detached"}</span>
						</button>
					))}
					{controller.nativeRepositoriesAvailable ? (
						<button
							type="button"
							role="menuitem"
							className="composer-menu-item"
							data-flow="connector.add"
							disabled={selecting}
							onClick={() => {
								setOpen(false);
								controller.runCommandArgs("connector.add", "read");
							}}
						>
							<HardDrive size={14} aria-hidden="true" />
							{selecting ? "Choosing a repository…" : "Add local repository…"}
						</button>
					) : null}
					{signedIn ? (
						<button
							type="button"
							role="menuitem"
							className="composer-menu-item"
							data-flow="repos.watch"
							onClick={() => {
								setOpen(false);
								controller.runCommand("repos.watch");
							}}
						>
							<GitPullRequest size={14} aria-hidden="true" />
							Choose GitHub repositories…
						</button>
					) : (
						<button
							type="button"
							role="menuitem"
							className="composer-menu-item"
							data-flow="auth.sign-in"
							onClick={() => {
								setOpen(false);
								controller.runCommand("auth.sign-in");
							}}
						>
							<GitPullRequest size={14} aria-hidden="true" />
							Connect GitHub…
						</button>
					)}
					<button
						type="button"
						role="menuitem"
						className="composer-menu-item"
						data-flow="repos.import"
						onClick={() => {
							setOpen(false);
							controller.runCommand("repos.import");
						}}
					>
						<Server size={14} aria-hidden="true" />
						Import to Smithers Cloud…
					</button>
					<button
						type="button"
						role="menuitem"
						className="composer-menu-item"
						data-flow="connect"
						onClick={() => {
							setOpen(false);
							controller.runCommand("connect");
						}}
					>
						<Plug size={14} aria-hidden="true" />
						Open connectors
					</button>
				</div>
			) : null}
		</div>
	);
}

function App({ controller }: { readonly controller: AppController }) {
	const { collections } = controller.store;
	const { data: messageRows } = useLiveQuery(collections.messages);
	const { data: sessionRows } = useLiveQuery(collections.sessions);
	const { data: worldDocumentRows } = useLiveQuery(collections.worldDocuments);
	const { data: cardRows } = useLiveQuery(collections.cards);
	const { data: identityRows } = useLiveQuery(collections.identitySessions);
	const { data: billingRows } = useLiveQuery(collections.billingAccounts);
	const { data: toastRows } = useLiveQuery(collections.toasts);
	const { data: watchedRows } = useLiveQuery(collections.watchedRepos);
	const [slashMenu, setSlashMenu] = useState<{ draft: string; index: number; dismissed: boolean }>({
		draft: "",
		index: 0,
		dismissed: false,
	});
	const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
	const messages = [...messageRows].sort((left, right) => left.ordinal - right.ordinal);
	const worldDocuments = [...worldDocumentRows].sort((left, right) =>
		left.path.localeCompare(right.path),
	);
	const session = sessionRows[0] ?? controller.store.session();
	const selectedWorldDocument =
		worldDocuments.find((document) => document.id === session.selectedWorldDocumentId) ??
		worldDocuments[0];
	const typing = session.phase === "responding";
	const dark = session.theme === "dark";
	const streamingMessageId = typing ? messages[messages.length - 1]?.id : undefined;
	const identity = identityRows[0];
	const billing = billingRows[0];
	const toasts = [...toastRows].sort((left, right) => left.createdAt - right.createdAt);
	/*
	 * One page: the chat. Auth is a conversation state, never a view — a
	 * definitive signed-out or non-allowlisted answer opens the transcript
	 * with the Smithers message whose action IS the one available step.
	 * "Unknown" is not a definitive answer and changes nothing. "Unavailable"
	 * IS one about the BUILD: a deployment with no identity seam can never
	 * sign in, and pretending otherwise walked live users into empty choosers
	 * and dead sign-in flows — so the state names itself up front, once,
	 * derived like the rest (never stored, gone the moment a seam answers).
	 */
	const authMessage: Message | undefined =
		identity?.state === "signed-out"
			? {
					id: "auth-state",
					role: "smithers",
					text: `Smithers is a design-partner preview — sign in with GitHub to continue.\n\n${
						identity.scopesPlain ??
						"The identity service isn't configured on this deployment, so sign-in may not work yet."
					}`,
					status: "complete",
					action: { command: "auth.sign-in", label: "Sign in with GitHub" },
					createdAt: 0,
					ordinal: 0,
				}
			: identity?.state === "signed-in" && !identity.allowlisted
				? {
						id: "auth-state",
						role: "smithers",
						text: `${
							identity.accessRequested
								? "Your request is in — we'll let you know as soon as there's a spot."
								: `You're signed in as ${identity.login ?? "a GitHub user"}, but Smithers is open to design partners only right now.`
						}${identity.accessError !== null ? `\n\n${identity.accessError}` : ""}${
							identity.accessRequested ? "" : "\n\nType /auth.sign-out to use a different GitHub account."
						}`,
						status: "complete",
						...(identity.accessRequested
							? {}
							: { action: { command: "auth.request-access", label: "Request access" } }),
						createdAt: 0,
						ordinal: 0,
					}
				: identity?.state === "unavailable"
					? {
							id: "auth-state",
							role: "smithers",
							text: "This build isn't connected to Smithers' identity service, so GitHub sign-in and repository features are off here. Everything local still works — the World, the browser, local repositories, and workflows on connected work. Use the deployed app for the signed-in experience.",
							status: "complete",
							createdAt: 0,
							ordinal: 0,
						}
					: undefined;

	/*
	 * The suggestion row is DERIVED (§2a/§2f — never stored, never
	 * fabricated): the one grounded recommendation's gold binding when a reco
	 * card waits, else the genuinely-next state-derived step when one exists
	 * (signed-out → Sign in; never-chosen → Choose repos). An empty pill row
	 * is a correct state; a fabricated one is a violation.
	 */
	const recoWaiting = cardRows.find(
		(card) => card.kind === "reco" && card.status !== "acted" && card.payload.recommendation !== null,
	);
	const watched = watchedRows[0];
	const needsSelection =
		identity?.state === "signed-in" && identity.allowlisted && (watched === undefined || watched.selected === null);
	const suggestions: ReadonlyArray<SuggestionBinding> =
		identity?.state === "signed-out"
			? [{ id: "sign-in", label: "Sign in with GitHub", command: "auth.sign-in", emphasis: "primary" }]
			: needsSelection
				? [{ id: "choose-repos", label: "Choose repos to watch", command: "repos.watch", emphasis: "primary" }]
				: recoWaiting !== undefined && recoWaiting.kind === "reco" && recoWaiting.payload.recommendation !== null
					? [
							{
								id: "reco-accept",
								label: recoWaiting.payload.recommendation.title,
								command: "reco.accept",
								args: recoWaiting.id,
								emphasis: "primary",
							},
						]
					: [];
	// A Vite dev build unlocks the admin chrome (devtools, reset) with no
	// session — dev has no identity seam to grant admin, and the machinery
	// panel is what dev is for. Mirrors the registry snapshot's rule.
	const isAdmin =
		(identity?.state === "signed-in" && identity.admin) ||
		(import.meta.env.DEV as boolean | string | undefined) === true;

	/*
	 * §2a″ (wave 12 §4): auth is a conversation STATE, and a state shows only
	 * itself. Signed out, the auth message is the whole transcript. Wave 14 §1
	 * removed the seeded welcome that used to sit under it, so there is no
	 * longer a filler message to filter out here — the transcript is exactly
	 * what the session actually said.
	 */
	const entries: ReadonlyArray<TranscriptEntry> = [
		...(authMessage === undefined ? [] : [{ kind: "message", message: authMessage } as const]),
		...messages.map((message): TranscriptEntry => ({ kind: "message", message })),
		...[...cardRows].map((card): TranscriptEntry => ({ kind: "card", card })),
	].sort((left, right) => {
		if (entryOrdinal(left) !== entryOrdinal(right)) return entryOrdinal(left) - entryOrdinal(right);
		return entryCreatedAt(left) - entryCreatedAt(right);
	});

	const slashQuery =
		session.draft.startsWith("/") && !session.draft.slice(1).includes(" ")
			? session.draft.slice(1).toLowerCase()
			: undefined;
	const slashMatches = slashQuery === undefined || typing ? [] : controller.slashItems(slashQuery);
	const slashMenuLive =
		slashMenu.draft === session.draft
			? slashMenu
			: { draft: session.draft, index: 0, dismissed: false };
	const slashOpen = slashMatches.length > 0 && !slashMenuLive.dismissed;
	const slashHighlighted = Math.min(slashMenuLive.index, slashMatches.length - 1);

	const runSlashCommand = (name: string): void => {
		setSlashMenu({ draft: "", index: 0, dismissed: false });
		controller.changeDraft("");
		controller.runCommand(name);
	};

	const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (event.key === "Escape" && typing) {
			event.preventDefault();
			controller.runCommand("chat.stop");
			return;
		}
		if (!slashOpen) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setSlashMenu({
				draft: session.draft,
				index: (slashHighlighted + 1) % slashMatches.length,
				dismissed: false,
			});
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			setSlashMenu({
				draft: session.draft,
				index: (slashHighlighted + slashMatches.length - 1) % slashMatches.length,
				dismissed: false,
			});
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			const command =
				slashMatches.length === 1 ? slashMatches[0] : slashMatches[slashHighlighted];
			if (command !== undefined) runSlashCommand(command.command.name);
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			setSlashMenu({ draft: session.draft, index: slashHighlighted, dismissed: true });
		}
	};

	return (
		// data-flows is the live registry manifest (visible AND hidden names):
		// under commands-are-the-app the registry is not secret — the agent tool
		// lists it to the model — and the launch checklist verifies every
		// data-flow binding against exactly this surface.
		<div
			className="app-shell"
			data-flows={controller.commands.all().map((command) => command.name).join(" ")}
			onKeyDown={(event) => {
				if (event.key === "Escape" && session.maximizedCardId !== null) {
					controller.runCommand("card.minimize");
					return;
				}
				// The dev-tools keyboard path (§2b): unregistered for non-admins, so a no-op there.
				if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "d") {
					event.preventDefault();
					controller.runCommand("admin.devtools");
				}
			}}
		>
			<SmithersUiStyles />
			<MarkdownEditorStyles />

			<div className="chat-frame" data-pane={session.surface === "chat" ? undefined : session.surface}>
				<div className="chat-column">
					{/*
					 * The corner chrome is chat chrome (balance, reset the conversation,
					 * theme), so it lives with the conversation rather than floating over
					 * the whole window. Anchored to the viewport it sat on top of an open
					 * pane's own header and made the pane's back-to-conversation button
					 * unclickable; anchored to the chat column it stays exactly where it
					 * was whenever the chat is alone, and clears the pane when one is open.
					 */}
					<div className="corner-chrome">
						{billing !== undefined && billing.state !== "unknown" ? (
							<Button
								variant="outline"
								size="sm"
								className="corner-balance-chip"
								data-empty={billing.state === "empty"}
								aria-label="Show your balance"
								title="Show your balance"
								onClick={() => controller.runCommand("billing.balance")}
							>
								{billing.state === "unavailable" ? "Balance unavailable" : `$${billing.totalUsd ?? "0"}`}
							</Button>
						) : null}
						{/* The bare reset is admin-only dev tooling (§2); users get /clear. */}
						{isAdmin ? (
							<Button
								variant="outline"
								size="icon"
								className="corner-reset-btn"
								aria-label="Reset conversation"
								title="Reset conversation"
								onClick={() => controller.runCommand("reset")}
							>
								<RotateCcw size={14} />
							</Button>
						) : null}
						<Button
							variant="outline"
							size="icon"
							className="corner-theme-btn"
							aria-label="Toggle light and dark mode"
							title="Toggle light and dark mode"
							onClick={() => controller.runCommand("dark-mode")}
						>
							{dark ? <Sun size={14} /> : <Moon size={14} />}
						</Button>
					</div>

					<ChatTranscript
						className="smithers-transcript"
						pending={typing}
						pendingLabel="Smithers is responding"
						aria-label="Conversation"
						empty={
							<EmptyState
								className="transcript-empty"
								icon={<Sparkles size={20} />}
								title="Nothing here yet"
								description="Ask Smithers anything to get started."
							/>
						}
					>
						{entries.map((entry) =>
							entry.kind === "card" ? (
								<CardView
									key={entry.card.id}
									card={entry.card}
									onDecideApproval={(id, decision) =>
										controller.runCommandArgs(
											decision === "approved" ? "approval.approve" : "approval.deny",
											id,
										)
									}
									onRecoAction={(id, action) =>
										controller.runCommandArgs(
											action === "accept" ? "reco.accept" : action === "edit" ? "reco.edit" : "reco.dismiss",
											id,
										)
									}
									onGrantConfirm={(id) => controller.runCommandArgs("admin.grant.confirm", id)}
									onGrantCancel={(id) => controller.runCommandArgs("admin.grant.cancel", id)}
									onQueueApprove={(login) => controller.runCommandArgs("admin.queue.approve", login)}
									onRepoToggle={(name) => controller.runCommandArgs("repos.watch.toggle", name)}
									onReposSelectAll={() => controller.runCommand("repos.watch.all")}
									onReposSelectNone={() => controller.runCommand("repos.watch.none")}
									onReposConfirm={() => controller.runCommand("repos.watch.confirm")}
									maximized={session.maximizedCardId === entry.card.id}
									onMaximize={(id) => controller.runCommandArgs("card.maximize", id)}
									onMinimize={() => controller.runCommand("card.minimize")}
									onConnectGitHub={() => controller.runCommand("auth.sign-in")}
									onConnectLocal={() => controller.runCommandArgs("connector.add", "read")}
									onRunWorkflow={(name) => controller.runCommandArgs("flow.run", name)}
									onStopRun={(id) => controller.runCommandArgs("flow.run.stop", id)}
									onRetryRun={(id) => controller.runCommandArgs("flow.run.retry", id)}
									onChooseWorkflowRepo={(name) => controller.runCommandArgs("flow.repo.choose", name)}
									worldDocuments={worldDocuments}
									onChangeWorldDocument={(id, body) => controller.changeWorldDocument(id, body)}
									onRunCommand={(name, commandArgs) =>
										commandArgs === undefined
											? controller.runCommand(name)
											: controller.runCommandArgs(name, commandArgs)
									}
								/>
							) : entry.message.act !== undefined ? (
								<Marker
									key={entry.message.id}
									variant="note"
									className="bubble-system-note tool-act-line"
								>
									{entry.message.text}
								</Marker>
							) : (
								<ChatMessage
									className="smithers-chat-message"
									key={entry.message.id}
									role={entry.message.role === "user" ? "user" : "assistant"}
									meta={
										entry.message.status !== "complete" ? (
											<Marker variant="note" live className="bubble-system-note">
												{systemNoteLabel(entry.message)}
											</Marker>
										) : undefined
									}
								>
									{entry.message.reasoning !== undefined && entry.message.reasoning !== "" ? (
										<Reasoning
											className="message-reasoning"
											streaming={entry.message.id === streamingMessageId}
											title="Reasoning"
										>
											<div className="message-reasoning-text">{entry.message.reasoning}</div>
										</Reasoning>
									) : null}
									{entry.message.text !== "" ? (
										// scrubToolEcho: a weak model's tool call written into prose
										// is wire debris, never content — stripped at render only;
										// the store and dev-tools keep the raw truth.
										<Markdown className="message-markdown" content={scrubToolEcho(entry.message.text)} />
									) : null}
									{/* The synthetic auth message has no clock time to tell. */}
									{entry.message.createdAt > 0 ? (
										<time
											className="message-time"
											dateTime={new Date(entry.message.createdAt).toISOString()}
										>
											{timeLabel(entry.message.createdAt)}
										</time>
									) : null}
									{entry.message.action !== undefined ? (
										<Button
											className="message-cta"
											data-flow={entry.message.action.command}
											autoFocus={entry.message.id === "auth-state"}
											onClick={() => controller.runCommand(entry.message.action?.command ?? "")}
										>
											{entry.message.action.label}
										</Button>
									) : null}
									<span className="message-actions">
										<CopyMessageButton
											text={entry.message.text}
											onCopy={(text) => controller.runCommandArgs("copy-message", text)}
										/>
										{entry.message.status === "failed" ? (
											<Button
												variant="ghost"
												size="icon"
												className="message-action"
												aria-label="Retry turn"
												title="Retry turn"
												onClick={() => controller.runCommand("retry")}
											>
												<RotateCcw size={12} />
											</Button>
										) : null}
									</span>
								</ChatMessage>
							),
						)}
					</ChatTranscript>

					<div className="composer-wrap">
						<SuggestionGroup className="smithers-suggestions">
							{suggestions.map((suggestion) => (
								<Suggestion
									className="smithers-suggestion"
									data-gold={suggestion.emphasis === "primary"}
									data-flow={suggestion.command}
									key={suggestion.id}
									suggestion={suggestion.label}
									disabled={typing}
									onClick={() =>
										suggestion.args === undefined
											? controller.runCommand(suggestion.command)
											: controller.runCommandArgs(suggestion.command, suggestion.args)
									}
								>
									<Sparkles size={12} />
									{suggestion.label}
								</Suggestion>
							))}
						</SuggestionGroup>
						{slashOpen ? (
							<div className="slash-menu" role="listbox" aria-label="Slash commands">
								{slashMatches.map((item, index) => (
									<button
										type="button"
										key={item.command.name}
										role="option"
										aria-selected={index === slashHighlighted}
										data-highlighted={index === slashHighlighted ? "true" : "false"}
										data-gold={item.recommended}
										className="slash-menu-item"
										onMouseEnter={() =>
											setSlashMenu({ draft: session.draft, index, dismissed: false })
										}
										onClick={() => runSlashCommand(item.command.name)}
									>
										<span className="slash-menu-name">/{item.command.name}</span>
										<span className="slash-menu-description">{item.command.summary}</span>
									</button>
								))}
							</div>
						) : null}
						<ChatComposer
							className="smithers-composer"
							value={session.draft}
							onValueChange={controller.changeDraft}
							onSubmit={(text) => {
								controller.runCommandArgs("send", text);
							}}
							onStop={() => controller.runCommand("chat.stop")}
							placeholder={
								identity?.state === "signed-out"
									? "Sign in with GitHub first — it's the one step needed…"
									: identity?.state === "signed-in" && !identity.allowlisted
										? "Request access to open the chat…"
										: "Ask Smithers to work on something…"
							}
							lifecycleStatus={typing ? "submitted" : "ready"}
							textareaProps={{ autoFocus: authMessage === undefined, onKeyDown: onComposerKeyDown }}
							actions={
								<div className="composer-actions">
									<ComposerConnect controller={controller} />
									<ComposerMenu
										controller={controller}
										surface={session.surface}
										open={session.surfacesMenuOpen}
									/>
								</div>
							}
						/>
					</div>
				</div>

				{session.surface === "world" ? (
					<section className="world-surface embedded-pane" aria-label={`Smithers ${WORLD_DISPLAY_NAME} state`}>
						<SurfaceHeader
							icon={<BookOpen size={17} aria-hidden="true" />}
							title={WORLD_DISPLAY_NAME}
							subtitle="What Smithers currently understands"
							closeCommand="chat"
							onClose={() => controller.runCommand("chat")}
						>
							<Button variant="ghost" size="sm" onClick={() => controller.runCommand("world.new-note")}>
								<Plus size={14} aria-hidden="true" />
								New note
							</Button>
						</SurfaceHeader>

						<div className="world-workspace">
							<aside className="world-sidebar" aria-label={`${WORLD_DISPLAY_NAME} notes`}>
								<FileTree
									nodes={worldDocuments.map((document) => ({
										path: document.path,
										label: document.title,
									}))}
									selected={selectedWorldDocument?.path}
									onSelect={(path) => {
										const document = worldDocuments.find((candidate) => candidate.path === path);
										if (document) controller.runCommandArgs("world.select", document.id);
									}}
								/>
							</aside>

							<main className="world-document">
								{selectedWorldDocument ? (
									<>
										<div className="world-document-meta">
											<span>{selectedWorldDocument.path}</span>
											<div>
												<Badge variant="outline">
													{Math.round(selectedWorldDocument.confidence * 100)}% confidence
												</Badge>
												<Badge variant="muted">
													{selectedWorldDocument.sources.length} source
													{selectedWorldDocument.sources.length === 1 ? "" : "s"}
												</Badge>
												<Button
													variant="ghost"
													size="icon"
													className="world-delete-btn"
													aria-label={`Delete ${selectedWorldDocument.title}`}
													title="Delete note"
													onClick={() => setDeleteTarget(selectedWorldDocument.id)}
												>
													<Trash2 size={13} />
												</Button>
											</div>
										</div>
										<MarkdownEditor
											value={selectedWorldDocument.body}
											resetKey={selectedWorldDocument.id}
											aria-label={`Edit ${selectedWorldDocument.title}`}
											onChange={(body) =>
												controller.changeWorldDocument(selectedWorldDocument.id, body)
											}
										/>
									</>
								) : (
									<EmptyState
										icon={<BookOpen size={20} />}
										title={`No ${WORLD_DISPLAY_NAME} notes yet`}
										description="Smithers will keep what it learns here."
										action={
											<Button onClick={() => controller.runCommand("world.new-note")}>Create a note</Button>
										}
									/>
								)}
							</main>
						</div>
						<ConfirmDialog
							open={deleteTarget !== null}
							title={`Delete ${worldDocuments.find((document) => document.id === deleteTarget)?.title ?? "note"}?`}
							body="This note leaves Smithers' world. You can write it again, but Smithers will treat it as new."
							confirmLabel="Delete"
							destructive
							onConfirm={() => {
								if (deleteTarget !== null) controller.runCommandArgs("world.delete", deleteTarget);
								setDeleteTarget(null);
							}}
							onCancel={() => setDeleteTarget(null)}
						/>
					</section>
				) : session.surface === "connectors" ? (
					<ConnectorsSurface controller={controller} />
				) : null}

				{/* Admin-only: the panel is absent — not hidden — for everyone else. */}
				{isAdmin && session.devtoolsOpen ? <DevtoolsPanel controller={controller} /> : null}
			</div>

			{/* The one shared toast stack: every background flow past 300ms reports here. */}
			<ToastStack
				toasts={toasts}
				onDismiss={(id) => controller.runCommandArgs("toast.dismiss", id)}
			/>
		</div>
	);
}

export default App;
