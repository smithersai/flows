import { describe, expect, test } from "bun:test";
import type { StorageApi } from "@tanstack/db";
import { createAppController } from "../state/AppController";
import { PALETTES } from "../state/AppState";
import { createAppStore } from "../state/AppStore";
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge";
import { canonical, matches, parseSubmit, recommendedNames, slashItems } from "./registry";
import type { CommandState } from "./registry";
import { executeAgentToolCall } from "./agentTools";

const memoryStorage = (): StorageApi => {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key),
	};
};

const unavailableAgent: NativeAgent = {
	available: false,
	startTurn: async () => ({ status: "error", message: "unavailable" }),
	cancelTurn: async () => {},
	subscribe: () => () => {},
};

const unavailableRepositories: NativeRepositories = {
	available: false,
	pickLocalRepository: async () => ({
		status: "error",
		code: "native-required",
		message: "Local repositories can only be connected from the Smithers native app.",
	}),
};

const freshController = async () => {
	const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
	return { store, controller: createAppController(store, unavailableRepositories, unavailableAgent) };
};

const chatState: CommandState = {
	surface: "chat",
	typing: false,
	hasConnectors: false,
	hasRecommendation: false,
	admin: false,
	needsSelection: false,
	signedOut: false,
};

describe("command registry pure model", () => {
	test("connect leads the recommendations until work is connected", () => {
		expect(recommendedNames(chatState)[0]).toBe("connect");
		expect(recommendedNames({ ...chatState, hasConnectors: true })[0]).toBe("world");
		expect(recommendedNames({ ...chatState, surface: "world" })[0]).toBe("chat");
		expect(recommendedNames({ ...chatState, typing: true })).toEqual(["chat.stop"]);
	});

	test("an unmade watched-repos selection leads; signed-out, sign-in is the only step", () => {
		expect(recommendedNames({ ...chatState, needsSelection: true })[0]).toBe("repos.watch");
		expect(recommendedNames({ ...chatState, signedOut: true })).toEqual(["auth.sign-in"]);
		// Typing still outranks everything.
		expect(recommendedNames({ ...chatState, signedOut: true, typing: true })).toEqual(["chat.stop"]);
	});

	test("aliases resolve to their canonical target", () => {
		const commands = [{ name: "theme", summary: "" }, { name: "dark-mode", summary: "", aliasOf: "theme" }];
		expect(canonical("dark-mode", commands)).toBe("theme");
		expect(canonical("theme", commands)).toBe("theme");
		expect(canonical("unknown", commands)).toBe("unknown");
	});

	test("slash filtering matches name and summary, case-insensitively", () => {
		const command = { name: "connect", summary: "Connect work to Smithers" };
		expect(matches(command, "con")).toBe(true);
		expect(matches(command, "WORK")).toBe(true);
		expect(matches(command, "zzz")).toBe(false);
		expect(matches(command, "")).toBe(true);
	});

	test("the slash listing puts the recommended command first", () => {
		const commands = [
			{ name: "world", summary: "w" },
			{ name: "connect", summary: "c" },
		];
		const items = slashItems(chatState, "", commands);
		expect(items[0]?.command.name).toBe("connect");
		expect(items[0]?.recommended).toBe(true);
		expect(items.filter((item) => item.recommended)).toHaveLength(2);
	});

	test("parseSubmit resolves empty, bare command, args command, and prompt", () => {
		const commands = [
			{ name: "world", summary: "w" },
			{ name: "browser", summary: "b", args: "<url>" },
		];
		expect(parseSubmit("", commands)).toEqual({ kind: "empty" });
		expect(parseSubmit("/", commands)).toEqual({ kind: "empty" });
		expect(parseSubmit("/world", commands)).toEqual({ kind: "command", name: "world" });
		expect(parseSubmit("/browser https://example.com", commands)).toEqual({
			kind: "command",
			name: "browser",
			args: "https://example.com",
		});
		expect(parseSubmit("/world with trailing text", commands)).toEqual({
			kind: "prompt",
			text: "/world with trailing text",
		});
		expect(parseSubmit("hello there", commands)).toEqual({ kind: "prompt", text: "hello there" });
	});

	describe("parseSubmit command boundary", () => {
		const commands = [
			{ name: "goal", summary: "Set the goal", args: "<text>" },
			{ name: "goal.show", summary: "Show the goal" },
			{ name: "no-args", summary: "No arguments" },
		];

		test.each([
			["", { kind: "empty" }],
			["   \t\n", { kind: "empty" }],
			["/", { kind: "empty" }],
			["  /  ", { kind: "empty" }],
			["/goal", { kind: "command", name: "goal" }],
			["  /goal  ", { kind: "command", name: "goal" }],
			["/goal.show", { kind: "command", name: "goal.show" }],
			["/goal ship it", { kind: "command", name: "goal", args: "ship it" }],
			["/goal\tship it", { kind: "command", name: "goal", args: "ship it" }],
			["/goal\nship it", { kind: "command", name: "goal", args: "ship it" }],
			["/goal\r\nship it", { kind: "command", name: "goal", args: "ship it" }],
			["/goal\u00a0ship it", { kind: "command", name: "goal", args: "ship it" }],
			["/goal   ship it   ", { kind: "command", name: "goal", args: "ship it" }],
			["/goal first\nsecond", { kind: "command", name: "goal", args: "first\nsecond" }],
		] as const)("parses %j", (input, expected) => {
			expect(parseSubmit(input, commands)).toEqual(expected);
		});

		test.each([
			"goal",
			"hello /goal",
			"//goal",
			"/unknown",
			"/unknown words",
			"/Goal",
			"/GOAL",
			"/goal!",
			"/goal/child",
			"/goal..show",
			"/goal.show.more",
			"/no-args surprise",
		])("keeps %j as an agent prompt", (input) => {
			expect(parseSubmit(input, commands)).toEqual({ kind: "prompt", text: input.trim() });
		});

		test("does not mutate the registry or depend on command order", () => {
			const reversed = [...commands].reverse();
			expect(parseSubmit("/goal.show", commands)).toEqual(parseSubmit("/goal.show", reversed));
			expect(commands.map((command) => command.name)).toEqual(["goal", "goal.show", "no-args"]);
		});
	});
});

describe("command registry bindings", () => {
	test("every registered action executes through the one run path", async () => {
		const { store, controller } = await freshController();
		const names = controller.commands.all().map((command) => command.name);
		expect(names).toEqual([
			"connect",
			"world",
			"theme",
			"surfaces",
			"dark-mode",
			"chat",
			"retry",
			"chat.stop",
			"stop",
			"send",
			"repos.watch",
			"repos.watch.toggle",
			"repos.watch.all",
			"repos.watch.none",
			"repos.watch.confirm",
			"clear",
			"browser",
			"flow.create",
			"flow.repo.choose",
			"flow.run.stop",
			"flow.run.retry",
			"flow.list",
			"flow.run",
			"card.maximize",
			"card.minimize",
			"copy-message",
			"approval.approve",
			"approval.deny",
			"connector.add",
			"connector.downgrade",
			"connector.remove",
			"world.new-note",
			"world.select",
			"world.delete",
			"auth.sign-in",
			"auth.prompt",
			"auth.sign-out",
			"auth.request-access",
			"toast.dismiss",
			"billing.balance",
			"reco.accept",
			"reco.edit",
			"reco.dismiss",
			"reco.refresh",
			"repos.import",
			"issues.list",
			"issues.view",
			"issues.create",
			"issues.close",
			"issues.reopen",
			"issues.comment",
			"prs.list",
			"prs.view",
			"prs.create",
			"prs.land",
			"prs.review",
			"billing.upgrade",
			"billing.portal",
			"keys.list",
			"keys.remove",
			"notifications.list",
			"notifications.read",
			"env.view",
			"env.set",
			"branches.list",
			"files.list",
			"files.read",
			"repos.app",
			"reload",
			"flows",
		]);

		expect((await controller.commands.run("connect")).status).toBe("executed");
		expect(store.session().surface).toBe("connectors");
		// Toggles toggle (§2c): invoking the open pane's command returns to chat.
		expect((await controller.commands.run("connect")).status).toBe("executed");
		expect(store.session().surface).toBe("chat");
		expect((await controller.commands.run("world")).status).toBe("executed");
		expect(store.session().surface).toBe("world");
		expect((await controller.commands.run("world")).status).toBe("executed");
		expect(store.session().surface).toBe("chat");
		expect((await controller.commands.run("world")).status).toBe("executed");
		expect(store.session().surface).toBe("world");
		expect((await controller.commands.run("chat")).status).toBe("executed");
		expect(store.session().surface).toBe("chat");

		const before = store.session().theme;
		expect((await controller.commands.run("dark-mode")).status).toBe("executed");
		expect(store.session().theme).not.toBe(before);

		expect((await controller.commands.run("world.new-note")).status).toBe("executed");
		const note = [...store.collections.worldDocuments.values()].find((document) =>
			document.path.startsWith("Untitled"),
		);
		expect(note).toBeDefined();
		expect((await controller.commands.run("world.delete", note?.id ?? "")).status).toBe("executed");
		expect(store.collections.worldDocuments.get(note?.id ?? "")).toBeUndefined();

		expect((await controller.commands.run("does-not-exist")).status).toBe("unknown-command");
		const failed = await controller.commands.run("connector.remove");
		expect(failed.status).toBe("failed");
	});

	test("a waiting recommendation leads the recommendations, gold first", () => {
		expect(recommendedNames({ ...chatState, hasRecommendation: true })[0]).toBe("reco.accept");
		expect(recommendedNames({ ...chatState, hasRecommendation: true, surface: "world" })[1]).toBe(
			"reco.accept",
		);
		// Typing still outranks everything — stop first.
		expect(recommendedNames({ ...chatState, hasRecommendation: true, typing: true })).toEqual([
			"chat.stop",
		]);
	});

	test("admin commands are ABSENT for a non-admin session, present for an admin", async () => {
		const { store, controller } = await freshController();
		const names = controller.commands.all().map((command) => command.name);
		// Not hidden — absent. A non-admin session's enumeration surface has no trace.
		expect(names.some((name) => name.startsWith("admin."))).toBe(false);
		expect((await controller.commands.run("admin.health")).status).toBe("unknown-command");
		// The bare reset refresh affordance is admin-only too (§2): /reset for a
		// non-admin renders the same unknown-command state as any typo, and no
		// registry surface carries it.
		expect(names).not.toContain("reset");
		expect((await controller.commands.run("reset")).status).toBe("unknown-command");
		expect(controller.slashItems("reset")).toHaveLength(0);
		// The agent tool's list carries no trace either.
		const listed = await executeAgentToolCall(controller.commands, {
			name: "commands",
			arguments: JSON.stringify({ action: "list" }),
		});
		expect(listed).not.toContain("admin.");
		expect(listed).not.toContain('"reset"');

		// Flip the session to admin (as a validated identity.session.loaded would).
		store.dispatch({
			type: "identity.session.loaded",
			actor: "system",
			state: "signed-in",
			login: "will",
			allowlisted: true,
			admin: true,
			scopesPlain: null,
		});
		const adminNames = controller.commands.all().map((command) => command.name);
		expect(adminNames).toContain("admin.allowlist.add");
		expect(adminNames).toContain("admin.allowlist.remove");
		expect(adminNames).toContain("admin.grant");
		expect(adminNames).toContain("admin.requests");
		expect(adminNames).toContain("admin.feedback");
		expect(adminNames).toContain("admin.health");
		expect(adminNames).toContain("reset");
		expect(adminNames).toContain("admin.devtools");
		// The debug reads compose the admin-only registry + trigger axis.
		expect(adminNames).toContain("debug.snapshot");
		expect(adminNames).toContain("debug.events");
		expect(adminNames).toContain("debug.seams");
	});

	test("the trigger axis: user-only commands are invisible to and uncallable by the agent", async () => {
		const { controller } = await freshController();
		const listed = await executeAgentToolCall(controller.commands, {
			name: "commands",
			arguments: JSON.stringify({ action: "list" }),
		});
		const parsed = JSON.parse(listed) as { commands: Array<{ name: string }> };
		const agentNames = parsed.commands.map((command) => command.name);
		// Browser mechanics never appear in the agent's tool catalog.
		for (const userOnly of [
			"auth.sign-in",
			"auth.sign-out",
			"theme",
			"dark-mode",
			"chat.stop",
			"send",
			"card.maximize",
		]) {
			expect(agentNames).not.toContain(userOnly);
		}
		expect(agentNames).toContain("connect");
		expect(agentNames).toContain("repos.watch");
		expect(agentNames).toContain("browser");

		// Asking for one anyway gets an honest tool-result error naming the
		// visible alternative — never a silent refusal, never an execution.
		const signIn = await executeAgentToolCall(controller.commands, {
			name: "commands",
			arguments: JSON.stringify({ action: "execute", name: "auth.sign-in" }),
		});
		expect(signIn).toContain("user-only");
		expect(signIn).toContain("button the human clicks");

		const theme = await executeAgentToolCall(controller.commands, {
			name: "commands",
			arguments: JSON.stringify({ action: "execute", name: "theme" }),
		});
		expect(theme).toContain("user-only");

		// The user-only guard never leaks into the user path: the human's own
		// invocation still executes.
		expect((await controller.commands.run("theme")).status).toBe("executed");
	});

	/*
	 * Two commands, two axes: /theme wears a color palette and /dark-mode
	 * flips light and dark. Neither is the other's alias — the toggle used to
	 * hide behind /theme, and repurposing the name without promoting the
	 * toggle would have left the light/dark control unreachable by name.
	 */
	test("the color theme and the light/dark toggle are independent commands", async () => {
		const { store, controller } = await freshController();
		const registered = controller.commands.all();
		expect(canonical("theme", registered)).toBe("theme");
		expect(canonical("dark-mode", registered)).toBe("dark-mode");
		const toggle = controller.commands.find("dark-mode");
		expect(toggle?.metadata.aliasOf).toBeUndefined();
		expect(toggle?.metadata.hidden).toBeUndefined();
		// Listed, so the human can find the toggle in the slash menu.
		expect(controller.slashItems("dark-mode").map((item) => item.command.name)).toContain("dark-mode");
		// The args hint is what makes `/theme <palette>` parse as an invocation.
		expect(controller.commands.find("theme")?.metadata.args).toBeDefined();

		// The default palette is night-owl, and every key round-trips.
		expect(store.session().palette).toBe("night-owl");
		for (const palette of PALETTES) {
			expect((await controller.commands.run("theme", palette)).status).toBe("executed");
			expect(store.session().palette).toBe(palette);
		}
		const last = PALETTES[PALETTES.length - 1];
		expect(store.session().palette).toBe(last);

		// An unknown key never rounds to the nearest palette: it fails honestly,
		// opens the picker (the list of valid answers IS the interface), and
		// leaves the current palette alone.
		const unknown = await controller.commands.run("theme", "dracula");
		expect(unknown.status).toBe("failed");
		if (unknown.status === "failed") expect(unknown.error).toContain("night-owl");
		expect(store.session().palette).toBe(last);
		const picker = () => store.collections.cards.get("theme-picker");
		expect(picker()?.kind).toBe("theme-picker");
		if (picker()?.kind === "theme-picker") {
			expect(picker()?.payload).toEqual({ selected: last });
		}

		// Bare /theme surfaces the picker card with the current palette marked.
		expect((await controller.commands.run("theme")).status).toBe("executed");
		expect(picker()?.kind).toBe("theme-picker");
		if (picker()?.kind === "theme-picker") {
			expect(picker()?.payload).toEqual({ selected: last });
		}

		// Choosing from the picker keeps its "current" mark honest.
		expect((await controller.commands.run("theme", PALETTES[0] ?? "night-owl")).status).toBe("executed");
		if (picker()?.kind === "theme-picker") {
			expect(picker()?.payload).toEqual({ selected: PALETTES[0] });
		}
		expect((await controller.commands.run("theme", last ?? "night-owl")).status).toBe("executed");

		// The axes never touch: the toggle flips the theme and nothing else.
		const before = store.session().theme;
		expect((await controller.commands.run("dark-mode")).status).toBe("executed");
		expect(store.session().theme).not.toBe(before);
		expect(store.session().palette).toBe(last);
	});

	test("a bare /name typed into the composer runs the command, not a prompt", async () => {
		const { store, controller } = await freshController();
		controller.changeDraft("/world");
		controller.send(store.session().draft);
		expect(store.session().surface).toBe("world");
		expect(store.session().draft).toBe("");
		expect([...store.collections.messages.values()].some((m) => m.text === "/world")).toBe(false);
	});

	test("slashItems surfaces the recommended command first for a bare /", async () => {
		const { controller } = await freshController();
		const items = controller.slashItems("");
		expect(items[0]?.command.name).toBe("connect");
		expect(items[0]?.recommended).toBe(true);
	});

	test("the agent tool lists commands and executes them through the same path", async () => {
		const { controller } = await freshController();
		const listed = await executeAgentToolCall(controller.commands, {
			name: "commands",
			arguments: JSON.stringify({ action: "list" }),
		});
		const parsed = JSON.parse(listed) as {
			state: { surface: string };
			commands: Array<{ name: string }>;
		};
		expect(parsed.state.surface).toBe("chat");
		expect(parsed.commands.some((command) => command.name === "connect")).toBe(true);
		expect(parsed.commands.some((command) => command.name === "connector.remove")).toBe(false);

		const executed = await executeAgentToolCall(controller.commands, {
			name: "commands",
			arguments: JSON.stringify({ action: "execute", name: "connect" }),
		});
		expect(executed).toBe("executed /connect");

		// The recovery is in the error: the dead-end "unknown-command: nope"
		// left the live model telling the USER to run the command instead of
		// retrying with a listed name in the same turn.
		const unknown = await executeAgentToolCall(controller.commands, {
			name: "commands",
			arguments: JSON.stringify({ action: "execute", name: "nope" }),
		});
		expect(unknown).toBe(
			"unknown-command: nope — no command has that name; use the list action for every command callable right now",
		);
	});

	test("the model may spell a command the way the catalog does — /name resolves to name", async () => {
		/*
		 * The generated capability section spells every command "/name", and
		 * live on canary the model echoed that spelling into the tool call:
		 * execute {"name":"/browser"} died as unknown-command and the turn
		 * degraded into asking permission for the act it had been asked to do.
		 * The agent boundary strips the catalog's slash exactly as the
		 * composer's parseSubmit strips the human's; the registry's names stay
		 * bare.
		 */
		const { store, controller } = await freshController();
		const executed = await executeAgentToolCall(controller.commands, {
			name: "commands",
			arguments: JSON.stringify({ action: "execute", name: "/connect" }),
		});
		expect(executed).toBe("executed /connect");
		expect(store.session().surface).toBe("connectors");

		// The user-only guard holds under the slash spelling too.
		const theme = await executeAgentToolCall(controller.commands, {
			name: "commands",
			arguments: JSON.stringify({ action: "execute", name: "/theme" }),
		});
		expect(theme).toContain("user-only");

		// A bare "/" names nothing.
		const empty = await executeAgentToolCall(controller.commands, {
			name: "commands",
			arguments: JSON.stringify({ action: "execute", name: "/" }),
		});
		expect(empty).toBe("failed: the execute action requires a command name");
	});
});
