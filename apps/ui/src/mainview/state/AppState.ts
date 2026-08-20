import { z } from "zod";
import {
	CardPlanItemSchema,
	CardPatchSchema,
	CardSchema,
} from "smithers-shared/Cards";
import { REPOSITORY_ACCESS_VALUES } from "smithers-shared/NativeRepository";
import type {
	LocalRepositoryInspection,
	RepositoryAccess,
} from "smithers-shared/NativeRepository";

export { CardPlanItemSchema, CardPatchSchema, CardSchema };
import type { Card, CardPatch } from "smithers-shared/Cards";
export type { Card, CardPatch, CardPlanItem } from "smithers-shared/Cards";

export const ActorSchema = z.enum(["user", "smithers", "system"]);
export type Actor = z.infer<typeof ActorSchema>;

export const MessageSchema = z.object({
	id: z.string(),
	role: z.enum(["user", "smithers"]),
	text: z.string(),
	reasoning: z.string().optional(),
	status: z.enum(["complete", "failed", "interrupted"]),
	statusDetail: z.string().optional(),
	/** A message-ridden action (sign-in rides the opening message; retry rides the failed-OAuth one). */
	action: z.object({ flow: z.string(), label: z.string() }).optional(),
	/** A one-line visible tool act ("Smithers ran /world.new-note") renders as a marker row, not a bubble. */
	act: z.string().optional(),
	/*
	 * What that act actually was (will, 2026-08-19): "This is cool but I can't
	 * click on it or hover to see more". The flow's name and arguments plus a
	 * short result line, scrubbed and bounded by MessageScrub — the row's
	 * visible line still never carries a payload, and the whole record still
	 * lives in the dev-tools panel. Absent when the act has nothing to add.
	 */
	actDetail: z.string().optional(),
	/** Whether the row's detail is open in place. The human's toggle, never the agent's. */
	actExpanded: z.boolean().optional(),
	createdAt: z.number(),
	ordinal: z.number().int().nonnegative(),
});
export type Message = z.infer<typeof MessageSchema>;

/*
 * The shared toast stack (the 300ms law, 2026-08-09): background work that has
 * not settled within 300ms states what is running on ONE store-backed corner
 * surface; work under 300ms never flashes anything. Toasts are notifications,
 * not state mutations — they never gate the app, and a failure toast is
 * honest and stays until dismissed.
 */
export const ToastSchema = z.object({
	id: z.string(),
	/** The work identity ("reco.first-run"): one toast per background flow. */
	key: z.string(),
	title: z.string(),
	status: z.enum(["running", "ok", "failed"]),
	detail: z.string(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type Toast = z.infer<typeof ToastSchema>;

/*
 * The world's display name, centralized (will is renaming "world"; the rename
 * is a one-line change HERE when he names it — `world` stays the internal id).
 * Every user-visible label and command summary reads this constant.
 */
export const WORLD_DISPLAY_NAME = "World";

/*
 * Wave 10 (§2a/§2f) — a pill is a flow BINDING: it carries the flow it
 * invokes, and clicking it invokes that flow directly. The state-derived set
 * (the one grounded recommendation, or the genuinely-next step) is DERIVED in
 * App.tsx from live state — never fabricated, never stored.
 *
 * AMENDED (will, 2026-08-19): the agent may also propose the follow-ups it
 * predicts, and one of those may be a canned QUESTION — the words the user
 * would have typed next ("What is a flow"). Will asked for exactly this after
 * an answer that predicted his next question in prose. It stays a binding: a
 * question pill invokes `send` with that text, so the click submits the
 * user's own message through the same path the composer uses, and a flow pill
 * invokes its registered flow exactly as before. The old law ("never prompt
 * strings", "derived, never fabricated") is superseded to this extent and to
 * no other: nothing here hands free text to the MODEL, and the agent's set
 * lives only as long as the answer it belongs to.
 */
export interface Suggestion {
	readonly id: string;
	readonly label: string;
	readonly flow: string;
	readonly args?: string;
	readonly emphasis: "primary" | "secondary";
}

/*
 * One follow-up the agent predicts after its answer (will, 2026-08-19).
 *
 * `question` is the user's likely next message, submitted verbatim as theirs.
 * `flow` is a registered command, the same binding the state-derived pills
 * carry. The set is validated at the controller boundary — an unregistered
 * flow, a user-only one, or empty text never reaches the store — and it is
 * replaced whole by the next proposal and cleared the moment the conversation
 * moves past the answer it belongs to.
 */
export const AgentSuggestionSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("question"), label: z.string() }),
	z.object({
		kind: z.literal("flow"),
		label: z.string(),
		flow: z.string(),
		args: z.string().optional(),
	}),
]);
export type AgentSuggestion = z.infer<typeof AgentSuggestionSchema>;

/** More than this is a menu, not a suggestion (the pill row sits above the composer). */
export const MAX_AGENT_SUGGESTIONS = 3;

/*
 * The color themes (/theme), the axis ORTHOGONAL to light/dark (/dark-mode):
 * a palette names a set of semantic color values, and each one ships both a
 * light and a dark variant in styles/tokens.css. The list is the contract —
 * the command's argument spec, the store's validation, and the CSS blocks all
 * read it, so adding a palette is one entry here plus its two CSS blocks.
 */
export const PALETTES = [
	"night-owl",
	"paper",
	"fucory",
	"one",
	"github",
	"catppuccin",
	"solarized",
	"gruvbox",
	"rose-pine",
] as const;
export type Palette = (typeof PALETTES)[number];
/** The palette a session that has never chosen one gets (and the CSS default). */
export const DEFAULT_PALETTE: Palette = "night-owl";

export const isPalette = (value: string): value is Palette =>
	(PALETTES as ReadonlyArray<string>).includes(value);

export const SessionSchema = z.object({
	id: z.literal("main"),
	draft: z.string(),
	phase: z.enum(["idle", "responding"]),
	theme: z.enum(["light", "dark"]),
	/*
	 * The color theme. Optional (missing = DEFAULT_PALETTE) so sessions
	 * persisted before the field parse without a schema reset — the same
	 * discipline pendingCommand follows below; a zod default
	 * would fork the schema's input and output types and break collection
	 * inference.
	 */
	palette: z.enum(PALETTES).optional(),
	/*
	 * Which backend drives a turn (DESIGN.md §14): the chat.smithers.sh proxy
	 * with the client tool loop, or the Agent Chain runtime. Optional (missing
	 * = proxy) so persisted sessions from before the flag parse without a
	 * schema reset — the same discipline palette follows above. Flipped only by
	 * the human (admin /debug.backend); the agent never switches its own engine.
	 */
	agentBackend: z.enum(["proxy", "chain"]).optional(),
	composerOwner: z.enum(["user", "smithers"]),
	surface: z.enum(["chat", "world", "connectors", "github", "files"]),
	/** The repository currently projected by the GitHub and Files frames. */
	selectedRepository: z.string().nullable(),
	repositoryTab: z.enum(["files", "issues", "pulls", "flows"]),
	selectedWorldDocumentId: z.string().nullable(),
	/** The card currently maximized (a presentation transition; null = embedded). */
	maximizedCardId: z.string().nullable(),
	/** The admin dev-tools panel (§2b/§2d) — only ever true for admin sessions. */
	devtoolsOpen: z.boolean(),
	/** The composer surfaces menu (the /surfaces command's open state). */
	surfacesMenuOpen: z.boolean(),
	/*
	 * The composer connect menu's open state. A component is a projection and
	 * never an authority, so the menu that used to live in a `useState` lives
	 * here — opened and closed through the transition dispatcher with the actor
	 * recorded, exactly like surfacesMenuOpen above. Optional (missing = closed)
	 * so sessions persisted before the field parse without a schema reset.
	 *
	 * The requirement reads "boolean default false", and the default lives in
	 * `initialSession` below, not in a `z.boolean().default(false)`. A zod
	 * default would never run on the rows this actually has to survive: a
	 * collection reads its rows straight out of storage on preload and TanStack
	 * never validates them (see the version gate in AppStore). The default would
	 * only widen the inferred type to a non-optional `boolean` while a session
	 * persisted before the field still handed back `undefined`. Every read is
	 * `=== true` / `!== true` for that reason.
	 */
	connectMenuOpen: z.boolean().optional(),
	/*
	 * The note `/world.delete` is asking about (§10.6, §28.4). Deleting is not
	 * undoable, so the flow ASKS and the answer is an act of its own — and the
	 * question lives in the store rather than in a component's local state,
	 * because a component is a projection and never an authority. Optional so
	 * sessions persisted before the field parse without a schema reset.
	 */
	pendingWorldDeleteId: z.string().nullable().optional(),
	/*
	 * The one deferred command (requirement axis): a user-invoked command whose
	 * requirement (e.g. signed-in) was unmet parks HERE while the fulfilling
	 * command runs, and resumes when the requirement's predicate flips true.
	 * Persisted because sign-in is a full OAuth redirect — the intent must
	 * survive the reload. Optional (missing = none) so persisted sessions from
	 * before the field parse without a schema reset, like palette above.
	 * Latest wins: deferring a second command replaces the first.
	 */
	pendingCommand: z
		.object({
			name: z.string(),
			args: z.string().nullable(),
			/** The requirement id the command is waiting on. */
			requirement: z.string(),
			requestedAt: z.number(),
		})
		.nullable()
		.optional(),
	/*
	 * The user's recently run visible commands, most recent first (capped in
	 * the reducer): the slash menu's recency ranking past its cap. Optional
	 * (missing = none) so persisted sessions parse without a schema reset.
	 */
	recentCommands: z.array(z.string()).optional(),
	/*
	 * The follow-ups the agent proposed after its latest answer (will,
	 * 2026-08-19). Optional (missing = none) so sessions persisted before the
	 * field parse without a schema reset, like palette above. They belong to
	 * that one answer: the next thing the user says clears them.
	 */
	agentSuggestions: z.array(AgentSuggestionSchema).optional(),
	revision: z.number().int().nonnegative(),
});
export type Session = z.infer<typeof SessionSchema>;

/*
 * The watched-repos selection (Wave 10): a local mirror of the reco seam's
 * GET /api/reco/watched answer. `selected: null` = never chosen (a real
 * distinct state, NOT "all repos"); an empty array = deliberately chose none.
 */
/*
 * One repository the account can browse, as the recommendations service reports
 * it (GET /api/reco/repos — the same read the onboarding chooser opens on). The
 * three columns the chooser row shows are the three the GitHub pane's row shows:
 * full name, freshness, open-issue count.
 */
export const RepoCatalogEntrySchema = z.object({
	fullName: z.string(),
	pushedAt: z.string().nullable(),
	openIssues: z.number(),
});
export type RepoCatalogEntry = z.infer<typeof RepoCatalogEntrySchema>;

export const WatchedReposSchema = z.object({
	id: z.literal("watched"),
	/*
	 * The repositories the account HAS, as opposed to the ones it watches.
	 * Optional (missing = never read) so rows persisted before the field parse
	 * without a schema reset, the same discipline palette follows above.
	 */
	available: z.array(RepoCatalogEntrySchema).optional(),
	selected: z.array(z.string()).nullable(),
	selectedAt: z.string().nullable(),
	via: z.enum(["onboarding", "command", "agent"]).nullable(),
	updatedAt: z.number(),
	revision: z.number().int().nonnegative(),
});
export type WatchedRepos = z.infer<typeof WatchedReposSchema>;

/*
 * The tool-call stream the admin dev-tools panel reads (Wave 10, §2b): the
 * full arguments AND result of every agent tool act. Persisted like
 * everything else, recorded with actor smithers, and rendered ONLY in the
 * admin panel — the transcript itself never carries raw payloads.
 */
export const ToolCallRecordSchema = z.object({
	id: z.string(),
	turnId: z.string(),
	name: z.string(),
	arguments: z.string(),
	result: z.string(),
	createdAt: z.number(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

export const TransitionRecordSchema = z.object({
	id: z.string(),
	revision: z.number().int().nonnegative(),
	actor: ActorSchema,
	type: z.string(),
	payload: z.string(),
	createdAt: z.number(),
});
export type TransitionRecord = z.infer<typeof TransitionRecordSchema>;

/*
 * One chain journal event (DESIGN.md §14) — the durable evidence of a chain
 * turn. `event` is the @smthrs/chain Event as plain JSON: stored opaque here
 * because state schemas stay runtime-free, and schema-validated by the chain
 * journal layer on read. `seq` orders events within one lineage. This
 * collection is the app-layer stand-in for the flows engine journal; when the
 * engine mounts it becomes a sync-fed projection and readers do not change.
 */
export const ChainEventRecordSchema = z.object({
	id: z.string(),
	lineageId: z.string(),
	seq: z.number().int().nonnegative(),
	event: z.unknown(),
	createdAt: z.number(),
});
export type ChainEventRecord = z.infer<typeof ChainEventRecordSchema>;

export const WorldDocumentSchema = z.object({
	id: z.string(),
	path: z.string(),
	title: z.string(),
	body: z.string(),
	links: z.array(z.string()),
	tags: z.array(z.string()),
	sources: z.array(z.string()),
	confidence: z.number().min(0).max(1),
	updatedAt: z.number(),
	updatedBy: ActorSchema,
	revision: z.number().int().nonnegative(),
});
export type WorldDocument = z.infer<typeof WorldDocumentSchema>;

export const RepositoryCapabilityPatternSchema = z.object({
	action: z.enum(["fs:read", "fs:write"]),
	resource: z.string(),
});
export type RepositoryCapabilityPattern = z.infer<typeof RepositoryCapabilityPatternSchema>;

export const LocalRepositoryConnectorSchema = z.object({
	id: z.string(),
	kind: z.literal("local-repository"),
	status: z.literal("connected"),
	access: z.enum(REPOSITORY_ACCESS_VALUES),
	name: z.string(),
	root: z.string(),
	head: z.string().nullable(),
	branch: z.string().nullable(),
	remoteUrl: z.string().nullable(),
	capabilities: z.array(RepositoryCapabilityPatternSchema),
	createdAt: z.number(),
	updatedAt: z.number(),
	revision: z.number().int().nonnegative(),
});
export type LocalRepositoryConnector = z.infer<typeof LocalRepositoryConnectorSchema>;

export const ConnectorOperationSchema = z.object({
	id: z.literal("connector-operation"),
	phase: z.enum(["idle", "selecting-local-repository"]),
	requestedAccess: z.enum(REPOSITORY_ACCESS_VALUES).nullable(),
	error: z.string().nullable(),
	updatedAt: z.number(),
	revision: z.number().int().nonnegative(),
});
export type ConnectorOperation = z.infer<typeof ConnectorOperationSchema>;

/*
 * The identity session record: one row, driven only by real answers from the
 * identity seam (GET /api/auth/session). "unknown" is pre-load; "unavailable"
 * is an honest seam failure — neither changes the chat, because neither is a
 * definitive answer about the person. Signed-out and non-allowlisted are
 * definitive and change what the chat CONTAINS (the opening Smithers message
 * carries the one available action) — never which page exists.
 */
export const IdentitySessionSchema = z.object({
	id: z.literal("identity"),
	state: z.enum(["unknown", "signed-out", "signed-in", "unavailable"]),
	login: z.string().nullable(),
	allowlisted: z.boolean(),
	admin: z.boolean(),
	accessRequested: z.boolean(),
	accessError: z.string().nullable(),
	/** Plain-words scope list fetched from GET /api/auth/scopes; null = honest fallback copy. */
	scopesPlain: z.string().nullable(),
	updatedAt: z.number(),
	revision: z.number().int().nonnegative(),
});
export type IdentitySession = z.infer<typeof IdentitySessionSchema>;

/*
 * The billing record: one row, dollars only (no credit abstraction). Chat is
 * complimentary during the alpha (the billing seam records true cost, debits
 * zero), so a definitive $0 NEVER pauses the composer or the chat — the pause
 * discipline applies only to non-complimentary (paid) work, and the dollar
 * balance chip stays visible either way.
 */
export const BillingAccountSchema = z.object({
	id: z.literal("billing"),
	state: z.enum(["unknown", "ok", "low", "empty", "unavailable"]),
	totalUsd: z.string().nullable(),
	allowedToStartWork: z.boolean(),
	lifetimeChargedUsd: z.string().nullable(),
	chargeCount: z.number().int().nonnegative(),
	refreshedAt: z.number().nullable(),
	revision: z.number().int().nonnegative(),
});
export type BillingAccount = z.infer<typeof BillingAccountSchema>;

export type AppTransition =
	| { type: "composer.changed"; actor: Actor; draft: string }
	| { type: "message.submitted"; actor: "user" | "smithers"; turnId: string; text: string }
	| {
			type: "message.response.delta";
			actor: "smithers";
			turnId: string;
			channel: "text" | "reasoning";
			delta: string;
	  }
	| {
			type: "message.response.completed";
			actor: "smithers";
			turnId: string;
	  }
	| {
			type: "message.response.failed";
			actor: "system";
			turnId: string;
			message: string;
	  }
	| {
			/*
			 * /retry re-RUNS the last turn: the answer that turn produced is
			 * dropped and the same turn id launches again. Re-SENDING the prompt
			 * instead appended a second user bubble per retry, so the transcript
			 * grew a duplicate pair every time and every retry re-sent a longer
			 * history than the one before it.
			 */
			type: "message.retried";
			actor: "user";
			turnId: string;
	  }
	| {
			type: "message.response.cancelled";
			// "user" pressed stop; "system" is a server-side kill ending the stream.
			actor: "user" | "system";
			turnId: string;
			/** One honest line naming what was stopped. */
			detail?: string;
	  }
	| {
			/*
			 * Boot reconciliation: the persisted session said a turn was in
			 * flight when the app went away, so the stream is orphaned — there
			 * is no turnId to cancel and no done frame will ever arrive. The
			 * boot names what happened (the in-flight message is marked
			 * interrupted, the phase returns to idle) instead of restoring a
			 * silently stuck "responding" surface.
			 */
			type: "session.turn.orphaned";
			actor: "system";
	  }
	| { type: "conversation.reset"; actor: "user" }
	| {
			/*
			 * /clear (Wave 10, §2h): the sweep already ran and kept what
			 * mattered; the chat clears and ONE calm line states what was kept.
			 */
			type: "conversation.cleared";
			actor: "user";
			kept: number;
	  }
	| { type: "theme.changed"; actor: "user" | "system"; theme: Session["theme"] }
	/* The color theme (/theme) — the axis orthogonal to light/dark. */
	| { type: "palette.changed"; actor: "user"; palette: Palette }
	| {
			/* Maximize/minimize an embedded card — a presentation transition, user-only. */
			type: "card.maximized";
			actor: "user";
			id: string;
	  }
	| { type: "card.minimized"; actor: "user" }
	| {
			/* The admin dev-tools panel opens/closes (registered only for admins). */
			type: "devtools.toggled";
			actor: "user";
			open: boolean;
	  }
	| {
			/* The composer surfaces menu opens/closes (the surfaces command). */
			type: "surfaces-menu.toggled";
			actor: "user";
			open: boolean;
	  }
	| {
			/* The composer connect menu opens/closes (trigger, Escape, outside press). */
			type: "connect-menu.toggled";
			actor: "user";
			open: boolean;
	  }
	| {
			/*
			 * A user-invoked command parked on an unmet requirement (requirement
			 * axis): the fulfilling command runs now; this record resumes the
			 * original when the requirement's predicate flips true.
			 */
			type: "command.deferred";
			actor: "user";
			name: string;
			args: string | null;
			requirement: string;
	  }
	| {
			/* The deferred command resumed (or went stale) — the parking spot clears. */
			type: "command.deferral.cleared";
			actor: "system";
	  }
	| {
			/* A visible command ran for the user — the slash menu's recency signal. */
			type: "command.ran";
			actor: "user";
			name: string;
	  }
	| {
			/* The full-fidelity record of one agent tool act (dev-tools panel only). */
			type: "toolcall.recorded";
			actor: "smithers";
			turnId: string;
			name: string;
			arguments: string;
			result: string;
	  }
	| {
			/* One chain journal event appended; seq is per lineage (DESIGN.md §14). */
			type: "chain.event.appended";
			actor: "smithers" | "system";
			lineageId: string;
			seq: number;
			event: unknown;
	  }
	| {
			/*
			 * A parked chain lineage resumes after an approval decision: the
			 * session re-enters responding for the same turn id (DESIGN.md §14).
			 */
			type: "chain.turn.resumed";
			actor: "system";
			turnId: string;
	  }
	| {
			type: "composer.control.changed";
			actor: "smithers" | "system";
			owner: Session["composerOwner"];
			draft?: string;
	  }
	| {
			 type: "surface.changed";
			actor: Actor;
			surface: Session["surface"];
	  }
	| {
			/*
			 * Which repository the GitHub and Files frames project. `null` is the
			 * repository LIST — will's own landing ("we should see a list of repos
			 * available and if we click on it we see the repo view"), not an
			 * absence to be papered over.
			 */
			type: "repository.selected";
			actor: Actor;
			repo: string | null;
	  }
	| {
			type: "repository.tab.changed";
			actor: Actor;
			tab: Session["repositoryTab"];
	  }
	| {
			type: "world.document.selected";
			actor: Actor;
			id: string;
	  }
	| {
			type: "world.document.upserted";
			actor: Actor;
			document: Omit<WorldDocument, "updatedAt" | "updatedBy" | "revision">;
			/*
			 * false = write without stealing the world surface's selection. The
			 * user-facing editor keeps the default; agent memory writes pass
			 * false so a background remember never moves what the human reads.
			 */
			select?: boolean;
	  }
	| {
			type: "world.document.removed";
			actor: Actor;
			id: string;
	  }
	| {
			/*
			 * The delete question, asked and answered (§10.6). `id: null` is the
			 * answer "no" — the dialog closes and the note stays.
			 */
			type: "world.delete.asked";
			actor: Actor;
			id: string | null;
	  }
	| {
			type: "connector.local.requested";
			actor: "user";
			access: RepositoryAccess;
	  }
	| {
			type: "connector.local.cancelled";
			actor: "user" | "system";
	  }
	| {
			type: "connector.local.failed";
			actor: "system";
			message: string;
	  }
	| {
			type: "connector.local.connected";
			actor: "system";
			access: RepositoryAccess;
			repository: LocalRepositoryInspection;
	  }
	| {
			type: "connector.access.changed";
			actor: "user";
			id: string;
			access: RepositoryAccess;
	  }
	| {
			type: "connector.removed";
			actor: "user";
			id: string;
	  }
	| { type: "card.upsert"; actor: Actor; card: Card }
	| { type: "card.updated"; actor: Actor; id: string; patch: CardPatch }
	| {
			type: "card.approval.decision.pending";
			actor: "user";
			id: string;
	  }
	| {
			type: "card.approval.decision.failed";
			actor: "system";
			id: string;
			message: string;
	  }
	| {
			type: "card.approval.decided";
			actor: "user";
			id: string;
			decision: "approved" | "denied";
			decidedAt: number;
	  }
	| {
			type: "identity.session.loaded";
			actor: "system";
			state: "signed-out" | "signed-in" | "unavailable";
			login: string | null;
			allowlisted: boolean;
			admin: boolean;
			scopesPlain: string | null;
	  }
	| { type: "identity.access.requested"; actor: "user" }
	| { type: "identity.access.failed"; actor: "system"; message: string }
	| { type: "identity.session.cleared"; actor: "user" }
	| {
			type: "billing.refreshed";
			actor: "system";
			state: "ok" | "low" | "empty";
			totalUsd: string;
			allowedToStartWork: boolean;
			lifetimeChargedUsd: string;
			chargeCount: number;
	  }
	| { type: "billing.unavailable"; actor: "system" }
	| {
			/* The 300ms toast law: slow background work states what is running. */
			type: "toast.shown";
			actor: "system";
			key: string;
			title: string;
	  }
	| {
			/* Settled: ok resolves (auto-dismisses); failed stays honest until dismissed. */
			type: "toast.resolved";
			actor: "system";
			key: string;
			status: "ok" | "failed";
			/** The settled title, so a done toast stops reading as still running. */
			title?: string;
			detail: string;
	  }
	| { type: "toast.dismissed"; actor: "user" | "system"; id: string }
	| {
			/*
			 * Wave 10 onboarding: first-run answered needsSelection — open the
			 * repo-chooser card in the transcript with the inline candidates.
			 */
			type: "reco.selection.needed";
			actor: "system";
			candidates: ReadonlyArray<{
				fullName: string;
				private: boolean;
				pushedAt: string | null;
				openIssues: number;
			}>;
	  }
	| {
			/*
			 * The repositories the account can browse, read from the same source
			 * the onboarding chooser opens on. An empty list is a correct state —
			 * the pane says so rather than inventing a row.
			 */
			type: "repos.catalog.loaded";
			actor: Actor;
			available: ReadonlyArray<RepoCatalogEntry>;
	  }
	| {
			/* The watched-repos selection changed (onboarding, /repos.watch, or asking). */
			type: "watched.replaced";
			actor: Actor;
			selected: string[];
			selectedAt: string | null;
			via: "onboarding" | "command" | "agent" | null;
	  }
	| {
			/* The grounded first-run answer from the reco seam (Wave 3b). */
			type: "reco.digest.loaded";
			actor: "system";
			sentence: string;
			digest: RecoDigestPayload;
			recommendation: RecoRecommendationPayload | null;
			/** An explicit reco.refresh re-surfaces the card at the transcript's end. */
			bump: boolean;
	  }
	| {
			/* The honest first message for a degraded or unreachable reco seam. */
			type: "reco.message.loaded";
			actor: "system";
			message: string;
	  }
	| {
			type: "reco.feedback.failed";
			actor: "system";
			cardId: string;
			message: string;
	  }
	| { type: "card.removed"; actor: Actor; id: string }
	| {
			/* The human flips which backend drives a turn (admin /debug.backend). */
			type: "agent.backend.changed";
			actor: "user" | "system";
			backend: "proxy" | "chain";
	  }
	| {
			/*
			 * The agent's predicted follow-ups for the answer it just gave (will,
			 * 2026-08-19): validated bindings, actor smithers, replacing whatever
			 * it proposed before. An empty list is how the agent says "nothing
			 * follows from this", and it is a correct state.
			 */
			type: "agent.suggestions.proposed";
			actor: "smithers";
			suggestions: ReadonlyArray<AgentSuggestion>;
	  }
	| {
			/* The visible one-line record of an agent tool execution. */
			type: "message.tool.executed";
			actor: "smithers";
			turnId: string;
			text: string;
			/** What the act was, scrubbed and bounded — the hover and the expansion. */
			detail?: string;
	  }
	| {
			/*
			 * The human opens or closes one act row's detail in place (will,
			 * 2026-08-19). A presentation act like card.maximized, and theirs
			 * alone — the agent never opens the transcript's own drawers.
			 */
			type: "message.act.toggled";
			actor: "user";
			id: string;
	  }
	| {
			/*
			 * Mid-turn input admitted as steering (DESIGN.md §14): the user's
			 * words render as their own bubble without touching the turn phase;
			 * the running chain drains them at its next link boundary.
			 */
			type: "message.steered";
			actor: "user";
			turnId: string;
			text: string;
	  }
	| {
			/*
			 * Wave 12 §1 — the deterministic claim surface. A turn that launched a
			 * run does not get to narrate it: the client replaces the model's prose
			 * for that turn with the one line it is willing to stand behind. Actor
			 * system, journaled, so the substitution is a recorded act rather than
			 * an invisible edit.
			 */
			type: "message.claim.substituted";
			actor: "system";
			turnId: string;
			text: string;
	  }
	| {
			/* A complete one-line Smithers message (admin results, honest states, auth replies). */
			type: "message.appended";
			actor: "system";
			text: string;
			/** The action that rides the message (sign-in, request access, retry). */
			action?: { flow: string; label: string };
	  };

export const initialSession = (theme: Session["theme"]): Session => ({
	id: "main",
	draft: "",
	phase: "idle",
	theme,
	palette: DEFAULT_PALETTE,
	composerOwner: "user",
	surface: "chat",
	selectedRepository: null,
	repositoryTab: "files",
	selectedWorldDocumentId: "world-home",
	maximizedCardId: null,
	devtoolsOpen: false,
	surfacesMenuOpen: false,
	agentBackend: "proxy",
	connectMenuOpen: false,
	agentSuggestions: [],
	pendingWorldDeleteId: null,
	revision: 0,
});

export const initialWorldDocuments = (createdAt = Date.now()): ReadonlyArray<WorldDocument> => [
	{
		id: "world-home",
		path: "World.md",
		title: "World",
		body: "# World\n\n",
		links: [],
		tags: [],
		sources: ["system:bootstrap"],
		confidence: 1,
		updatedAt: createdAt,
		updatedBy: "system",
		revision: 0,
	},
];

export const initialConnectorOperation = (createdAt = Date.now()): ConnectorOperation => ({
	id: "connector-operation",
	phase: "idle",
	requestedAccess: null,
	error: null,
	updatedAt: createdAt,
	revision: 0,
});

export const initialIdentitySession = (createdAt = Date.now()): IdentitySession => ({
	id: "identity",
	state: "unknown",
	login: null,
	allowlisted: false,
	admin: false,
	accessRequested: false,
	accessError: null,
	scopesPlain: null,
	updatedAt: createdAt,
	revision: 0,
});

export const initialBillingAccount = (): BillingAccount => ({
	id: "billing",
	state: "unknown",
	totalUsd: null,
	allowedToStartWork: true,
	lifetimeChargedUsd: null,
	chargeCount: 0,
	refreshedAt: null,
	revision: 0,
});

/* The reco card payload halves, mirrored from the reco worker's landed contract. */
export interface RecoDigestPayload {
	readonly computedAt: string;
	readonly reposConsidered: number;
	readonly openIssues: number;
	readonly openPullRequests: number;
	readonly staleCount: number;
	readonly mostActiveRepo: string | null;
	readonly oldestWaiting: { readonly label: string; readonly url: string; readonly waitingDays: number } | null;
	readonly untriagedInMostActive: number;
}

export interface RecoRecommendationPayload {
	readonly id: string;
	readonly title: string;
	readonly proposes: string;
	readonly whyNow: string;
	readonly whatHappens: string;
	readonly subjectUrl: string;
	readonly evidenceKey: string;
	readonly whatChanged?: string;
}

/*
 * Wave 14 §1: there is no seeded opening message, in either auth state.
 *
 * A generic "Hey — I'm Smithers, tell me what you're working on" rendered as
 * the OPENING message before the honest content arrived, and the opening
 * message is the one the product is judged by. Signed out, the opening (and
 * only) message IS the auth conversation state — App.tsx derives it, nothing
 * is seeded under it. Signed in, the FIRST message IS the digest, or its
 * honest degraded/needs-selection state; a filler line ahead of it is
 * invention, because it claims a conversation before there is one.
 *
 * That leaves the transcript empty while the first-run reco read is in
 * flight. Empty-while-loading is a valid state: the 300ms toast law already
 * says out loud what is running ("Reading your repos…"), so the wait is
 * narrated by the toast rather than papered over by a message that says
 * nothing true.
 */
