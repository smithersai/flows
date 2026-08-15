/*
 * The pure half of the command registry ("commands are the app"), ported from
 * flows/ui/src/ui/commands/registry.ts and cut to this app's surface: command
 * metadata, the recommended (gold) rule, slash filtering, alias resolution,
 * and composer submit parsing. Nothing here touches the DOM, the store, or the
 * agent bridge, so the whole module is unit-testable in plain bun; the
 * concrete bindings live in Commands.ts.
 */

/** The metadata every registered command carries; `execute` is bound in Commands.ts. */
export interface CommandMeta {
	readonly name: string;
	readonly summary: string;
	/** Not listed in the slash menu (id-scoped button actions); still invocable. */
	readonly hidden?: boolean;
	/** Alias of another command: executing it executes the canonical target. */
	readonly aliasOf?: string;
	/** `/name <text>` executes directly with the trailing text as the argument. */
	readonly acceptsArgs?: boolean;
	/** Agent-readable argument spec. */
	readonly args?: string;
	/*
	 * The trigger axis (multi SPEC §1.2a, Wave 10 §2a): who may invoke the
	 * command. "both" (the default) is a normal command; "user" is browser
	 * mechanics (sign-in/out, reset, theme, chat.stop, send, maximize) — it
	 * never appears in the agent's tool catalog, so the model can neither
	 * invoke it nor promise it.
	 */
	readonly trigger?: "user" | "agent" | "both";
	/*
	 * The requirement axis: requirement ids (from `commandRequirements`) that
	 * must be satisfied before this command executes. A user-invoked command
	 * with an unmet requirement DEFERS — the run path parks the invocation and
	 * dispatches the requirement's fulfilling command instead; the deferred
	 * command resumes when the requirement's state predicate flips true.
	 * Agent-invoked commands never defer: an unmet requirement is an honest
	 * failure carrying the reason, because a model must not enqueue work that
	 * fires after its turn ends.
	 */
	readonly requires?: ReadonlyArray<string>;
}

/**
 * A prerequisite a command can declare via `requires`. The registry resolves
 * unmet requirements in declaration order: the FIRST unmet one wins, its
 * `fulfill` command runs now, and the original command re-enters `run` after
 * the predicate flips — so a command with several requirements steps through
 * them one at a time (sign in → choose repos → execute), each step re-checked
 * against live state, never a stale plan.
 */
export interface CommandRequirement {
	/** The id commands reference in `requires`. */
	readonly id: string;
	/** True when the requirement is already met for this state. */
	readonly satisfied: (state: CommandState) => boolean;
	/** The registered command that fulfills the requirement when unmet. */
	readonly fulfill: string;
	/** Honest one-line reason, shown when the requirement defers or fails a command. */
	readonly reason: string;
}

/*
 * The requirement table. Every entry's `satisfied` reads only CommandState, so
 * the table stays unit-testable; every entry's `fulfill` names a registered
 * command, gated by parity.test.ts. A seam that can SATISFY a requirement
 * (identity load, watched-repos confirm) calls resumeDeferredCommand — adding
 * a requirement here means wiring its satisfying seam there.
 */
export const commandRequirements: ReadonlyArray<CommandRequirement> = [
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

/** The command's unmet requirements for a state, in declaration order. */
export const unmetRequirements = (
	command: CommandMeta,
	state: CommandState,
	table: ReadonlyArray<CommandRequirement> = commandRequirements,
): Array<CommandRequirement> =>
	(command.requires ?? []).flatMap((id) => {
		const requirement = table.find((candidate) => candidate.id === id);
		return requirement === undefined || requirement.satisfied(state) ? [] : [requirement];
	});

/** The app state the recommendation rule reads, sampled from the store. */
export interface CommandState {
	readonly surface: "chat" | "world" | "connectors";
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

/** The commands listed to the user: hidden id-scoped actions never show. */
export const visible = <C extends CommandMeta>(
	commands: ReadonlyArray<C>,
): Array<C> => commands.filter((command) => command.hidden !== true);

/** The canonical command a name resolves to, following one alias hop. */
export const canonical = <C extends CommandMeta>(name: string, commands: ReadonlyArray<C>): string =>
	commands.find((command) => command.name === name)?.aliasOf ?? name;

/** A needle matches a command by name or summary, case-insensitively. */
export const matches = (command: CommandMeta, needle: string): boolean => {
	const query = needle.trim().toLowerCase();
	if (query === "") return true;
	return command.name.toLowerCase().includes(query) || command.summary.toLowerCase().includes(query);
};

export const filtered = <C extends CommandMeta>(needle: string, commands: ReadonlyArray<C>): Array<C> =>
	commands.filter((command) => matches(command, needle));

export interface SlashItem<C extends CommandMeta> {
	readonly command: C;
	readonly recommended: boolean;
}

/**
 * A listing longer than this is a wall, not a menu: past the cap, the
 * recommendations plus the user's most recent commands (still matching the
 * filter) are the listing, and the rest stays reachable by typing more.
 */
export const SLASH_MENU_CAP = 8;

/**
 * The slash menu's listing: matching recommendations in recommendation order
 * (the first is gold — bare "/" + Enter runs it), then the remaining matching
 * commands. Commands never appear in both sections. At or under the cap the
 * remainder keeps registry order; over it, recency ranks the remainder and
 * the listing cuts at the cap.
 */
export const slashItems = <C extends CommandMeta>(
	state: CommandState,
	needle: string,
	commands: ReadonlyArray<C>,
): Array<SlashItem<C>> => {
	const shown = filtered(needle, visible(commands));
	const names = recommendedNames(state);
	const recommendedItems = names.flatMap((name) => {
		const command = shown.find((candidate) => candidate.name === name);
		return command === undefined ? [] : [{ command, recommended: true }];
	});
	const recommendedSet = new Set(names);
	const otherItems = shown
		.filter((command) => !recommendedSet.has(command.name))
		.map((command) => ({ command, recommended: false }));
	if (recommendedItems.length + otherItems.length <= SLASH_MENU_CAP) {
		return [...recommendedItems, ...otherItems];
	}
	const rank = new Map((state.recent ?? []).map((name, index) => [name, index]));
	// Stable sort: recent commands by recency, everything else keeps registry order behind them.
	const ranked = [...otherItems].sort(
		(a, b) =>
			(rank.get(a.command.name) ?? Number.POSITIVE_INFINITY) -
			(rank.get(b.command.name) ?? Number.POSITIVE_INFINITY),
	);
	return [...recommendedItems, ...ranked].slice(
		0,
		Math.max(SLASH_MENU_CAP, recommendedItems.length),
	);
};

/** How a composer submit resolves under the commands-are-the-app doctrine. */
export type Submit =
	| { readonly kind: "empty" }
	| { readonly kind: "command"; readonly name: string; readonly args?: string }
	| { readonly kind: "prompt"; readonly text: string };

/**
 * Parses the composer draft:
 *  - blank (or a bare "/") submits nothing — bare "/" + Enter is handled by the
 *    menu selecting its first (recommended) item,
 *  - an input that is ONLY a registered slash command executes it directly
 *    (aliases parse as themselves; execution resolves the canonical target),
 *  - `/name <text>` executes directly when the command opts into arguments,
 *  - anything else is a prompt for the agent.
 */
export const parseSubmit = <C extends CommandMeta>(
	input: string,
	commands: ReadonlyArray<C>,
): Submit => {
	const text = input.trim();
	if (text === "" || text === "/") return { kind: "empty" };
	const bare = /^\/([a-z0-9_-]+(?:\.[a-z0-9_-]+)*)$/.exec(text);
	const name = bare?.[1];
	if (name !== undefined && commands.some((candidate) => candidate.name === name)) {
		return { kind: "command", name };
	}
	const withArgs = /^\/([a-z0-9_-]+(?:\.[a-z0-9_-]+)*)\s+(\S[\s\S]*)$/.exec(text);
	const argsName = withArgs?.[1];
	const args = withArgs?.[2];
	if (argsName !== undefined && args !== undefined) {
		const command = commands.find((candidate) => candidate.name === argsName);
		if (command !== undefined && command.acceptsArgs === true) {
			return { kind: "command", name: argsName, args: args.trim() };
		}
	}
	return { kind: "prompt", text };
};
