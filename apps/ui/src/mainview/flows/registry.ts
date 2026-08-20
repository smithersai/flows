/*
 * The pure half of the flow registry ("flows are the app"), cut to this app's
 * surface: the UI-catalog metadata, the recommended (gold) rule, slash
 * filtering, alias resolution, and composer submit parsing. Nothing here
 * touches the DOM, the store, the agent bridge, or Effect, so the whole module
 * is unit-testable in plain bun; the executable half — a flow declaration
 * paired with its handler through `FlowBinding` — lives in Commands.ts.
 *
 * The split is deliberate. Flow IDENTITY (name, description, capabilities,
 * effect tier, whether a model may invoke it) belongs to the declaration and
 * its projected descriptor. Everything below is UI-catalog copy about a flow
 * that already exists, which is why it can stay a plain structural record.
 *
 * The one import is type-only, so this module still carries no runtime
 * dependency on Effect or the harness.
 */
import type * as FlowBinding from "@smthrs/harness/FlowBinding";

/**
 * The UI-catalog concerns wrapped around one registered flow.
 *
 * This is the `metadata` half of a registry entry. It carries no flow-identity
 * decision: capabilities and effect tiers live on the declaration, and the
 * user-only axis is the descriptor's `modelInvocable` flag.
 */
export interface FlowMetadata {
	readonly summary: string;
	/** Not listed in the slash menu (id-scoped button actions); still invocable. */
	readonly hidden?: boolean;
	/** Alias of another flow: executing it executes the canonical target. */
	readonly aliasOf?: string;
	/**
	 * The slash argument hint, e.g. `<number> [owner/repo]`. Its presence is
	 * what makes `/name <text>` parse as an invocation rather than a prompt;
	 * the text itself is catalog copy for the human and the model.
	 */
	readonly args?: string;
	/*
	 * The requirement axis: requirement ids (from `flowRequirements`) that must
	 * be satisfied before this flow executes. A user-invoked flow with an unmet
	 * requirement DEFERS — the run path parks the invocation and dispatches the
	 * requirement's fulfilling flow instead; the deferred flow resumes when the
	 * requirement's state predicate flips true. Agent-invoked flows never
	 * defer: an unmet requirement is an honest failure carrying the reason,
	 * because a model must not enqueue work that fires after its turn ends.
	 */
	readonly requires?: ReadonlyArray<string>;
}

/**
 * One registered flow as the catalog sees it: its name beside its UI metadata.
 *
 * Structural on purpose. The runtime projects `{ binding, metadata }` entries
 * into this shape with {@link itemOf}, and the pure rules below never need the
 * executable half.
 */
export interface CatalogItem extends FlowMetadata {
	readonly name: string;
}

/**
 * One registered capability: the executable flow and the UI copy around it.
 *
 * `binding` is the whole capability — a flow declaration (name, description,
 * capabilities, effect tier, typed payload and success schemas) paired with the
 * handler that runs it, projected as a `FlowDescriptor`. `metadata` is only
 * what the catalog needs in order to render and rank it.
 */
export interface FlowEntry<R = never> {
	readonly binding: FlowBinding.Binding<R>;
	readonly metadata: FlowMetadata;
}

/** An entry's name, which lives on the descriptor rather than the wrapper. */
export const nameOf = (entry: FlowEntry): string => entry.binding.descriptor.name;

/** An entry projected into the plain record the pure catalog rules read. */
export const itemOf = (entry: FlowEntry): CatalogItem => ({
	name: nameOf(entry),
	...entry.metadata,
});

/**
 * Whether a model may invoke this flow.
 *
 * The trigger axis is the descriptor's own `modelInvocable` flag: user-only
 * browser mechanics (sign-in/out, reset, theme, chat.stop, send, maximize)
 * declare `modelInvocable: false`, so they never reach the agent's catalog and
 * the model can neither invoke them nor promise them.
 */
export const modelInvocable = (entry: FlowEntry): boolean => entry.binding.descriptor.modelInvocable;

/**
 * A prerequisite a flow can declare via `requires`. The registry resolves
 * unmet requirements in declaration order: the FIRST unmet one wins, its
 * `fulfill` flow runs now, and the original flow re-enters `run` after the
 * predicate flips — so a flow with several requirements steps through them one
 * at a time (sign in → choose repos → execute), each step re-checked against
 * live state, never a stale plan.
 */
export interface FlowRequirement {
	/** The id flows reference in `requires`. */
	readonly id: string;
	/** True when the requirement is already met for this state. */
	readonly satisfied: (state: CommandState) => boolean;
	/** The registered flow that fulfills the requirement when unmet. */
	readonly fulfill: string;
	/** Honest one-line reason, shown when the requirement defers or fails a flow. */
	readonly reason: string;
}

/*
 * The requirement table. Every entry's `satisfied` reads only CommandState, so
 * the table stays unit-testable; every entry's `fulfill` names a registered
 * flow, gated by parity.test.ts. A seam that can SATISFY a requirement
 * (identity load, watched-repos confirm) calls resumeDeferredCommand — adding
 * a requirement here means wiring its satisfying seam there.
 */
export const flowRequirements: ReadonlyArray<FlowRequirement> = [
	{
		id: "signed-in",
		// Only the definitive signed-out answer defers; unknown/unavailable
		// identity never blocks a command (the seam discipline: gate on
		// answers, not on silence).
		satisfied: (state) => !state.signedOut,
		fulfill: "auth.sign-in",
		reason: "Sign in with GitHub first",
	},
	{
		id: "repos-selected",
		satisfied: (state) => !state.needsSelection,
		fulfill: "repos.watch",
		reason: "Choose which repositories Smithers watches first",
	},
];

/** The flow's unmet requirements for a state, in declaration order. */
export const unmetRequirements = (
	metadata: FlowMetadata,
	state: CommandState,
	table: ReadonlyArray<FlowRequirement> = flowRequirements,
): Array<FlowRequirement> =>
	(metadata.requires ?? []).flatMap((id) => {
		const requirement = table.find((candidate) => candidate.id === id);
		return requirement === undefined || requirement.satisfied(state) ? [] : [requirement];
	});

/** The app state the recommendation rule reads, sampled from the store. */
export interface CommandState {
	readonly surface: "chat" | "world" | "connectors" | "github" | "files";
	readonly typing: boolean;
	readonly hasConnectors: boolean;
	/** A live recommendation card is waiting on an answer (reco seam, Wave 3b). */
	readonly hasRecommendation: boolean;
	/** The validated session carries admin:true; the admin plugin registers only then. */
	readonly admin: boolean;
	/** Signed-in but the watched-repos selection has never been made (Wave 10 onboarding). */
	readonly needsSelection: boolean;
	/** No validated session: the one next step is sign-in. */
	readonly signedOut: boolean;
	/**
	 * The user's recently run commands, most recent first (session
	 * recentCommands). Optional so state fixtures stay minimal; missing = [].
	 */
	readonly recent?: ReadonlyArray<string>;
	/**
	 * The identity answer, human-readable ("signed-in as will", "signed-out",
	 * "unavailable", "unknown") — the model's truthful "am I logged in?"
	 * source. Optional so state fixtures stay minimal.
	 */
	readonly identity?: string;
}

/**
 * The ordered recommendations for an app state — the next-action output the
 * slash menu reads. The first entry is gold: a waiting recommendation leads
 * before everything ("the `/` surface lists the current recommendation FIRST");
 * an unmade watched-repos selection is onboarding's one question; signed-out,
 * sign-in is the only step; away from the chat, returning to it leads.
 */
export const recommendedNames = (state: CommandState): ReadonlyArray<string> => {
	if (state.typing) return ["chat.stop"];
	if (state.signedOut) return ["auth.sign-in"];
	const base = state.hasConnectors
		? (["world", "connect"] as const)
		: (["connect", "world"] as const);
	const withSelection = state.needsSelection ? (["repos.watch", ...base] as const) : base;
	const withReco = state.hasRecommendation ? (["reco.accept", ...withSelection] as const) : withSelection;
	return state.surface === "chat" ? [...withReco] : ["chat", ...withReco];
};

/** The flows listed to the user: hidden id-scoped actions never show. */
export const visible = <C extends CatalogItem>(
	commands: ReadonlyArray<C>,
): Array<C> => commands.filter((command) => command.hidden !== true);

/** The canonical flow a name resolves to, following one alias hop. */
export const canonical = <C extends CatalogItem>(name: string, commands: ReadonlyArray<C>): string =>
	commands.find((command) => command.name === name)?.aliasOf ?? name;

/** A needle matches a flow by name or summary, case-insensitively. */
export const matches = (command: CatalogItem, needle: string): boolean => {
	const query = needle.trim().toLowerCase();
	if (query === "") return true;
	return command.name.toLowerCase().includes(query) || command.summary.toLowerCase().includes(query);
};

/**
 * How directly a flow answers a needle, best first: its own name exactly, then
 * a name that starts with it, then a name that contains it, then a match that
 * only the summary carried.
 *
 * Matching on the summary is what makes the menu searchable ("/repo" finds the
 * flows that talk about repositories), but it must never outrank a name. Before
 * this rank existed, `/flows` listed `flow.list` first — its summary reads
 * "List the workflows on your workspace" and it is declared 450 lines earlier
 * in the registry — so Enter ran a different flow than the one the user typed.
 */
const nameRank = (command: CatalogItem, query: string): number => {
	if (query === "") return 0;
	const name = command.name.toLowerCase();
	if (name === query) return 0;
	if (name.startsWith(query)) return 1;
	if (name.includes(query)) return 2;
	return 3;
};

/**
 * The matching flows, closest match first. Registry order still decides inside
 * a rank: the sort is stable, so this only ever moves a better answer forward.
 */
export const filtered = <C extends CatalogItem>(needle: string, commands: ReadonlyArray<C>): Array<C> => {
	const query = needle.trim().toLowerCase();
	const shown = commands.filter((command) => matches(command, needle));
	return shown.sort((left, right) => nameRank(left, query) - nameRank(right, query));
};

export interface SlashItem<C extends CatalogItem> {
	readonly flow: C;
	readonly recommended: boolean;
}

/**
 * A listing longer than this is a wall, not a menu: past the cap, the
 * recommendations plus the user's most recent commands (still matching the
 * filter) are the listing, and the rest stays reachable by typing more.
 */
export const SLASH_MENU_CAP = 8;

/**
 * The slash menu's listing, best answer first — because the composer's Enter
 * runs whatever leads it.
 *
 * Match quality orders the listing (`nameRank`); a recommendation leads only
 * among equally good matches. For a bare "/" every flow ranks the same, so the
 * recommendations lead in recommendation order and the first is gold, exactly
 * as the doctrine says. Type a flow's whole name and that flow leads instead:
 * the user was more specific than the app's suggestion.
 *
 * Commands never appear twice. At or under the cap the remainder keeps registry
 * order; over it, recency ranks the remainder and the listing cuts at the cap —
 * but a recommendation, and anything the user named outright, always survives.
 */
export const slashItems = <C extends CatalogItem>(
	state: CommandState,
	needle: string,
	commands: ReadonlyArray<C>,
): Array<SlashItem<C>> => {
	const shown = filtered(needle, visible(commands));
	const query = needle.trim().toLowerCase();
	const names = recommendedNames(state);
	const recommendedSet = new Set(names);
	// Within one rank, the recommendations lead in recommendation order.
	const ordered = [0, 1, 2, 3].flatMap((rank) => {
		const tier = shown.filter((command) => nameRank(command, query) === rank);
		return [
			...names.flatMap((name) => {
				const command = tier.find((candidate) => candidate.name === name);
				return command === undefined ? [] : [{ flow: command, recommended: true }];
			}),
			...tier
				.filter((command) => !recommendedSet.has(command.name))
				.map((command) => ({ flow: command, recommended: false })),
		];
	});
	if (ordered.length <= SLASH_MENU_CAP) return ordered;
	// Over the cap. What the user named outright (an exact or prefix name match)
	// is never cut, and neither is a recommendation; recency decides who else
	// gets in. Recency chooses the survivors, never their order — the listing
	// above is the only ordering rule.
	const kept = (item: SlashItem<C>): boolean => item.recommended || nameRank(item.flow, query) <= 1;
	const survivors = ordered.filter(kept);
	const recency = new Map((state.recent ?? []).map((name, index) => [name, index]));
	// Stable sort: recent commands by recency, everything else keeps its order behind them.
	const ranked = ordered
		.filter((item) => !kept(item))
		.sort(
			(a, b) =>
				(recency.get(a.flow.name) ?? Number.POSITIVE_INFINITY) -
				(recency.get(b.flow.name) ?? Number.POSITIVE_INFINITY),
		);
	const room = Math.max(SLASH_MENU_CAP, survivors.length) - survivors.length;
	const admitted = new Set([...survivors, ...ranked.slice(0, room)].map((item) => item.flow.name));
	return ordered.filter((item) => admitted.has(item.flow.name));
};

/** How a composer submit resolves under the flows-are-the-app doctrine. */
export type Submit =
	| { readonly kind: "empty" }
	| { readonly kind: "command"; readonly name: string; readonly args?: string }
	| { readonly kind: "prompt"; readonly text: string };

// Flow names are deliberately narrower than arbitrary prompt text. Keeping
// this grammar in one named place makes the flow/prompt boundary auditable: a
// typo or punctuation after a slash must go to the agent, never accidentally
// invoke a flow with side effects.
const COMMAND_NAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

/** Split only the leading slash-flow token; arguments remain opaque text. */
const commandHead = (text: string): { readonly name: string; readonly args?: string } | undefined => {
	if (!text.startsWith("/")) return undefined;
	const separator = text.search(/\s/u);
	const name = text.slice(1, separator === -1 ? undefined : separator);
	if (!COMMAND_NAME.test(name)) return undefined;
	if (separator === -1) return { name };
	const args = text.slice(separator).trim();
	return args === "" ? { name } : { name, args };
};

/**
 * Parses the composer draft:
 *  - blank (or a bare "/") submits nothing — bare "/" + Enter is handled by the
 *    menu selecting its first (recommended) item,
 *  - an input that is ONLY a registered slash flow executes it directly
 *    (aliases parse as themselves; execution resolves the canonical target),
 *  - `/name <text>` executes directly when the flow declares an args hint,
 *  - anything else is a prompt for the agent.
 *
 * This is the syntactic half of the composer boundary: it decides flow-vs-
 * prompt and splits the name from the opaque argument text. Turning that text
 * into the flow's typed payload is `SlashPayload.payloadFor`, which the same
 * boundary calls next — so a handler never sees raw argument text.
 */
export const parseSubmit = <C extends CatalogItem>(
	input: string,
	commands: ReadonlyArray<C>,
): Submit => {
	const text = input.trim();
	if (text === "" || text === "/") return { kind: "empty" };
	const invocation = commandHead(text);
	if (invocation === undefined) return { kind: "prompt", text };
	const command = commands.find((candidate) => candidate.name === invocation.name);
	if (command === undefined) return { kind: "prompt", text };
	if (invocation.args === undefined) return { kind: "command", name: invocation.name };
	if (command.args !== undefined) {
		return { kind: "command", name: invocation.name, args: invocation.args };
	}
	return { kind: "prompt", text };
};
