import {
	createBrowserWASQLitePersistence,
	openBrowserWASQLiteOPFSDatabase,
	persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence";
import { localStorageCollectionOptions } from "@tanstack/db";
import type { InferSchemaOutput, StorageApi } from "@tanstack/db";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createCollection, createTransaction } from "@tanstack/react-db";
import type { Transaction } from "@tanstack/react-db";
import {
	BillingAccountSchema,
	CardSchema,
	ChainEventRecordSchema,
	ConnectorOperationSchema,
	DEFAULT_PALETTE,
	IdentitySessionSchema,
	initialBillingAccount,
	initialConnectorOperation,
	initialIdentitySession,
	initialSession,
	initialWorldDocuments,
	LocalRepositoryConnectorSchema,
	MessageSchema,
	SessionSchema,
	ToastSchema,
	ToolCallRecordSchema,
	TransitionRecordSchema,
	WatchedReposSchema,
	WorldDocumentSchema,
	WORLD_DISPLAY_NAME,
} from "./AppState";
import type {
	AppTransition,
	BillingAccount,
	Card,
	ChainEventRecord,
	ConnectorOperation,
	IdentitySession,
	LocalRepositoryConnector,
	Message,
	Palette,
	RepositoryCapabilityPattern,
	Session,
	Toast,
	ToolCallRecord,
	TransitionRecord,
	WatchedRepos,
	WorldDocument,
} from "./AppState";

const SESSION_ID = "main";
const APP_SCHEMA_VERSION = 8;

/** The stable ids the reco seam's first-run surfaces reuse, so a boot refresh upserts instead of duplicating. */
export const RECO_DIGEST_MESSAGE_ID = "message-reco-digest";
export const RECO_CARD_ID = "reco-current";
/** The onboarding chooser's stable id: one chooser at a time, upserted. */
export const REPO_CHOOSER_CARD_ID = "repo-chooser";
/** The /theme picker's stable id: one picker at a time, upserted. */
export const THEME_PICKER_CARD_ID = "theme-picker";

const preferredTheme = (): Session["theme"] =>
	typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";

const applyTheme = (theme: Session["theme"]): void => {
	if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
};

/*
 * The color theme, stamped on the same element as data-theme and read by the
 * palette blocks in styles/tokens.css. The default is stamped explicitly too,
 * so the attribute always states which palette is live (tokens.css falls back
 * to night-owl either way).
 */
const applyPalette = (palette: Palette): void => {
	if (typeof document !== "undefined") document.documentElement.dataset.palette = palette;
};

const transitionPayload = (transition: AppTransition): string => {
	const { actor: _actor, type: _type, ...payload } = transition;
	return JSON.stringify(payload);
};

export type PersistenceMode = "opfs" | "localStorage";

export type PersistenceBackend =
	| {
			readonly kind: "opfs";
			readonly persistence: ReturnType<typeof createBrowserWASQLitePersistence>;
	  }
	| {
			readonly kind: "localStorage";
			readonly storage?: StorageApi;
	  };

const resolvePersistenceBackend = async (): Promise<PersistenceBackend> => {
	try {
		const database = await openBrowserWASQLiteOPFSDatabase({
			databaseName: "smithers-mvp.sqlite",
		});
		return {
			kind: "opfs",
			persistence: createBrowserWASQLitePersistence({
				database,
				schemaMismatchPolicy: "reset",
			}),
		};
	} catch (error) {
		console.warn(
			"Smithers: OPFS SQLite persistence is unavailable in this browser context; falling back to localStorage persistence.",
			error,
		);
		return { kind: "localStorage" };
	}
};

interface CollectionSpec<TSchema extends StandardSchemaV1> {
	readonly id: string;
	readonly getKey: (item: InferSchemaOutput<TSchema>) => string;
	readonly schema: TSchema;
}

const createPersistedCollection = <TSchema extends StandardSchemaV1>(
	backend: PersistenceBackend,
	spec: CollectionSpec<TSchema>,
) => {
	if (backend.kind === "opfs") {
		const options = persistedCollectionOptions({
			id: spec.id,
			getKey: spec.getKey,
			persistence: backend.persistence,
			schema: spec.schema,
			schemaVersion: APP_SCHEMA_VERSION,
		});
		return createCollection({ ...options, schema: spec.schema });
	}
	const options = localStorageCollectionOptions({
		id: spec.id,
		storageKey: `smithers-mvp.${spec.id}`,
		getKey: spec.getKey,
		schema: spec.schema,
		...(backend.storage === undefined ? {} : { storage: backend.storage }),
	});
	return createCollection({ ...options, schema: spec.schema });
};

export interface AppCollections {
	readonly sessions: ReturnType<typeof createSessionCollection>;
	readonly messages: ReturnType<typeof createMessageCollection>;
	readonly connectors: ReturnType<typeof createConnectorCollection>;
	readonly connectorOperations: ReturnType<typeof createConnectorOperationCollection>;
	readonly worldDocuments: ReturnType<typeof createWorldDocumentCollection>;
	readonly cards: ReturnType<typeof createCardCollection>;
	readonly transitions: ReturnType<typeof createTransitionCollection>;
	readonly identitySessions: ReturnType<typeof createIdentitySessionCollection>;
	readonly billingAccounts: ReturnType<typeof createBillingAccountCollection>;
	readonly toasts: ReturnType<typeof createToastCollection>;
	readonly watchedRepos: ReturnType<typeof createWatchedReposCollection>;
	readonly toolCalls: ReturnType<typeof createToolCallCollection>;
	readonly chainEvents: ReturnType<typeof createChainEventCollection>;
}

export interface WorldStateSnapshot {
	readonly capturedAt: number;
	readonly revision: number;
	readonly documents: ReadonlyArray<WorldDocument>;
	readonly markdown: string;
}

export interface AgentContextSnapshot {
	readonly capturedAt: number;
	readonly revision: number;
	readonly messages: ReadonlyArray<Message>;
	readonly connectors: ReadonlyArray<LocalRepositoryConnector>;
	readonly worldState: WorldStateSnapshot;
}

export interface AppStore {
	readonly collections: AppCollections;
	readonly dispatch: (transition: AppTransition) => Transaction;
	readonly persistenceMode: PersistenceMode;
	readonly session: () => Session;
	readonly worldStateSnapshot: () => WorldStateSnapshot;
	readonly agentContextSnapshot: () => AgentContextSnapshot;
}

const createSessionCollection = (backend: PersistenceBackend) =>
	createPersistedCollection(backend, {
		id: "app-sessions",
		getKey: (session: Session) => session.id,
		schema: SessionSchema,
	});

const createMessageCollection = (backend: PersistenceBackend) =>
	createPersistedCollection(backend, {
		id: "app-messages",
		getKey: (message: Message) => message.id,
		schema: MessageSchema,
	});

const createConnectorCollection = (backend: PersistenceBackend) =>
	createPersistedCollection(backend, {
		id: "app-connectors",
		getKey: (connector: LocalRepositoryConnector) => connector.id,
		schema: LocalRepositoryConnectorSchema,
	});

const createConnectorOperationCollection = (backend: PersistenceBackend) =>
	createPersistedCollection(backend, {
		id: "app-connector-operations",
		getKey: (operation: ConnectorOperation) => operation.id,
		schema: ConnectorOperationSchema,
	});

const createWorldDocumentCollection = (backend: PersistenceBackend) =>
	createPersistedCollection(backend, {
		id: "world-documents",
		getKey: (document: WorldDocument) => document.id,
		schema: WorldDocumentSchema,
	});

const createCardCollection = (backend: PersistenceBackend) =>
	createPersistedCollection(backend, {
		id: "app-cards",
		getKey: (card: Card) => card.id,
		schema: CardSchema,
	});

const createTransitionCollection = (backend: PersistenceBackend) =>
	createPersistedCollection(backend, {
		id: "app-transitions",
		getKey: (transition: TransitionRecord) => transition.id,
		schema: TransitionRecordSchema,
	});

const createIdentitySessionCollection = (backend: PersistenceBackend) =>
	createPersistedCollection(backend, {
		id: "app-identity-sessions",
		getKey: (session: IdentitySession) => session.id,
		schema: IdentitySessionSchema,
	});

const createBillingAccountCollection = (backend: PersistenceBackend) =>
	createPersistedCollection(backend, {
		id: "app-billing-accounts",
		getKey: (account: BillingAccount) => account.id,
		schema: BillingAccountSchema,
	});

const createToastCollection = (backend: PersistenceBackend) =>
	createPersistedCollection(backend, {
		id: "app-toasts",
		getKey: (toast: Toast) => toast.id,
		schema: ToastSchema,
	});

const createWatchedReposCollection = (backend: PersistenceBackend) =>
	createPersistedCollection(backend, {
		id: "app-watched-repos",
		getKey: (watched: WatchedRepos) => watched.id,
		schema: WatchedReposSchema,
	});

const createToolCallCollection = (backend: PersistenceBackend) =>
	createPersistedCollection(backend, {
		id: "app-tool-calls",
		getKey: (record: ToolCallRecord) => record.id,
		schema: ToolCallRecordSchema,
	});

const createChainEventCollection = (backend: PersistenceBackend) =>
	createPersistedCollection(backend, {
		id: "app-chain-events",
		getKey: (record: ChainEventRecord) => record.id,
		schema: ChainEventRecordSchema,
	});

const seed = async (collections: AppCollections): Promise<void> => {
	await Promise.all([
		collections.sessions.preload(),
		collections.messages.preload(),
		collections.connectors.preload(),
		collections.connectorOperations.preload(),
		collections.worldDocuments.preload(),
		collections.cards.preload(),
		collections.transitions.preload(),
		collections.identitySessions.preload(),
		collections.billingAccounts.preload(),
		collections.toasts.preload(),
		collections.watchedRepos.preload(),
		collections.toolCalls.preload(),
		collections.chainEvents.preload(),
	]);

	if (collections.sessions.get(SESSION_ID) === undefined) {
		await collections.sessions.insert(initialSession(preferredTheme())).isPersisted.promise;
	} else {
		/*
		 * Heal a session row persisted before newer required fields existed
		 * (updates validate the FULL row, so one missing field would wedge every
		 * later dispatch — composer typing included). Seed values fill exactly
		 * the absent keys, once, so the schema stays strict with no migration
		 * table. Generic over the seed so the next added field heals too.
		 */
		const persisted = collections.sessions.get(SESSION_ID) as unknown as Record<string, unknown>;
		const seed = initialSession(preferredTheme()) as unknown as Record<string, unknown>;
		const missing = Object.keys(seed).filter((key) => persisted[key] === undefined);
		if (missing.length > 0) {
			collections.sessions.update(SESSION_ID, (draft) => {
				const target = draft as unknown as Record<string, unknown>;
				for (const key of missing) target[key] = seed[key];
			});
		}
	}
	// Wave 14 §1: nothing seeds the transcript. Signed out, the auth message is
	// the whole conversation; signed in, the digest (or its honest degraded
	// state) is the first message. See AppState's note on the removed welcome.
	if (collections.connectorOperations.get("connector-operation") === undefined) {
		await collections.connectorOperations
			.insert(initialConnectorOperation())
			.isPersisted.promise;
	}
	if (collections.worldDocuments.size === 0) {
		await collections.worldDocuments.insert([...initialWorldDocuments()]).isPersisted.promise;
	}
	if (collections.identitySessions.get("identity") === undefined) {
		await collections.identitySessions.insert(initialIdentitySession()).isPersisted.promise;
	}
	if (collections.billingAccounts.get("billing") === undefined) {
		await collections.billingAccounts.insert(initialBillingAccount()).isPersisted.promise;
	}
};

const repositoryCapabilities = (
	root: string,
	access: LocalRepositoryConnector["access"],
): ReadonlyArray<RepositoryCapabilityPattern> => {
	const resource = `${root.replace(/\/$/, "")}/**`;
	return [
		{ action: "fs:read", resource },
		...(access === "read-write" ? ([{ action: "fs:write", resource }] as const) : []),
	];
};

const nextOrdinal = (messages: AppCollections["messages"]): number => {
	let highest = -1;
	for (const message of messages.values()) highest = Math.max(highest, message.ordinal);
	return highest + 1;
};

export const createAppStore = async (
	backend?: PersistenceBackend,
): Promise<AppStore> => {
	const resolvedBackend = backend ?? (await resolvePersistenceBackend());
	const collections: AppCollections = {
		sessions: createSessionCollection(resolvedBackend),
		messages: createMessageCollection(resolvedBackend),
		connectors: createConnectorCollection(resolvedBackend),
		connectorOperations: createConnectorOperationCollection(resolvedBackend),
		worldDocuments: createWorldDocumentCollection(resolvedBackend),
		cards: createCardCollection(resolvedBackend),
		transitions: createTransitionCollection(resolvedBackend),
		identitySessions: createIdentitySessionCollection(resolvedBackend),
		billingAccounts: createBillingAccountCollection(resolvedBackend),
		toasts: createToastCollection(resolvedBackend),
		watchedRepos: createWatchedReposCollection(resolvedBackend),
		toolCalls: createToolCallCollection(resolvedBackend),
		chainEvents: createChainEventCollection(resolvedBackend),
	};

	await seed(collections);
	applyTheme(collections.sessions.get(SESSION_ID)?.theme ?? "light");
	applyPalette(collections.sessions.get(SESSION_ID)?.palette ?? DEFAULT_PALETTE);

	const session = (): Session => {
		const current = collections.sessions.get(SESSION_ID);
		if (current === undefined) throw new Error("Smithers app state is not initialized");
		return current;
	};

	const worldStateSnapshot = (): WorldStateSnapshot => {
		const capturedAt = Date.now();
		const documents = [...collections.worldDocuments.values()].sort((left, right) =>
			left.path.localeCompare(right.path),
		);
		const markdown = documents
			.map(
				(document) =>
					`<!-- world-document: ${document.path}; confidence: ${document.confidence}; sources: ${document.sources.join(", ")} -->\n${document.body.trim()}`,
			)
			.filter((document) => document.length > 0)
			.join("\n\n---\n\n");
		return { capturedAt, revision: session().revision, documents, markdown };
	};

	const agentContextSnapshot = (): AgentContextSnapshot => {
		const capturedAt = Date.now();
		return {
			capturedAt,
			revision: session().revision,
			messages: [...collections.messages.values()].sort(
				(left, right) => left.ordinal - right.ordinal,
			),
			connectors: [...collections.connectors.values()].sort((left, right) =>
				left.name.localeCompare(right.name),
			),
			worldState: worldStateSnapshot(),
		};
	};

	const persist = async (transaction: Parameters<typeof collections.sessions.utils.acceptMutations>[0]) => {
		await Promise.all([
			collections.sessions.utils.acceptMutations(transaction),
			collections.messages.utils.acceptMutations(transaction),
			collections.connectors.utils.acceptMutations(transaction),
			collections.connectorOperations.utils.acceptMutations(transaction),
			collections.worldDocuments.utils.acceptMutations(transaction),
			collections.cards.utils.acceptMutations(transaction),
			collections.transitions.utils.acceptMutations(transaction),
			collections.identitySessions.utils.acceptMutations(transaction),
			collections.billingAccounts.utils.acceptMutations(transaction),
			collections.toasts.utils.acceptMutations(transaction),
			collections.watchedRepos.utils.acceptMutations(transaction),
			collections.toolCalls.utils.acceptMutations(transaction),
			collections.chainEvents.utils.acceptMutations(transaction),
		]);
	};

	const dispatch = (transition: AppTransition): Transaction => {
		const current = session();
		const revision = current.revision + 1;
		const createdAt = Date.now();
		const transaction = createTransaction({
			id: `app-transition-${revision}`,
			metadata: { actor: transition.actor, type: transition.type },
			mutationFn: ({ transaction }) => persist(transaction),
		});

		transaction.mutate(() => {
			switch (transition.type) {
				case "composer.changed":
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.draft = transition.draft;
						draft.revision = revision;
					});
					break;

				case "message.submitted": {
					const text = transition.text.trim();
					if (text === "" || current.phase !== "idle") return;
					collections.messages.insert({
						id: `message-${transition.turnId}-user`,
						role: "user",
						text,
						status: "complete",
						createdAt,
						ordinal: nextOrdinal(collections.messages),
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.draft = "";
						draft.phase = "responding";
						draft.revision = revision;
					});
					break;
				}

				case "message.response.delta": {
					if (transition.delta === "" || current.phase !== "responding") return;
					const messageId = `message-${transition.turnId}-smithers`;
					if (collections.messages.get(messageId) === undefined) {
						collections.messages.insert({
							id: messageId,
							role: "smithers",
							text: transition.channel === "text" ? transition.delta : "",
							reasoning: transition.channel === "reasoning" ? transition.delta : undefined,
							status: "complete",
							createdAt,
							ordinal: nextOrdinal(collections.messages),
						});
					} else {
						collections.messages.update(messageId, (draft) => {
							if (transition.channel === "reasoning") {
								draft.reasoning = (draft.reasoning ?? "") + transition.delta;
							} else {
								draft.text += transition.delta;
							}
						});
					}
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "message.response.completed":
					// A chain turn may legitimately complete with no prose bubble
					// (act rows or a park told the story), so completion settles the
					// phase unconditionally.
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.phase = "idle";
						draft.revision = revision;
					});
					break;

				case "message.response.failed": {
					const messageId = `message-${transition.turnId}-smithers`;
					if (collections.messages.get(messageId) === undefined) {
						collections.messages.insert({
							id: messageId,
							role: "smithers",
							text: `I couldn't complete that turn. ${transition.message}`,
							status: "failed",
							createdAt,
							ordinal: nextOrdinal(collections.messages),
						});
					} else {
						collections.messages.update(messageId, (draft) => {
							draft.status = "failed";
							draft.statusDetail = transition.message;
						});
					}
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.phase = "idle";
						draft.revision = revision;
					});
					break;
				}

				case "message.response.cancelled": {
					const messageId = `message-${transition.turnId}-smithers`;
					const detail = transition.detail ?? "Stopped the current response.";
					if (collections.messages.get(messageId) !== undefined) {
						collections.messages.update(messageId, (draft) => {
							draft.status = "interrupted";
							draft.statusDetail = detail;
						});
					} else {
						// Killed before the first delta: there is no response to mark
						// up, so say what happened on that turn rather than leaving the
						// user's message hanging with nothing after it — same discipline
						// as `session.turn.orphaned`. A kill must never read as silence.
						collections.messages.insert({
							id: messageId,
							role: "smithers",
							text: detail,
							status: "interrupted",
							createdAt,
							ordinal: nextOrdinal(collections.messages),
						});
					}
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.phase = "idle";
						draft.revision = revision;
					});
					break;
				}

				case "session.turn.orphaned": {
					// The restored session claimed a turn was streaming, but the app
					// was closed — that stream is gone. Mark that turn's response
					// interrupted with the honest line; never restore a silently stuck
					// pending surface.
					//
					// The in-flight turn is the most recent user message, and its
					// response lives at the id derived from that turn — resolving it
					// that way (rather than "the last Smithers message") is what keeps
					// the reconciliation honest: if the app died between the submit and
					// the first delta there is no response yet, and an earlier turn that
					// genuinely completed must not be relabelled as interrupted.
					if (current.phase !== "responding") return;
					const inFlight = [...collections.messages.values()]
						.filter((message) => message.role === "user")
						.sort((left, right) => left.ordinal - right.ordinal)
						.at(-1);
					const turnId = inFlight?.id.match(/^message-(.+)-user$/)?.[1];
					const orphaned =
						turnId === undefined
							? undefined
							: collections.messages.get(`message-${turnId}-smithers`);
					if (orphaned !== undefined) {
						collections.messages.update(orphaned.id, (draft) => {
							draft.status = "interrupted";
							draft.statusDetail = "That turn was interrupted when the app closed.";
						});
					} else if (turnId !== undefined) {
						// Died before the first delta: the turn has no response at all.
						// Say so on that turn rather than leaving the user's message
						// hanging with nothing after it (Launch Checklist B-1 asks for
						// restored work to be *correctly described*, not merely unstuck).
						collections.messages.insert({
							id: `message-${turnId}-smithers`,
							role: "smithers",
							text: "That turn was interrupted when the app closed.",
							status: "interrupted",
							createdAt,
							ordinal: nextOrdinal(collections.messages),
						});
					}
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.phase = "idle";
						draft.revision = revision;
					});
					break;
				}

				case "conversation.reset": {
					const keys = [...collections.messages.keys()];
					if (keys.length > 0) collections.messages.delete(keys);
					// A reset conversation is empty — it does not re-seed a welcome.
					const cardKeys = [...collections.cards.keys()];
					if (cardKeys.length > 0) collections.cards.delete(cardKeys);
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.draft = "";
						draft.phase = "idle";
						draft.composerOwner = "user";
						draft.maximizedCardId = null;
						draft.revision = revision;
					});
					break;
				}

				case "conversation.cleared": {
					// /clear (§2h): the sweep already kept what mattered in world
					// notes; the chat clears and one calm line states what was kept.
					const keys = [...collections.messages.keys()];
					if (keys.length > 0) collections.messages.delete(keys);
					const cardKeys = [...collections.cards.keys()];
					if (cardKeys.length > 0) collections.cards.delete(cardKeys);
					collections.messages.insert({
						id: `message-${revision}-cleared`,
						role: "smithers",
						text:
							transition.kept === 0
								? "Cleared — there was nothing new worth keeping."
								: `Saved ${transition.kept} note${transition.kept === 1 ? "" : "s"} to ${WORLD_DISPLAY_NAME}. Cleared.`,
						status: "complete",
						createdAt,
						ordinal: 0,
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.draft = "";
						draft.phase = "idle";
						draft.composerOwner = "user";
						draft.maximizedCardId = null;
						draft.revision = revision;
					});
					break;
				}

				case "card.maximized":
					if (collections.cards.get(transition.id) === undefined) return;
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.maximizedCardId = transition.id;
						draft.revision = revision;
					});
					break;

				case "card.minimized":
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.maximizedCardId = null;
						draft.revision = revision;
					});
					break;

				case "devtools.toggled":
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.devtoolsOpen = transition.open;
						draft.revision = revision;
					});
					break;

				case "surfaces-menu.toggled":
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.surfacesMenuOpen = transition.open;
						draft.revision = revision;
					});
					break;

				case "command.deferred":
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.pendingCommand = {
							name: transition.name,
							args: transition.args,
							requirement: transition.requirement,
							requestedAt: createdAt,
						};
						draft.revision = revision;
					});
					break;

				case "command.deferral.cleared":
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.pendingCommand = null;
						draft.revision = revision;
					});
					break;

				case "command.ran":
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.recentCommands = [
							transition.name,
							...(draft.recentCommands ?? []).filter((name) => name !== transition.name),
						].slice(0, 20);
						draft.revision = revision;
					});
					break;

				case "toolcall.recorded":
					collections.toolCalls.insert({
						id: `toolcall-${revision}`,
						turnId: transition.turnId,
						name: transition.name,
						arguments: transition.arguments,
						result: transition.result,
						createdAt,
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;

				case "chain.event.appended":
					collections.chainEvents.insert({
						id: `chain-${transition.lineageId}-${transition.seq}`,
						lineageId: transition.lineageId,
						seq: transition.seq,
						event: transition.event,
						createdAt,
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;

				case "agent.backend.changed":
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.agentBackend = transition.backend;
						draft.revision = revision;
					});
					break;

				case "chain.turn.resumed":
					if (current.phase !== "idle") return;
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.phase = "responding";
						draft.revision = revision;
					});
					break;

				case "reco.selection.needed": {
					// Onboarding's one question: a short welcome plus the chooser
					// card, in the transcript. A stale recommendation card leaves —
					// there is no digest until the user chooses.
					const seedOnly =
						collections.messages.size === 1 &&
						[...collections.messages.keys()][0]?.endsWith("-welcome-smithers") === true;
					if (seedOnly && collections.messages.get(RECO_DIGEST_MESSAGE_ID) === undefined) {
						const seedKey = [...collections.messages.keys()][0];
						if (seedKey !== undefined) collections.messages.delete(seedKey);
					}
					if (collections.messages.get(RECO_DIGEST_MESSAGE_ID) === undefined) {
						collections.messages.insert({
							id: RECO_DIGEST_MESSAGE_ID,
							role: "smithers",
							text: "Welcome — before I read anything, choose which repositories I should watch. Nothing else is touched.",
							status: "complete",
							createdAt,
							ordinal: seedOnly ? 0 : nextOrdinal(collections.messages),
						});
					}
					if (collections.cards.get(RECO_CARD_ID) !== undefined) {
						collections.cards.delete(RECO_CARD_ID);
					}
					const existingChooser = collections.cards.get(REPO_CHOOSER_CARD_ID);
					let highest = 0;
					for (const message of collections.messages.values()) highest = Math.max(highest, message.ordinal);
					for (const card of collections.cards.values()) highest = Math.max(highest, card.ordinal);
					const chooser: Card = {
						id: REPO_CHOOSER_CARD_ID,
						kind: "repo-chooser",
						title: "Choose the repositories Smithers watches",
						status: "active",
						createdAt: existingChooser?.createdAt ?? createdAt,
						ordinal: existingChooser?.ordinal ?? highest + 1,
						payload: {
							candidates: transition.candidates.map((candidate) => ({ ...candidate })),
							selected:
								existingChooser?.kind === "repo-chooser" ? [...existingChooser.payload.selected] : [],
							via: "onboarding",
							phase: "choosing",
						},
					};
					if (existingChooser === undefined) {
						collections.cards.insert(chooser);
					} else {
						collections.cards.update(REPO_CHOOSER_CARD_ID, (draft) => {
							Object.assign(draft, chooser);
						});
					}
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "watched.replaced": {
					const watched: WatchedRepos = {
						id: "watched",
						selected: [...transition.selected],
						selectedAt: transition.selectedAt,
						via: transition.via,
						updatedAt: createdAt,
						revision,
					};
					if (collections.watchedRepos.get("watched") === undefined) {
						collections.watchedRepos.insert(watched);
					} else {
						collections.watchedRepos.update("watched", (draft) => {
							Object.assign(draft, watched);
						});
					}
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "theme.changed":
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.theme = transition.theme;
						draft.revision = revision;
					});
					applyTheme(transition.theme);
					break;

				case "palette.changed":
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.palette = transition.palette;
						draft.revision = revision;
					});
					applyPalette(transition.palette);
					break;

				case "composer.control.changed":
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.composerOwner = transition.owner;
					if (transition.draft !== undefined) draft.draft = transition.draft;
						draft.revision = revision;
					});
					break;

				case "surface.changed":
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.surface = transition.surface;
						draft.revision = revision;
					});
					break;

				case "world.document.selected":
					if (collections.worldDocuments.get(transition.id) === undefined) return;
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.selectedWorldDocumentId = transition.id;
						draft.revision = revision;
					});
					break;

				case "world.document.upserted": {
					const document: WorldDocument = {
						...transition.document,
						updatedAt: createdAt,
						updatedBy: transition.actor,
						revision,
					};
					if (collections.worldDocuments.get(document.id) === undefined) {
						collections.worldDocuments.insert(document);
					} else {
						collections.worldDocuments.update(document.id, (draft) => {
							Object.assign(draft, document);
						});
					}
					collections.sessions.update(SESSION_ID, (draft) => {
						if (transition.select !== false) draft.selectedWorldDocumentId = document.id;
						draft.revision = revision;
					});
					break;
				}

				case "world.document.removed": {
					if (collections.worldDocuments.get(transition.id) === undefined) return;
					collections.worldDocuments.delete(transition.id);
					const remaining = [...collections.worldDocuments.values()].find(
						(document) => document.id !== transition.id,
					);
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.selectedWorldDocumentId = remaining?.id ?? null;
						draft.revision = revision;
					});
					break;
				}

				case "connector.local.requested":
					collections.connectorOperations.update("connector-operation", (draft) => {
						draft.phase = "selecting-local-repository";
						draft.requestedAccess = transition.access;
						draft.error = null;
						draft.updatedAt = createdAt;
						draft.revision = revision;
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;

				case "connector.local.cancelled":
					collections.connectorOperations.update("connector-operation", (draft) => {
						draft.phase = "idle";
						draft.requestedAccess = null;
						draft.error = null;
						draft.updatedAt = createdAt;
						draft.revision = revision;
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;

				case "connector.local.failed":
					collections.connectorOperations.update("connector-operation", (draft) => {
						draft.phase = "idle";
						draft.requestedAccess = null;
						draft.error = transition.message;
						draft.updatedAt = createdAt;
						draft.revision = revision;
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;

				case "connector.local.connected": {
					const id = `local-repository:${transition.repository.root}`;
					const existing = collections.connectors.get(id);
					const connector: LocalRepositoryConnector = {
						id,
						kind: "local-repository",
						status: "connected",
						access: transition.access,
						...transition.repository,
						capabilities: [...repositoryCapabilities(transition.repository.root, transition.access)],
						createdAt: existing?.createdAt ?? createdAt,
						updatedAt: createdAt,
						revision,
					};
					if (existing === undefined) {
						collections.connectors.insert(connector);
					} else {
						collections.connectors.update(id, (draft) => {
							Object.assign(draft, connector);
						});
					}
					collections.connectorOperations.update("connector-operation", (draft) => {
						draft.phase = "idle";
						draft.requestedAccess = null;
						draft.error = null;
						draft.updatedAt = createdAt;
						draft.revision = revision;
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "connector.access.changed":
					if (collections.connectors.get(transition.id) === undefined) return;
					collections.connectors.update(transition.id, (draft) => {
						draft.access = transition.access;
						draft.capabilities = [
							...repositoryCapabilities(draft.root, transition.access),
						];
						draft.updatedAt = createdAt;
						draft.revision = revision;
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;

				case "connector.removed":
					if (collections.connectors.get(transition.id) === undefined) return;
					collections.connectors.delete(transition.id);
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;

				case "card.upsert": {
					const existing = collections.cards.get(transition.card.id);
					if (existing === undefined) {
						collections.cards.insert(transition.card);
					} else {
						collections.cards.update(transition.card.id, (draft) => {
							Object.assign(draft, transition.card);
						});
					}
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "card.updated":
					if (collections.cards.get(transition.id) === undefined) return;
					collections.cards.update(transition.id, (draft) => {
						Object.assign(draft, transition.patch);
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;

				case "card.approval.decision.pending": {
					const card = collections.cards.get(transition.id);
					if (card === undefined || card.kind !== "approval" || card.status === "acted") return;
					collections.cards.update(transition.id, (draft) => {
						if (draft.kind === "approval") {
							draft.payload.pending = true;
							draft.payload.error = undefined;
						}
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "card.approval.decision.failed": {
					const card = collections.cards.get(transition.id);
					if (card === undefined || card.kind !== "approval" || card.status === "acted") return;
					collections.cards.update(transition.id, (draft) => {
						draft.status = "error";
						if (draft.kind === "approval") {
							draft.payload.pending = false;
							draft.payload.error = transition.message;
						}
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "card.approval.decided": {
					const card = collections.cards.get(transition.id);
					// A failed decision attempt stays retryable, so "error" can still decide.
					if (card === undefined || card.kind !== "approval" || card.status === "acted") return;
					collections.cards.update(transition.id, (draft) => {
						draft.status = "acted";
						if (draft.kind === "approval") {
							draft.payload.decision = transition.decision;
							draft.payload.decidedAt = transition.decidedAt;
							draft.payload.pending = false;
							draft.payload.error = undefined;
						}
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "identity.session.loaded": {
					const existing = collections.identitySessions.get("identity");
					if (existing === undefined) return;
					collections.identitySessions.update("identity", (draft) => {
						draft.state = transition.state;
						draft.login = transition.login;
						draft.allowlisted = transition.allowlisted;
						draft.admin = transition.admin;
						if (transition.scopesPlain !== null) draft.scopesPlain = transition.scopesPlain;
						if (transition.state !== "signed-in") draft.accessRequested = false;
						if (transition.state === "signed-in") draft.accessError = null;
						draft.updatedAt = createdAt;
						draft.revision = revision;
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "identity.access.requested": {
					const identity = collections.identitySessions.get("identity");
					if (identity === undefined || identity.state !== "signed-in") return;
					collections.identitySessions.update("identity", (draft) => {
						draft.accessRequested = true;
						draft.accessError = null;
						draft.updatedAt = createdAt;
						draft.revision = revision;
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "identity.access.failed": {
					if (collections.identitySessions.get("identity") === undefined) return;
					collections.identitySessions.update("identity", (draft) => {
						draft.accessError = transition.message;
						draft.updatedAt = createdAt;
						draft.revision = revision;
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "identity.session.cleared": {
					if (collections.identitySessions.get("identity") === undefined) return;
					collections.identitySessions.update("identity", (draft) => {
						draft.state = "signed-out";
						draft.login = null;
						draft.allowlisted = false;
						draft.admin = false;
						draft.accessRequested = false;
						draft.accessError = null;
						draft.updatedAt = createdAt;
						draft.revision = revision;
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "billing.refreshed": {
					if (collections.billingAccounts.get("billing") === undefined) return;
					collections.billingAccounts.update("billing", (draft) => {
						draft.state = transition.state;
						draft.totalUsd = transition.totalUsd;
						draft.allowedToStartWork = transition.allowedToStartWork;
						draft.lifetimeChargedUsd = transition.lifetimeChargedUsd;
						draft.chargeCount = transition.chargeCount;
						draft.refreshedAt = createdAt;
						draft.revision = revision;
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "billing.unavailable": {
					const account = collections.billingAccounts.get("billing");
					if (account === undefined) return;
					collections.billingAccounts.update("billing", (draft) => {
						// Keep the last known balance honest-but-stale; only an account
						// that never loaded falls back to plain "unavailable".
						if (draft.state === "unknown") draft.state = "unavailable";
						draft.revision = revision;
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "toast.shown": {
					const id = `toast-${transition.key}`;
					const existing = collections.toasts.get(id);
					const toast: Toast = {
						id,
						key: transition.key,
						title: transition.title,
						status: "running",
						detail: "",
						createdAt: existing?.createdAt ?? createdAt,
						updatedAt: createdAt,
					};
					if (existing === undefined) {
						collections.toasts.insert(toast);
					} else {
						collections.toasts.update(id, (draft) => {
							Object.assign(draft, toast);
						});
					}
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "toast.resolved": {
					const id = `toast-${transition.key}`;
					if (collections.toasts.get(id) === undefined) return;
					collections.toasts.update(id, (draft) => {
						draft.status = transition.status;
						if (transition.title !== undefined) draft.title = transition.title;
						draft.detail = transition.detail;
						draft.updatedAt = createdAt;
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "toast.dismissed":
					if (collections.toasts.get(transition.id) === undefined) return;
					collections.toasts.delete(transition.id);
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;

				case "reco.digest.loaded": {
					/*
					 * Beat 5 — "Smithers has already read": on a transcript that still
					 * holds only the seed welcome, the digest sentence REPLACES it as
					 * the first Smithers message. Otherwise the digest upserts at the
					 * end (or in place on a boot refresh).
					 */
					const seedOnly =
						collections.messages.size === 1 &&
						[...collections.messages.keys()][0]?.endsWith("-welcome-smithers") === true;
					const existingDigest = collections.messages.get(RECO_DIGEST_MESSAGE_ID);
					const digestOrdinal =
						existingDigest !== undefined && !transition.bump
							? existingDigest.ordinal
							: seedOnly
								? 0
								: nextOrdinal(collections.messages);
					if (seedOnly && existingDigest === undefined) {
						const seedKey = [...collections.messages.keys()][0];
						if (seedKey !== undefined) collections.messages.delete(seedKey);
					}
					if (existingDigest === undefined) {
						collections.messages.insert({
							id: RECO_DIGEST_MESSAGE_ID,
							role: "smithers",
							text: transition.sentence,
							status: "complete",
							createdAt,
							ordinal: digestOrdinal,
						});
					} else {
						collections.messages.update(RECO_DIGEST_MESSAGE_ID, (draft) => {
							draft.text = transition.sentence;
							if (transition.bump) draft.ordinal = digestOrdinal;
						});
					}
					const existingCard = collections.cards.get(RECO_CARD_ID);
					let highest = digestOrdinal;
					for (const card of collections.cards.values()) highest = Math.max(highest, card.ordinal);
					const card: Card = {
						id: RECO_CARD_ID,
						kind: "reco",
						title: "What I found",
						status: "active",
						createdAt: existingCard?.createdAt ?? createdAt,
						ordinal:
							existingCard !== undefined && !transition.bump
								? existingCard.ordinal
								: highest + 1,
						payload: {
							sentence: transition.sentence,
							digest: transition.digest,
							recommendation: transition.recommendation,
						},
					};
					if (existingCard === undefined) {
						collections.cards.insert(card);
					} else {
						collections.cards.update(RECO_CARD_ID, (draft) => {
							Object.assign(draft, card);
						});
					}
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "reco.message.loaded": {
					// The degraded/unavailable honesty: the sentence replaces the seed
					// welcome exactly like a grounded digest, and any stale
					// recommendation card leaves — acting on old evidence would be a lie.
					const seedOnly =
						collections.messages.size === 1 &&
						[...collections.messages.keys()][0]?.endsWith("-welcome-smithers") === true;
					const existingDigest = collections.messages.get(RECO_DIGEST_MESSAGE_ID);
					if (seedOnly && existingDigest === undefined) {
						const seedKey = [...collections.messages.keys()][0];
						if (seedKey !== undefined) collections.messages.delete(seedKey);
					}
					if (existingDigest === undefined) {
						collections.messages.insert({
							id: RECO_DIGEST_MESSAGE_ID,
							role: "smithers",
							text: transition.message,
							status: "complete",
							createdAt,
							ordinal: seedOnly ? 0 : nextOrdinal(collections.messages),
						});
					} else {
						collections.messages.update(RECO_DIGEST_MESSAGE_ID, (draft) => {
							draft.text = transition.message;
						});
					}
					if (collections.cards.get(RECO_CARD_ID) !== undefined) {
						collections.cards.delete(RECO_CARD_ID);
					}
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "reco.feedback.failed": {
					const card = collections.cards.get(transition.cardId);
					if (card === undefined || card.kind !== "reco" || card.status === "acted") return;
					collections.cards.update(transition.cardId, (draft) => {
						draft.status = "error";
						if (draft.kind === "reco") draft.payload.error = transition.message;
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "card.removed":
					if (collections.cards.get(transition.id) === undefined) return;
					collections.cards.delete(transition.id);
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;

				case "message.steered": {
					const steered = transition.text.trim();
					if (steered === "" || current.phase !== "responding") return;
					collections.messages.insert({
						id: `message-steer-${revision}`,
						role: "user",
						text: steered,
						status: "complete",
						createdAt,
						ordinal: nextOrdinal(collections.messages),
					});
					// The turn's prose continues AFTER the steer, so the turn bubble
					// moves below it; deltas keep appending to the same message.
					const turnBubble = collections.messages.get(`message-${transition.turnId}-smithers`);
					if (turnBubble !== undefined) {
						collections.messages.update(turnBubble.id, (draft) => {
							draft.ordinal = nextOrdinal(collections.messages);
						});
					}
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.draft = "";
						draft.revision = revision;
					});
					break;
				}

				case "message.tool.executed": {
					collections.messages.insert({
						id: `message-act-${revision}`,
						role: "smithers",
						text: transition.text,
						act: transition.text,
						status: "complete",
						createdAt,
						ordinal: nextOrdinal(collections.messages),
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "message.claim.substituted": {
					// The turn's whole answer becomes the deterministic line: a
					// partially-suppressed claim is still a claim on screen.
					const messageId = `message-${transition.turnId}-smithers`;
					if (collections.messages.get(messageId) === undefined) {
						collections.messages.insert({
							id: messageId,
							role: "smithers",
							text: transition.text,
							status: "complete",
							createdAt,
							ordinal: nextOrdinal(collections.messages),
						});
					} else {
						collections.messages.update(messageId, (draft) => {
							draft.text = transition.text;
						});
					}
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}

				case "message.appended": {
					collections.messages.insert({
						id: `message-appended-${revision}`,
						role: "smithers",
						text: transition.text,
						...(transition.action === undefined ? {} : { action: transition.action }),
						status: "complete",
						createdAt,
						ordinal: nextOrdinal(collections.messages),
					});
					collections.sessions.update(SESSION_ID, (draft) => {
						draft.revision = revision;
					});
					break;
				}
			}

			collections.transitions.insert({
				id: `transition-${revision}`,
				revision,
				actor: transition.actor,
				type: transition.type,
				payload: transitionPayload(transition),
				createdAt,
			});
		});

		return transaction;
	};

	// Boot reconciliation: a persisted "responding" phase means the app went
	// away mid-turn — no done frame can ever arrive for that stream. Name it
	// through the dispatcher (journaled, actor system) instead of restoring a
	// silently stuck pending surface (Launch Checklist B-1).
	// Awaited like every other boot write in `seed`: the reconciliation is durable
	// before the store is handed out, and its persistence failure surfaces as a
	// rejected boot rather than an unhandled rejection nobody sees.
	if (collections.sessions.get(SESSION_ID)?.phase === "responding") {
		await dispatch({ type: "session.turn.orphaned", actor: "system" }).isPersisted.promise;
	}

	// Boot reconciliation: toasts are notifications, not state — a toast left
	// behind by a closed session would resurrect a "running" notice for work
	// that is gone. They never survive a restart.
	for (const key of [...collections.toasts.keys()]) {
		await dispatch({ type: "toast.dismissed", actor: "system", id: key }).isPersisted.promise;
	}

	return { collections, dispatch, persistenceMode: resolvedBackend.kind, session, worldStateSnapshot, agentContextSnapshot };
};
