import { Effect } from "effect";
import { Catalog } from "@smthrs/chain";
import type { CommandRegistry } from "../commands/Commands";

/*
 * The command registry projected as the chain catalog (DESIGN.md §14) —
 * "commands are the app", carried into the one-door law.
 *
 * Callable vs disclosed mirrors today's tool contract exactly: the agent may
 * EXECUTE every command that is not user-only (hidden id-scoped actions like
 * world.new-note included — hidden means unlisted to the human, not barred to
 * the agent), while the DISCLOSED set the prompt's catalog block teaches is
 * the unhidden subset, same as the list action shows. Gate 3 checks
 * membership in the callable set; disclosure is a prompt concern.
 *
 * Every entry executes through registry.runForAgent — the actor-attributed
 * path with the user-only guard and slash normalization — and maps the TYPED
 * CommandOutcome directly: a failure becomes a CallError observation the next
 * link routes around, and a success value is the call's result. No string
 * sniffing: a success value that happens to start with a failure prefix stays
 * a success.
 */

/*
 * Capability claims per command (DESIGN.md §14 three-tier policy): outbound:*
 * always asks, session:* asks once per session, approve:* is structurally
 * denied to the agent, and the app:act default is free. Declared claims are
 * part of an entry's digest, so a tier change re-keys the calls that name it.
 */
const COMMAND_CAPABILITIES: Readonly<Record<string, ReadonlyArray<string>>> = {
	"workflow.run": ["outbound:launch"],
	"workflow.create": ["outbound:launch"],
	"approval.approve": ["approve:self"],
	"approval.deny": ["approve:self"],
	browser: ["session:net-read"],
};
const DEFAULT_CAPABILITIES: ReadonlyArray<string> = ["app:act"];

/** The one payload shape a command entry accepts: optional argument text. */
const argsOf = (name: string, payload: unknown): Effect.Effect<string | undefined, Catalog.CallError> => {
	if (payload === undefined || payload === null) return Effect.succeed(undefined);
	if (typeof payload !== "object" || Array.isArray(payload)) {
		return Effect.fail(
			new Catalog.CallError({ name, message: `payload must be an object like { args?: string }` }),
		);
	}
	const args = (payload as { readonly args?: unknown }).args;
	if (args === undefined) return Effect.succeed(undefined);
	if (typeof args !== "string") {
		return Effect.fail(new Catalog.CallError({ name, message: `payload.args must be a string` }));
	}
	return Effect.succeed(args);
};

const entryFor = (
	commands: CommandRegistry,
	meta: { readonly name: string; readonly summary: string; readonly acceptsArgs?: boolean; readonly args?: string },
): Catalog.Entry => ({
	name: meta.name,
	description:
		meta.acceptsArgs === true && meta.args !== undefined
			? `${meta.summary} (args: ${meta.args})`
			: meta.summary,
	capabilities: COMMAND_CAPABILITIES[meta.name] ?? DEFAULT_CAPABILITIES,
	handler: (payload) =>
		argsOf(meta.name, payload).pipe(
			Effect.flatMap((args) =>
				Effect.tryPromise({
					try: () => commands.runForAgent(meta.name, args),
					catch: (cause) =>
						new Catalog.CallError({ name: meta.name, message: `command threw: ${String(cause)}` }),
				}),
			),
			Effect.flatMap((outcome) => {
				switch (outcome.status) {
					case "executed":
						return Effect.succeed<unknown>(outcome.value ?? `executed /${meta.name}`);
					case "unknown-command":
						return Effect.fail(
							new Catalog.CallError({ name: meta.name, message: `unknown-command: ${meta.name}` }),
						);
					case "failed":
						return Effect.fail(new Catalog.CallError({ name: meta.name, message: outcome.error }));
				}
			}),
		),
});

/** Every command the agent may call: all registered commands except user-only chrome. */
export const commandEntries = (commands: CommandRegistry): ReadonlyArray<Catalog.Entry> =>
	commands
		.all()
		.filter((command) => command.trigger !== "user")
		.map((command) => entryFor(commands, command));

/**
 * The subset the prompt's catalog block teaches: unhidden agent-callable
 * commands — byte-for-byte the same set today's list action returns.
 */
export const disclosedEntries = (commands: CommandRegistry): ReadonlyArray<Catalog.Entry> =>
	commands
		.all()
		.filter((command) => command.trigger !== "user" && command.hidden !== true)
		.map((command) => entryFor(commands, command));
