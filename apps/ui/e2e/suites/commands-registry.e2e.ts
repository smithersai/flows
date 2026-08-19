/*
 * E5 — the flow registry, end to end.
 *
 * Checklist ids proved here: E5.1 (every visible affordance resolves to a named
 * command reachable by /name), E5.2 ("/" opens with the recommended command
 * first and bare "/" + Enter runs it), E5.3 (exact-name precedence, asserted at
 * the keyboard rather than only in a unit fixture), E5.4 (the section-A journey
 * keyboard-only), E5.7 (a registry-driven smoke over every registered command)
 * and E5.8 (/clear keeps before it clears, and keeps everything on a failed
 * sweep).
 *
 * The load-bearing idea is SMOKE_TABLE below. It carries one entry per
 * registered flow, and the first thing this suite does is compare its key set
 * against the live registry for an admin session. A command added to Flows.ts
 * with no entry here fails immediately, and an entry naming a flow that no
 * longer exists fails too — so the smoke's coverage of the registry cannot
 * silently regress by addition, which is the only way coverage ever regresses.
 *
 * Everything is invoked through `controller.commands.run`, which is the one
 * door a button, a slash submit and an agent tool call all share
 * (flows/Commands.ts `runAs`). Smoking that door therefore smokes all three
 * triggers at once.
 *
 * WHAT THE SMOKE PROVES, EXACTLY
 *
 * 83 of the 88 registered flows are invoked; the other 5 are destructive and
 * are proved registered and proved never invoked instead. Every invocation is
 * held to two bars:
 *
 *  1. `honest` — the refusal shape. Never unknown-command; a failure carries a
 *     non-empty message with no interpolated `undefined`, no stringified
 *     object, no stack frame and no FlowBinding cell frame.
 *  2. `floor` — the effect. Every entry declares the effect class its
 *     invocation must produce (an answer, a message, a card, a toast, some
 *     other journaled state change, or an honest refusal), and at least one of
 *     them must actually be observed. 15 entries additionally pin the WORDING
 *     of the refusal they answer with, so "it failed with some string" is not
 *     the bar for them. A flow that returns `executed` while journaling nothing
 *     and answering nothing fails.
 *
 * What that still does NOT prove:
 *
 *  - That the effect is the RIGHT one. `proves` does that, and it is written
 *    for the entries whose effect has a shape worth pinning; the rest satisfy
 *    the floor with a card, a message or a refusal whose CONTENT nothing reads.
 *  - That every seam is wired. Nine of the fifteen pinned refusals are the
 *    product's own words. The other six (`prs.list`, `prs.view`, `prs.review`,
 *    `prs.land`, `billing.upgrade`, `billing.portal`) pin a refusal that is the
 *    DOUBLE saying it has no such route — scripts/stub-backends.ts answers 404
 *    with "platform stub: no route …" / "gateway stub: no route …". Those six
 *    invocations reach the Worker and prove the honest-404 path, nothing more.
 *    The pinned wording is what turns that into a signal: the day the double
 *    grows the route, the pin fails and the entry gets a real bar.
 *  - That six flows do anything at all. `retry`, `chat.stop`, `stop`,
 *    `copy-message`, `connector.downgrade` and `connector.remove` declare
 *    `silent`: in this environment they are no-ops, each entry says which state
 *    makes them one, and the floor pins them to being EXACTLY silent.
 */
import { SuiteFailure, wait, waitUntil, type Reporter } from "../Assert.ts";
import { openClient, type Client } from "../Client.ts";
import { defineSuite } from "../Suite.ts";
import type { CdpSession } from "../Browser.ts";
import type { CommandOutcome } from "../../src/mainview/flows/Commands.ts";
import { parseSubmit } from "../../src/mainview/flows/registry.ts";
import { payloadFor } from "../../src/mainview/flows/SlashPayload.ts";
import {
	FOCUS_COMPOSER,
	REGISTERED_COMMANDS,
	TABBABLE_FLOWS,
	VISIBLE_AFFORDANCES,
	hasSmithersMessage,
	unnamedAffordances,
	type Affordance,
} from "../../src/launch-checklist/Probes.ts";
import { BrowserUnavailableError } from "../../src/launch-checklist/Types.ts";

/* ------------------------------------------------------------------ */
/* The classification table                                            */
/* ------------------------------------------------------------------ */

/**
 * What a test may do with one registered flow.
 *
 * Precedence when a flow fits more than one class: destructive-skip beats
 * admin-only beats needs-fixture beats safe-to-smoke.
 */
export type SmokeClass = "safe-to-smoke" | "needs-fixture" | "destructive-skip" | "admin-only";

/** The fixtures the needs-fixture and admin invocations substitute into their arguments. */
interface Fixtures {
	/** The id of a real card in the signed-in client's store. */
	cardId: string;
	/** An approval card with no run identity, so the honest refusal is reachable. */
	approvalCardId: string;
	/** The card a workflow run rendered, or the chooser card when no run started. */
	runCardId: string;
	/** A world note this client owns. */
	documentId: string;
	/** A toast the earlier invocations raised. */
	toastId: string;
	/** The confirmation card `admin.grant` renders. */
	grantCardId: string;
}

interface Proof {
	readonly name: string;
	readonly outcome: CommandOutcome;
	readonly client: Client;
	readonly report: Reporter;
	readonly fixtures: Fixtures;
}

/**
 * The observable class of thing an invocation did — E5.7's floor.
 *
 * `answer` and `refusal` are read off the outcome; the rest are read off the
 * transition journal, which is the app's own ledger of every state change. A
 * flow whose invocation produces NONE of these did nothing at all, and that is
 * what the floor fails.
 */
export type Effect =
	/** Returned a value string; `runAs` renders it to whoever invoked. */
	| "answer"
	/** Failed honestly. In this environment some seams can only refuse, and the refusal IS the product behaviour. */
	| "refusal"
	/** Appended to the transcript. */
	| "message"
	/** Upserted, updated or removed a card. */
	| "card"
	/** Raised or dismissed a toast. */
	| "toast"
	/** Journaled some other app-state transition (surface, theme, palette, selection, watched repos, connectors…). */
	| "state"
	/**
	 * Journaled nothing and answered nothing, on purpose. Only ever declared
	 * alone, and only with a reason naming the state that makes it a no-op —
	 * this is the one way a flow is allowed to be silent, and writing it down
	 * is what stops "did nothing" from passing by accident.
	 */
	| "silent";

interface SmokeEntry {
	readonly klass: SmokeClass;
	/** The slash argument text, or a function of the fixtures. Absent = a bare invocation. */
	readonly args?: string | ((fixtures: Fixtures) => string);
	/** What must exist before the invocation. Required for needs-fixture and admin-only. */
	readonly fixture?: string;
	/** Why this flow sits in this class. One sentence. */
	readonly reason: string;
	/**
	 * The effect classes this invocation may produce; at least one must be
	 * observed. Required for every entry that is invoked (everything except
	 * destructive-skip). More than one name means the flow legitimately answers
	 * differently depending on what the doubles hold — never "either it worked
	 * or it did not".
	 */
	readonly effect?: ReadonlyArray<Effect>;
	/**
	 * A fragment the refusal must carry, for the flows whose declared effect is
	 * the refusal itself. Without it "it failed with a non-empty string" is the
	 * whole bar; with it the invocation is pinned to the ONE reason the entry
	 * claims, so a flow that starts refusing for a different reason — or stops
	 * refusing because a double grew the route it was missing — fails here
	 * instead of passing as a smoke.
	 */
	readonly refusal?: string;
	/** Proof beyond the honest-outcome contract every invocation is held to. */
	readonly proves?: (proof: Proof) => void | Promise<void>;
}

/**
 * What `/flow.list` actually rendered, filled in by its own invocation below.
 *
 * E5.3's keyboard stage proves that Enter on a typed `/flows` ran `flows` and
 * not the `flow.list` its summary also matches. That proof is an exclusion, and
 * an exclusion is only worth something when the excluded string is one the
 * product really produces — so it is recorded here rather than written down.
 */
const flowListRendered: { title: string; answer: string } = { title: "", answer: "" };

const surfaceIs = (surface: string) => (proof: Proof): void => {
	proof.report.equals(proof.client.store.session().surface, surface, `/${proof.name} did not move the app to the ${surface} surface`);
};

/*
 * One entry per registered flow. The `reason` is what a reader needs in order
 * to disagree with the classification; the `fixture` is what the runner has to
 * build first. Nine of the needs-fixture entries mutate the platform double
 * (issues.create/close/reopen/comment, prs.create/land/review, env.set,
 * keys.remove) — none of them may be promoted to a canary run without a
 * scratch account.
 */
const SMOKE_TABLE: Readonly<Record<string, SmokeEntry>> = {
	/* ---------------- safe-to-smoke: 17 ---------------- */
	flows: {
		klass: "safe-to-smoke",
		effect: ["message"],
		reason: "Dispatches the catalog listing into the transcript; touches no seam.",
		proves: ({ client, report }) => {
			const listing = client.messages().find((message) => message.text.startsWith("Everything Smithers can do right now:"));
			if (listing === undefined) {
				report.fail("/flows wrote no catalog message into the transcript");
				return;
			}
			const listed = listing.text.split("\n").filter((line) => line.startsWith("- `/"));
			const visible = client.controller.commands.all().filter((command) => command.hidden !== true);
			report.equals(listed.length, visible.length, "/flows listed a different number of flows than the registry shows");
			for (const command of visible) {
				report.includes(listing.text, `- \`/${command.name}\``, `/flows omitted ${command.name} from the catalog it printed`);
			}
		},
	},
	connect: {
		klass: "safe-to-smoke",
		effect: ["state"],
		reason: "Opens the connectors pane; invoking it changes only local surface state.",
		proves: surfaceIs("connectors"),
	},
	world: { klass: "safe-to-smoke", effect: ["state"], reason: "Opens the world pane.", proves: surfaceIs("world") },
	chat: { klass: "safe-to-smoke", effect: ["state"], reason: "Returns to the conversation.", proves: surfaceIs("chat") },
	surfaces: {
		klass: "safe-to-smoke",
		effect: ["state"],
		reason: "Toggles the composer's surfaces menu, a local flag.",
		proves: ({ client, report }) =>
			report.equals(client.store.session().surfacesMenuOpen, true, "/surfaces did not open the surfaces menu"),
	},
	"dark-mode": {
		klass: "safe-to-smoke",
		effect: ["state"],
		reason: "Flips light/dark, a local flag with no seam behind it.",
		proves: ({ client, report }) =>
			report.equals(client.store.session().theme, "dark", "/dark-mode did not flip the light theme to dark"),
	},
	theme: {
		klass: "safe-to-smoke",
		effect: ["state"],
		// Deliberately not night-owl: that is DEFAULT_PALETTE, so asserting it
		// would pass on a /theme that did nothing at all.
		args: "paper",
		reason: "Wears a registered palette; the argument is one of the names its own args hint lists.",
		proves: ({ client, report }) =>
			report.equals(client.store.session().palette, "paper", "/theme did not record the chosen palette"),
	},
	retry: {
		klass: "safe-to-smoke",
		effect: ["silent"],
		reason: "With no prior user message there is nothing to resend, so it settles without a turn.",
	},
	"chat.stop": { klass: "safe-to-smoke", effect: ["silent"], reason: "With no turn in flight it is a no-op." },
	stop: {
		klass: "safe-to-smoke",
		effect: ["silent"],
		reason: "The hidden alias of chat.stop; invoking it proves alias resolution through `canonical`. Silent for the same reason: no turn is in flight.",
	},
	"card.minimize": { klass: "safe-to-smoke", effect: ["card"], reason: "No card is maximized, so it is a no-op." },
	"copy-message": {
		klass: "safe-to-smoke",
		effect: ["silent"],
		args: "a smoke message",
		reason: "bun's navigator carries no clipboard, and the handler reads it optionally.",
	},
	"connector.add": {
		klass: "safe-to-smoke",
		effect: ["state"],
		args: "read",
		reason: "There is no native bridge in a headless run, so the honest refusal reaching the connector pane is the assertion.",
		proves: ({ client, report }) => {
			// The refusal lands on the connector operation, not on the outcome:
			// a swallowed picker error would leave the pane blank and the phase
			// stuck mid-selection.
			const operation = client.store.collections.connectorOperations.get("connector-operation");
			report.equals(operation?.phase, "idle", "/connector.add left the connector operation mid-selection");
			report.check(
				(operation?.error ?? "").trim() !== "",
				"/connector.add swallowed the picker's refusal instead of stating it",
			);
		},
	},
	"connector.downgrade": {
		klass: "safe-to-smoke",
		effect: ["silent"],
		args: "connector-that-does-not-exist",
		reason: "A connector cannot be created without the native bridge, so the id cannot exist and the downgrade has nothing to change; the contract is an honest outcome, never a throw.",
	},
	"connector.remove": {
		klass: "safe-to-smoke",
		effect: ["silent"],
		args: "connector-that-does-not-exist",
		reason: "Same as connector.downgrade: no bridge, so the id cannot exist and the removal has nothing to remove.",
	},
	"world.new-note": {
		klass: "safe-to-smoke",
		effect: ["state"],
		reason: "Creates an untitled note in the local store; no seam is involved.",
		proves: ({ client, report }) =>
			report.check(
				client.worldDocuments().some((document) => document.path.startsWith("Untitled")),
				"/world.new-note created no untitled world note",
			),
	},
	"auth.prompt": {
		klass: "safe-to-smoke",
		effect: ["message"],
		reason: "Renders the sign-in step as a chat message — the agent's door to login.",
		proves: ({ client, report }) =>
			report.check(client.transcript().toLowerCase().includes("sign in"), "/auth.prompt rendered no sign-in step"),
	},

	/* ---------------- needs-fixture: 50 ---------------- */
	"repos.watch": {
		klass: "needs-fixture",
		effect: ["card"],
		fixture: "a signed-in session, so the chooser can list the user's repositories",
		reason: "Requires signed-in and opens the chooser card the four chooser acts below operate on.",
		proves: ({ client, report }) =>
			report.check(
				client.cards().some((card) => card.kind === "repo-chooser"),
				"/repos.watch opened no repo-chooser card",
			),
	},
	"repos.watch.all": {
		klass: "needs-fixture",
		effect: ["card"],
		fixture: "the chooser card, opened by repos.watch",
		reason: "Selects every candidate in the open chooser.",
	},
	"repos.watch.none": {
		klass: "needs-fixture",
		effect: ["card"],
		fixture: "the chooser card, opened by repos.watch",
		reason: "Clears the chooser's selection; run after repos.watch.all so the toggle below has a known start.",
	},
	"repos.watch.toggle": {
		klass: "needs-fixture",
		effect: ["card"],
		args: "will/flows",
		fixture: "the chooser card with an empty selection, left by repos.watch.none",
		reason: "Selects one candidate by name, leaving exactly will/flows for the confirm below.",
	},
	"repos.watch.confirm": {
		klass: "needs-fixture",
		effect: ["card"],
		fixture: "the chooser card carrying exactly one selected repository",
		reason: "Writes the watched selection, which is what satisfies the repos-selected requirement.",
		proves: ({ client, report }) =>
			report.equals(
				client.controller.commands.state().needsSelection,
				false,
				"/repos.watch.confirm left the watched-repos requirement unsatisfied",
			),
	},
	"flow.list": {
		klass: "needs-fixture",
		effect: ["answer"],
		fixture: "a signed-in session and a provisioned gateway",
		reason: "Requires signed-in; lists the workspace's workflows through the gateway seam.",
		/*
		 * Recorded, not just checked. The E5.3 keyboard stage has to prove that
		 * Enter on a typed /flows did NOT run flow.list, and the only honest way
		 * to do that is to exclude the strings flow.list really renders. They are
		 * captured here, from a real invocation in this same run, so the
		 * exclusion can never be a literal the product does not contain.
		 */
		proves: ({ client, report, outcome }) => {
			const card = client.cards().find((entry) => entry.kind === "workflow-list");
			if (card === undefined) {
				report.fail("/flow.list rendered no workflow-list card");
				return;
			}
			report.check(
				card.title.startsWith("Workflows — "),
				`/flow.list titled its card ${JSON.stringify(card.title)}, which is not the "Workflows — <repo>" the card is minted with`,
			);
			report.equals(card.id, `workflow-list-${card.title.slice("Workflows — ".length)}`, "the workflow-list card id no longer names the repo its title does");
			const answer = outcome.status === "executed" ? (outcome.value ?? "") : "";
			report.check(
				answer.startsWith("Workflows on ") || answer.startsWith("No workflows on "),
				`/flow.list answered ${JSON.stringify(answer.slice(0, 80))}, which is neither of the two lines it can return`,
			);
			flowListRendered.title = card.title;
			flowListRendered.answer = answer;
		},
	},
	"flow.create": {
		klass: "needs-fixture",
		effect: ["answer"],
		args: "a workflow that summarizes my open issues",
		fixture: "a signed-in session AND a confirmed watched selection (it declares both requirements)",
		reason: "The only flow besides flow.run declaring two requirements, so it proves the requirement chain end to end.",
	},
	"flow.repo.choose": {
		klass: "needs-fixture",
		effect: ["refusal"],
		refusal: "There's no repository question open right now.",
		args: "will/flows",
		fixture: "a workflow-repo question card, or the honest refusal when none is open",
		reason: "Answers the 'which watched repository?' question with one act.",
	},
	"flow.run": {
		klass: "needs-fixture",
		effect: ["answer"],
		args: "create-workflow will/flows",
		fixture: "a signed-in session and a confirmed watched selection",
		reason: "Launches a named workflow the gateway double publishes.",
	},
	"flow.run.retry": {
		klass: "needs-fixture",
		effect: ["card"],
		args: (fixtures) => fixtures.runCardId,
		fixture: "a run card id, recorded from whatever flow.run rendered",
		reason: "Re-checks a run that went quiet; run before flow.run.stop so the card is still watched.",
	},
	"flow.run.stop": {
		klass: "needs-fixture",
		effect: ["card"],
		args: (fixtures) => fixtures.runCardId,
		fixture: "the same run card id",
		reason: "Stops watching a run, so it runs last of the two run acts.",
	},
	"card.maximize": {
		klass: "needs-fixture",
		effect: ["card"],
		args: (fixtures) => fixtures.cardId,
		fixture: "any card in this client's store",
		reason: "Presentation only, but it needs a card that exists to be more than a no-op.",
		proves: ({ client, report, fixtures }) =>
			report.equals(
				client.store.session().maximizedCardId,
				fixtures.cardId,
				"/card.maximize did not record the maximized card",
			),
	},
	"approval.approve": {
		klass: "needs-fixture",
		effect: ["card"],
		args: (fixtures) => fixtures.approvalCardId,
		fixture: "an approval card with no run identity, dispatched into the store",
		reason: "An approval that is not linked to a run must say so, never fake-freeze — that honest path is what is smoked.",
	},
	"approval.deny": {
		klass: "needs-fixture",
		effect: ["card"],
		args: (fixtures) => fixtures.approvalCardId,
		fixture: "the same approval card",
		reason: "The denial half of the same door.",
	},
	"world.select": {
		klass: "needs-fixture",
		effect: ["state"],
		args: (fixtures) => fixtures.documentId,
		fixture: "a world note, created through the controller before the walk",
		reason: "Opens a note by id; must run before world.delete removes it.",
	},
	"world.delete": {
		klass: "needs-fixture",
		effect: ["state"],
		args: (fixtures) => fixtures.documentId,
		fixture: "the same world note",
		reason: "Removes the note, so it is the last act on that id.",
		proves: ({ client, report, fixtures }) =>
			report.check(
				!client.worldDocuments().some((document) => document.id === fixtures.documentId),
				"/world.delete left the note in the store",
			),
	},
	browser: {
		klass: "needs-fixture",
		effect: ["card"],
		refusal: "Only https:// pages can be read.",
		args: "http://127.0.0.1:1/",
		fixture: "a signed-in session — the Worker's browser route is behind the session gate",
		reason: "The Worker refuses a non-https private target; the refusal reaching the user is the assertion.",
		proves: ({ client, report }) =>
			report.check(
				client.cards().some((card) => card.kind === "browser"),
				"/browser rendered no browser card for the refused page",
			),
	},
	"auth.request-access": {
		klass: "needs-fixture",
		effect: ["state"],
		fixture: "a signed-in session",
		reason: "Requires signed-in; posts the access request to the identity seam.",
	},
	"billing.balance": {
		klass: "needs-fixture",
		effect: ["card"],
		fixture: "a signed-in session",
		reason: "Requires signed-in; reads the balance through the billing seam.",
	},
	"billing.upgrade": {
		klass: "needs-fixture",
		effect: ["refusal"],
		refusal: "gateway stub: no route /api/billing/checkout",
		fixture: "a signed-in session",
		reason: "Opens a Stripe checkout session; there is no window in a headless run, so only the seam call happens.",
	},
	"billing.portal": {
		klass: "needs-fixture",
		effect: ["refusal"],
		refusal: "gateway stub: no route /api/billing/portal",
		fixture: "a signed-in session",
		reason: "Same seam, the portal half.",
	},
	"reco.refresh": {
		klass: "needs-fixture",
		effect: ["state"],
		fixture: "a signed-in session",
		reason: "Reads the recommendation again; run first of the four so the other three have a card to act on.",
	},
	"reco.edit": {
		klass: "needs-fixture",
		effect: ["card"],
		fixture: "a recommendation card, or the honest refusal when the seam is degraded",
		reason: "Puts the recommendation into the composer for editing.",
	},
	"reco.dismiss": {
		klass: "needs-fixture",
		effect: ["refusal"],
		refusal: "There is no current recommendation to dismiss.",
		fixture: "a recommendation card",
		reason: "Dismisses the card and records the feedback.",
	},
	"reco.accept": {
		klass: "needs-fixture",
		effect: ["refusal"],
		refusal: "There is no current recommendation to accept.",
		fixture: "no live recommendation — it runs after reco.dismiss on purpose",
		reason: "Accepting launches a real run; invoked after the dismissal so the smoke exercises the answer rather than babysitting a workflow.",
	},
	"repos.import": {
		klass: "needs-fixture",
		effect: ["card"],
		args: "will/flows",
		fixture: "the platform double armed with /stub/import-ready so the poll loop terminates",
		reason: "Starts an import job and tracks it to a terminal state.",
	},
	"issues.list": {
		klass: "needs-fixture",
		effect: ["card"],
		args: "open will/flows",
		fixture: "a signed-in session; will/flows is imported in the platform double",
		reason: "Reads a repository's issues through the platform proxy.",
	},
	"issues.view": {
		klass: "needs-fixture",
		effect: ["refusal"],
		refusal: "issue detail needs the import",
		args: "1 will/flows",
		fixture: "issue 1 in the platform double",
		reason: "Opens one issue with its comments.",
	},
	"issues.create": {
		klass: "needs-fixture",
		effect: ["card"],
		args: "A smoke issue will/flows",
		fixture: "a signed-in session",
		reason: "MUTATES the platform double: never point this at a real account.",
	},
	"issues.comment": {
		klass: "needs-fixture",
		effect: ["refusal"],
		refusal: "isn't imported yet",
		args: "1 a smoke comment will/flows",
		fixture: "issue 1 in the platform double",
		reason: "MUTATES the platform double.",
	},
	"issues.close": {
		klass: "needs-fixture",
		effect: ["refusal"],
		refusal: "isn't imported yet",
		args: "1 will/flows",
		fixture: "issue 1 open in the platform double",
		reason: "MUTATES the platform double; run before issues.reopen so both transitions are exercised.",
	},
	"issues.reopen": {
		klass: "needs-fixture",
		effect: ["refusal"],
		refusal: "isn't imported yet",
		args: "1 will/flows",
		fixture: "issue 1 closed by the invocation above",
		reason: "MUTATES the platform double, and restores the state issues.close changed.",
	},
	"prs.list": {
		klass: "needs-fixture",
		effect: ["refusal"],
		refusal: "no route GET /api/repos/will/flows/landings",
		args: "will/flows",
		fixture: "a signed-in session",
		reason: "Reads a repository's pull requests through the platform proxy.",
	},
	"prs.view": {
		klass: "needs-fixture",
		effect: ["refusal"],
		refusal: "no route GET /api/repos/will/flows/landings/1",
		args: "1 will/flows",
		fixture: "landing 1 in the platform double",
		reason: "Opens one pull request with reviews and checks.",
	},
	"prs.create": {
		klass: "needs-fixture",
		effect: ["refusal"],
		refusal: "prs.create needs a source branch",
		args: "A smoke pull request will/flows",
		fixture: "a signed-in session",
		reason: "MUTATES the platform double.",
	},
	"prs.review": {
		klass: "needs-fixture",
		effect: ["refusal"],
		refusal: "no route POST /api/repos/will/flows/landings/1/reviews",
		args: "1 comment looks fine will/flows",
		fixture: "landing 1 in the platform double",
		reason: "MUTATES the platform double; the three-token grammar (number, verdict, text) is the widest one payloadFor parses.",
	},
	"prs.land": {
		klass: "needs-fixture",
		effect: ["refusal"],
		refusal: "no route PUT /api/repos/will/flows/landings/1/land",
		args: "1 will/flows",
		fixture: "landing 1 in the platform double",
		reason: "MUTATES the platform double; queues the merge, so it runs last of the pr acts.",
	},
	"keys.list": {
		klass: "needs-fixture",
		effect: ["card"],
		fixture: "a signed-in session",
		reason: "Lists the masked BYOK keys.",
	},
	"keys.remove": {
		klass: "needs-fixture",
		effect: ["card"],
		args: "anthropic",
		fixture: "the anthropic key the platform double ships with",
		reason: "MUTATES the platform double by removing a key.",
	},
	"notifications.list": {
		klass: "needs-fixture",
		effect: ["card"],
		fixture: "a signed-in session",
		reason: "Reads the notification list.",
	},
	"notifications.read": {
		klass: "needs-fixture",
		effect: ["card"],
		fixture: "the notifications listed above",
		reason: "MUTATES the platform double by marking everything read.",
	},
	"env.view": {
		klass: "needs-fixture",
		effect: ["card"],
		args: "will/flows",
		fixture: "a signed-in session",
		reason: "Reads the agent environment for a repository.",
	},
	"env.set": {
		klass: "needs-fixture",
		effect: ["card"],
		args: "SMOKE=1 will/flows",
		fixture: "a signed-in session",
		reason: "MUTATES the platform double by writing an environment variable.",
	},
	"branches.list": {
		klass: "needs-fixture",
		effect: ["card"],
		args: "will/flows",
		fixture: "a signed-in session",
		reason: "Lists a repository's bookmarks.",
	},
	"files.list": {
		klass: "needs-fixture",
		effect: ["card"],
		args: "src will/flows",
		fixture: "the src directory the platform double publishes",
		reason: "Lists one directory; a bare argument would parse as the path, so the repo is named explicitly.",
	},
	"files.read": {
		klass: "needs-fixture",
		effect: ["card"],
		args: "README.md will/flows",
		fixture: "the README.md the platform double publishes",
		reason: "Reads one file.",
	},
	"repos.app": {
		klass: "needs-fixture",
		effect: ["message"],
		args: "will/flows",
		fixture: "a signed-in session",
		reason: "Checks the Smithers GitHub App on a repository.",
	},
	"toast.dismiss": {
		klass: "needs-fixture",
		effect: ["toast"],
		args: (fixtures) => fixtures.toastId,
		fixture: "a toast raised the way a user gets one — `controller.runCommand` (the BUTTON door) toasts a refusal, `commands.run` does not",
		reason: "Dismisses one toast by id.",
		proves: ({ client, report, fixtures }) =>
			report.equals(
				client.store.collections.toasts.get(fixtures.toastId),
				undefined,
				"/toast.dismiss left the toast it was given on screen",
			),
	},
	send: {
		klass: "needs-fixture",
		effect: ["message"],
		args: "hello from the command smoke",
		fixture: "its own client, so a streaming turn cannot perturb the other invocations",
		reason: "Runs a whole turn through the Worker; every other flow would see the composer busy.",
		proves: async ({ client, report }) => {
			await client.idle(30_000);
			report.check(
				client.transcript().includes("hello from the command smoke"),
				"/send did not put the submitted text into the transcript",
			);
			report.check(client.countCalls("POST", "/api/agent/turn") > 0, "/send opened no turn against the Worker");
		},
	},
	clear: {
		klass: "needs-fixture",
		effect: ["state"],
		fixture: "its own client carrying a non-empty transcript, plus an armed sweep answer (E5.8)",
		reason: "Sweeps the transcript into world notes and then clears; it is proved in full by the E5.8 stage.",
	},

	/* ---------------- destructive-skip: 5 ---------------- */
	"auth.sign-in": {
		klass: "destructive-skip",
		reason: "Navigates the window to the OAuth start; inert only because a headless client has no window.",
	},
	"auth.sign-out": {
		klass: "destructive-skip",
		reason: "Clears the session every later invocation depends on.",
	},
	reload: { klass: "destructive-skip", reason: "Reloads the window — the same hazard as auth.sign-in." },
	reset: {
		klass: "destructive-skip",
		reason: "Admin-registered AND destructive: it wipes the transcript the /clear assertions read.",
	},
	"debug.grants.reset": {
		klass: "destructive-skip",
		reason: "Admin-registered AND destructive: it revokes the chain's session grants for the rest of the run.",
	},

	/* ---------------- admin-only: 16 ---------------- */
	"admin.devtools": {
		klass: "admin-only",
		effect: ["state"],
		fixture: "a session the identity double validates as admin",
		reason: "Toggles the dev-tools panel; registered only for an admin session.",
	},
	"debug.snapshot": {
		klass: "admin-only",
		effect: ["answer"],
		fixture: "an admin session",
		reason: "Reads the app state snapshot back as a message.",
	},
	"debug.events": { klass: "admin-only", effect: ["answer"], fixture: "an admin session", reason: "Reads the transition journal tail." },
	"debug.chain": { klass: "admin-only", effect: ["answer"], fixture: "an admin session", reason: "Reads the chain journal x-ray." },
	"debug.net": { klass: "admin-only", effect: ["answer"], fixture: "an admin session", reason: "Reads the network tap." },
	"debug.seams": {
		klass: "admin-only",
		effect: ["answer"],
		fixture: "an admin session",
		reason: "Probes seam and upstream health across every configured backend.",
	},
	"admin.allowlist.add": {
		klass: "admin-only",
		effect: ["message"],
		args: "octocat",
		fixture: "an admin session and the identity double's admin token",
		reason: "MUTATES the identity double's allowlist.",
	},
	"admin.allowlist.remove": {
		klass: "admin-only",
		effect: ["message"],
		args: "octocat",
		fixture: "the allowlist entry added above",
		reason: "MUTATES the identity double, and undoes the addition.",
	},
	"admin.grant": {
		klass: "admin-only",
		effect: ["card"],
		args: "25 octocat",
		fixture: "an admin session",
		reason: "Renders a confirmation card rather than granting; nothing is charged until the confirm below.",
		proves: ({ client, report }) =>
			report.check(
				client.cards().some((card) => card.status === "active" && /grant/i.test(card.title)),
				"/admin.grant rendered no confirmation card",
			),
	},
	"admin.grant.confirm": {
		klass: "admin-only",
		effect: ["card"],
		args: (fixtures) => fixtures.grantCardId,
		fixture: "the confirmation card admin.grant rendered",
		reason: "MUTATES the billing double by applying the grant.",
	},
	"admin.grant.cancel": {
		klass: "admin-only",
		effect: ["card"],
		args: (fixtures) => fixtures.grantCardId,
		fixture: "a second confirmation card, raised by re-running admin.grant as a fixture",
		reason: "Cancels a pending grant; it needs its own card because the confirm above consumed the first.",
	},
	"admin.requests": {
		klass: "admin-only",
		effect: ["card"],
		fixture: "an admin session",
		reason: "Reads the request-access queue.",
	},
	"admin.queue.approve": {
		klass: "admin-only",
		effect: ["card"],
		args: "octocat",
		fixture: "the request-access queue read above",
		reason: "MUTATES the identity double by approving a queued login.",
	},
	"admin.feedback": {
		klass: "admin-only",
		effect: ["card"],
		fixture: "an admin session",
		reason: "Reads the recommendation feedback log.",
	},
	"admin.health": {
		klass: "admin-only",
		effect: ["card"],
		fixture: "an admin session",
		reason: "Reads service health, charges and queue depth.",
	},
	"debug.backend": {
		klass: "admin-only",
		effect: ["answer"],
		fixture: "an admin session",
		reason: "Reports which backend drives a turn. Invoked with no argument: an argument is a request to switch, and the one backend answers that with a refusal rather than a reading.",
	},
};

/** The order the needs-fixture invocations run in. Order is load-bearing; see each entry's reason. */
const FIXTURE_ORDER: ReadonlyArray<string> = [
	"repos.watch",
	"repos.watch.all",
	"repos.watch.none",
	"repos.watch.toggle",
	"repos.watch.confirm",
	"flow.list",
	"flow.create",
	"flow.repo.choose",
	"flow.run",
	"flow.run.retry",
	"flow.run.stop",
	"card.maximize",
	"approval.approve",
	"approval.deny",
	"world.select",
	"world.delete",
	"browser",
	"auth.request-access",
	"billing.balance",
	"billing.upgrade",
	"billing.portal",
	"reco.refresh",
	"reco.edit",
	"reco.dismiss",
	"reco.accept",
	"repos.import",
	"issues.list",
	"issues.view",
	"issues.create",
	"issues.comment",
	"issues.close",
	"issues.reopen",
	"prs.list",
	"prs.view",
	"prs.create",
	"prs.review",
	"prs.land",
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
	"toast.dismiss",
];

/** The order the safe-to-smoke invocations run in on the signed-out client. */
const SAFE_ORDER: ReadonlyArray<string> = [
	"flows",
	"connect",
	"world",
	"chat",
	"surfaces",
	"dark-mode",
	"theme",
	"retry",
	"chat.stop",
	"stop",
	"card.minimize",
	"copy-message",
	"connector.add",
	"connector.downgrade",
	"connector.remove",
	"world.new-note",
	"auth.prompt",
];

/** The order the admin-only invocations run in. Order is load-bearing; see each entry's reason. */
const ADMIN_ORDER: ReadonlyArray<string> = [
	"admin.devtools",
	"debug.snapshot",
	"debug.events",
	"debug.chain",
	"debug.net",
	"debug.seams",
	"admin.allowlist.add",
	"admin.allowlist.remove",
	"admin.grant",
	"admin.grant.confirm",
	"admin.grant.cancel",
	"admin.requests",
	"admin.queue.approve",
	"admin.feedback",
	"admin.health",
	"debug.backend",
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const namesIn = (klass: SmokeClass): ReadonlyArray<string> =>
	Object.entries(SMOKE_TABLE)
		.filter(([, entry]) => entry.klass === klass)
		.map(([name]) => name);

/** A promise that fails the suite rather than hanging the runner. A hung flow is a product defect. */
const within = async <T>(what: string, ms: number, work: Promise<T>): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new SuiteFailure(`${what} never settled within ${ms}ms`)), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};

/*
 * What every invocation must satisfy, whatever it does.
 *
 * `unknown-command` means the flow left the registry while the table still
 * claims it. A failure carrying an empty string, an interpolated `undefined`,
 * a stringified object, a stack frame, or FlowBinding's own "Flow x failed:"
 * frame is a refusal a human cannot act on — the frame in particular is what
 * Commands.ts `unframe` exists to strip.
 */
const honest = (report: Reporter, name: string, outcome: CommandOutcome): void => {
	if (outcome.status === "unknown-command") {
		report.fail(`/${name} is classified in SMOKE_TABLE but the registry answered unknown-command`);
		return;
	}
	if (outcome.status !== "failed") return;
	const error = outcome.error;
	report.check(error.trim() !== "", `/${name} failed with an empty message`);
	report.excludes(error, "undefined", `/${name} interpolated an undefined into its refusal`);
	report.excludes(error, "[object Object]", `/${name} stringified an object into its refusal`);
	report.check(!/\bat \w+ \(/.test(error), `/${name} leaked a stack frame into its refusal: ${error.slice(0, 200)}`);
	report.check(
		!error.startsWith(`Flow ${name} failed:`),
		`/${name} leaked FlowBinding's cell frame into a human-facing refusal: ${error.slice(0, 200)}`,
	);
};

/**
 * The highest revision the app has journaled. Every dispatch appends exactly one
 * transition row carrying the next revision, so the rows above this watermark
 * after an invocation are what that invocation did.
 */
const journalHead = (client: Client): number => {
	let high = 0;
	for (const row of client.store.collections.transitions.values()) high = Math.max(high, row.revision);
	return high;
};

/** The transition types journaled since `revision`, oldest first. */
const journalSince = (client: Client, revision: number): ReadonlyArray<string> =>
	[...client.store.collections.transitions.values()]
		.filter((row) => row.revision > revision)
		.sort((left, right) => left.revision - right.revision)
		.map((row) => row.type);

/**
 * Which effect class a journaled transition belongs to.
 *
 * `command.ran` is the row EVERY visible user-invoked flow writes just by being
 * invoked (AppController `noteCommandRun`, the slash menu's recency signal), so
 * it is not evidence that the flow did anything and is excluded. Everything
 * else is a real change to app state.
 */
const effectOfTransition = (type: string): Effect | undefined => {
	if (type === "command.ran") return undefined;
	if (type.startsWith("message.")) return "message";
	if (type.startsWith("card.")) return "card";
	if (type.startsWith("toast.")) return "toast";
	return "state";
};

/**
 * What one invocation observably did.
 *
 * Read from the outcome and from the journal rows the invocation appended.
 * Background pollers (the workflow run pump, the balance refresh) journal on
 * their own timers and can land inside this window, so the reading errs
 * GENEROUS: it can credit a flow with a neighbour's transition, it cannot
 * invent an `answer` or a `refusal`, and it never fails a flow that did work.
 */
const observedEffects = (client: Client, since: number, outcome: CommandOutcome): ReadonlySet<Effect> => {
	const seen = new Set<Effect>();
	if (outcome.status === "executed" && (outcome.value ?? "").trim() !== "") seen.add("answer");
	if (outcome.status === "failed") seen.add("refusal");
	for (const type of journalSince(client, since)) {
		const effect = effectOfTransition(type);
		if (effect !== undefined) seen.add(effect);
	}
	return seen;
};

/*
 * E5.7's floor, and what it is worth.
 *
 * `honest` above is a refusal-shape contract: it says nothing about whether the
 * flow DID anything. This is the other half. Every entry declares the effect
 * classes its invocation may produce, and at least one of them must actually be
 * observed, so a flow that returns `executed` while journaling nothing and
 * answering nothing fails here instead of passing as a smoke.
 *
 * What the floor proves: every one of the 83 invoked flows either changed app
 * state, wrote to the transcript, answered its caller, or refused with a reason.
 * None of them is a silent no-op except the six that declare `silent` and say
 * which state makes them one.
 *
 * What the floor still does NOT prove: that the effect is the RIGHT one. Only
 * `proves` does that, and it is written for the entries where the effect has a
 * shape worth pinning. A flow that upserts the wrong card, or refuses for the
 * wrong reason, satisfies the floor.
 */
const floor = (
	report: Reporter,
	name: string,
	entry: SmokeEntry,
	outcome: CommandOutcome,
	seen: ReadonlySet<Effect>,
): void => {
	if (entry.refusal !== undefined) {
		if (outcome.status !== "failed") {
			report.fail(
				`/${name} is pinned to the refusal ${JSON.stringify(entry.refusal)} but answered ${outcome.status}: whatever made it refuse is gone, so re-state what this entry now proves`,
			);
		} else {
			report.includes(outcome.error, entry.refusal, `/${name} refused, but not for the reason this entry claims`);
		}
	}
	const declared = entry.effect ?? [];
	if (declared.length === 0) {
		report.fail(`/${name} declares no effect class, so nothing checks that invoking it did anything`);
		return;
	}
	if (declared.includes("silent")) {
		report.equals(declared.length, 1, `/${name} declares "silent" alongside another effect class`);
		/*
		 * A declared no-op is pinned to being EXACTLY that. Refusing is not
		 * silence, and neither is journaling a transition nobody wrote down: a
		 * flow that starts doing something has to say so here before it passes.
		 */
		report.equals(
			[...seen].join(", "),
			"",
			`/${name} is declared silent but did something; state the effect class it now produces`,
		);
		return;
	}
	report.check(
		declared.some((effect) => seen.has(effect)),
		`/${name} produced no ${declared.join(" or ")}: invoking it changed nothing, wrote nothing and answered nothing (observed: ${[...seen].join(", ") || "nothing"})`,
	);
};

interface Walk {
	readonly client: Client;
	readonly report: Reporter;
	readonly fixtures: Fixtures;
	readonly invoked: Set<string>;
}

/** Invoke one classified flow through the one door, and hold it to the contract. */
const smoke = async (walk: Walk, name: string): Promise<void> => {
	const entry = SMOKE_TABLE[name];
	if (entry === undefined) walk.report.fail(`${name} is not in SMOKE_TABLE`);
	const args = typeof entry.args === "function" ? entry.args(walk.fixtures) : entry.args;
	/*
	 * The catalog shows this argument hint to the human and teaches it to the
	 * model, so a grammar that stopped parsing its own hint is a product
	 * defect. `runAs` would swallow it as an honest refusal, which is why the
	 * parse is asserted here rather than inferred from the outcome.
	 */
	const parsed = payloadFor(name, args);
	if ("error" in parsed) {
		walk.report.fail(`/${name} ${args ?? ""} no longer parses through payloadFor: ${parsed.error}`);
	}
	const since = journalHead(walk.client);
	const outcome = await within(`/${name}`, 40_000, walk.client.controller.commands.run(name, args));
	walk.invoked.add(name);
	honest(walk.report, name, outcome);
	floor(walk.report, name, entry, outcome, observedEffects(walk.client, since, outcome));
	await entry.proves?.({ name, outcome, client: walk.client, report: walk.report, fixtures: walk.fixtures });
};

/** Raw CDP key presses for the keys Browser.ts does not name. */
const pressKey = async (session: CdpSession, key: string, code: string, keyCode: number): Promise<void> => {
	for (const type of ["keyDown", "keyUp"]) {
		await session.send("Input.dispatchKeyEvent", {
			type,
			key,
			code,
			windowsVirtualKeyCode: keyCode,
			nativeVirtualKeyCode: keyCode,
		});
	}
};

interface UnnamedShape {
	readonly label: string;
	readonly tag: string;
	/** A <summary> whose parent is a <details>: native disclosure, not a command. */
	readonly nativeDisclosure: boolean;
}

/*
 * The affordances carrying no flow name, with enough of their shape to tell a
 * command from a native disclosure.
 *
 * The selector and the visibility rule are VISIBLE_AFFORDANCES' own (Probes.ts),
 * so this reads the same population that produced `unnamed` — it only adds the
 * two facts E5.1's fourth pin claims and could otherwise only assert in prose.
 */
const UNNAMED_SHAPES = `(() => {
	const selector = "button, [role=button], a[href], summary";
	const visible = (element) => {
		const rect = element.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) return false;
		const style = window.getComputedStyle(element);
		return style.visibility !== "hidden" && style.display !== "none";
	};
	const flowOf = (element) =>
		element.getAttribute("data-flow") ?? element.closest("[data-flow]")?.getAttribute("data-flow") ?? null;
	return Array.from(document.querySelectorAll(selector))
		.filter(visible)
		.filter((element) => flowOf(element) === null)
		.map((element) => ({
			label: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 60),
			tag: element.tagName.toLowerCase(),
			nativeDisclosure:
				element.tagName.toLowerCase() === "summary" &&
				(element.parentElement?.tagName.toLowerCase() ?? "") === "details",
		}));
})()`;

interface SlashOption {
	readonly name: string;
	readonly gold: string | null;
	readonly selected: string | null;
	readonly flow: string | null;
}

/** The rendered slash menu, as the user sees it. */
const SLASH_OPTIONS = `Array.from(document.querySelectorAll(".slash-menu [role='option']")).map((element) => ({
	name: (element.querySelector(".slash-menu-name") ?? { textContent: "" }).textContent.trim(),
	gold: element.getAttribute("data-gold"),
	selected: element.getAttribute("aria-selected"),
	flow: element.getAttribute("data-flow"),
}))`;

/* ------------------------------------------------------------------ */
/* The suite                                                           */
/* ------------------------------------------------------------------ */

export default defineSuite({
	id: "E5",
	title: "the flow registry: every command smokes, slash dispatch names what you typed, and /clear keeps before it clears",
	// It flips the identity double to admin and mutates the platform double's
	// issues, keys, notifications and environment, so it runs after the suites
	// that read those.
	order: 90,
	run: async ({ origin, stack, report, browser }) => {
		const invoked = new Set<string>();

		/* ---------------------------------------------------------- */
		/* E5.7 — the coverage gate                                    */
		/* ---------------------------------------------------------- */

		const gateClient = await openClient({ origin });
		/*
		 * The admin plugin registers only for a session that validates as
		 * admin. Dispatching the session locally is enough to see the whole
		 * catalog; the admin INVOCATIONS later need the identity double flipped
		 * too, because the Worker gates the admin routes on its own.
		 */
		gateClient.store.dispatch({
			type: "identity.session.loaded",
			actor: "system",
			state: "signed-in",
			login: "will",
			allowlisted: true,
			admin: true,
			scopesPlain: null,
		});
		const registry = gateClient.controller.commands.all();
		const registered = [...registry.map((command) => command.name)].sort();
		const classified = Object.keys(SMOKE_TABLE).sort();
		const missing = registered.filter((name) => !classified.includes(name));
		const stale = classified.filter((name) => !registered.includes(name));
		report.check(
			missing.length === 0,
			`these registered flows carry no SMOKE_TABLE entry, so nothing smokes them: ${missing.join(", ")}`,
		);
		report.check(
			stale.length === 0,
			`these SMOKE_TABLE entries name flows the registry no longer has: ${stale.join(", ")}`,
		);
		report.equals(registered.length, 88, "the registry no longer declares 88 flows for an admin session");
		report.ok(`every one of the ${registered.length} registered flows is classified, and nothing is classified twice.`);

		const counts: Record<string, number> = {};
		for (const entry of Object.values(SMOKE_TABLE)) counts[entry.klass] = (counts[entry.klass] ?? 0) + 1;
		report.equals(
			`${counts["safe-to-smoke"]}/${counts["needs-fixture"]}/${counts["destructive-skip"]}/${counts["admin-only"]}`,
			"17/50/5/16",
			"the smoke classification counts changed",
		);

		const byName = new Map(registry.map((command) => [command.name, command]));
		for (const [name, entry] of Object.entries(SMOKE_TABLE)) {
			report.check(entry.reason.trim() !== "", `${name} carries no reason for its classification`);
			if (entry.klass === "needs-fixture" || entry.klass === "admin-only") {
				report.check((entry.fixture ?? "").trim() !== "", `${name} is ${entry.klass} but names no fixture`);
			}
			/*
			 * The floor is only a floor if a newly added flow cannot slip under
			 * it. An invoked entry must declare what its invocation produces; a
			 * destructive-skip entry must not, because nothing will ever observe
			 * it and a declaration there would read as coverage that does not
			 * exist.
			 */
			if (entry.klass === "destructive-skip") {
				report.equals(
					entry.effect,
					undefined,
					`${name} is destructive-skip but declares an effect class no invocation will ever observe`,
				);
			} else {
				report.check(
					(entry.effect ?? []).length > 0,
					`${name} declares no effect class, so its invocation would be held to nothing but the shape of a refusal`,
				);
			}
			if (entry.refusal !== undefined) {
				report.equals(
					(entry.effect ?? []).includes("refusal") || (entry.proves ?? null) !== null,
					true,
					`${name} pins a refusal but neither declares the refusal effect nor proves anything else`,
				);
			}
			const command = byName.get(name);
			if (command === undefined) continue;
			/*
			 * An argument the catalog does not advertise cannot be typed:
			 * parseSubmit sends "/name text" to the agent as a prompt when the
			 * flow declares no args hint.
			 */
			if (entry.args !== undefined) {
				report.check(
					command.args !== undefined,
					`${name} is smoked with arguments but its catalog entry advertises no args hint, so /${name} <text> is a prompt`,
				);
			}
			// Every registered name must still be typeable as a slash flow.
			const submit = parseSubmit(`/${name}`, registry);
			report.equals(submit.kind, "command", `/${name} no longer parses as a flow invocation`);
			report.equals(
				submit.kind === "command" ? submit.name : "",
				name,
				`/${name} parsed as a different flow`,
			);
		}
		report.ok("every entry states a reason, every fixture class names its fixture, and every registered name is typeable as /name.");

		/*
		 * What E5.7's floor is, stated where a reader of the output can see it.
		 * `silent` is the floor's weakest point and the only class that asserts
		 * an absence, so the set is pinned by name: a seventh silent flow has to
		 * be argued for in this file before it passes.
		 */
		const silent = Object.entries(SMOKE_TABLE)
			.filter(([, entry]) => (entry.effect ?? []).includes("silent"))
			.map(([name]) => name);
		report.equals(
			silent.sort().join(", "),
			"chat.stop, connector.downgrade, connector.remove, copy-message, retry, stop",
			"the set of flows allowed to do nothing changed",
		);
		const pinnedRefusals = Object.entries(SMOKE_TABLE).filter(([, entry]) => entry.refusal !== undefined).length;
		report.ok(
			`E5.7's floor: each of the ${registered.length - namesIn("destructive-skip").length} invoked flows declares the effect class it must produce, ${pinnedRefusals} pin the exact wording of the refusal they answer with, and the ${silent.length} that do nothing say which state makes them a no-op.`,
		);

		/* ---------------------------------------------------------- */
		/* E5.3 — a typed name leads its own listing                   */
		/* ---------------------------------------------------------- */

		report.equals(
			gateClient.controller
				.slashItems("flows")
				.map((item) => item.flow.name)
				.join(","),
			"flows,flow.list",
			'/flows must lead with flows; flow.list matches only because its summary says "workflows"',
		);
		const inversions: Array<string> = [];
		for (const command of registry.filter((entry) => entry.hidden !== true)) {
			const leader = gateClient.controller.slashItems(command.name)[0]?.flow.name;
			if (leader !== command.name) inversions.push(`/${command.name} listed ${leader ?? "nothing"} first`);
		}
		report.check(
			inversions.length === 0,
			`a fully typed name did not lead its own listing: ${inversions.join(" | ")}`,
		);
		for (const needle of ["flows", "FLOWS", "  flows  ", "Flows"]) {
			report.equals(
				gateClient.controller.slashItems(needle)[0]?.flow.name,
				"flows",
				`/${needle} did not lead with flows`,
			);
		}
		report.ok(
			`a fully typed name leads its own listing for all ${registry.filter((entry) => entry.hidden !== true).length} visible flows, in any case and with surrounding space.`,
		);

		/* ---------------------------------------------------------- */
		/* E5.7 — safe-to-smoke, on a signed-out client                */
		/* ---------------------------------------------------------- */

		const safeClient = await openClient({ origin });
		await safeClient.controller.loadSession();
		const emptyFixtures: Fixtures = {
			cardId: "",
			approvalCardId: "",
			runCardId: "",
			documentId: "",
			toastId: "",
			grantCardId: "",
		};
		const safeWalk: Walk = { client: safeClient, report, fixtures: emptyFixtures, invoked };
		report.equals(
			[...SAFE_ORDER].sort().join(","),
			[...namesIn("safe-to-smoke")].sort().join(","),
			"SAFE_ORDER and the safe-to-smoke class disagree",
		);
		/*
		 * The starting point every toggle assertion below is measured against.
		 * Pinned here rather than assumed: a session that already booted dark,
		 * or already on the world surface, would let /dark-mode and /world pass
		 * while doing nothing at all.
		 */
		const start = safeClient.store.session();
		report.equals(start.theme, "light", "the client booted dark, so /dark-mode would prove nothing");
		report.equals(start.palette, "night-owl", "the client did not boot on the default palette, so /theme would prove nothing");
		report.equals(start.surface, "chat", "the client did not boot on the chat surface");
		report.equals(start.surfacesMenuOpen, false, "the client booted with the surfaces menu already open");
		for (const name of SAFE_ORDER) await smoke(safeWalk, name);
		/*
		 * No safe-to-smoke flow declares a requirement, so none of them may
		 * park an invocation behind sign-in. A flow that started declaring one
		 * would silently defer here instead of running.
		 */
		report.equals(
			safeClient.store.session().pendingCommand ?? null,
			null,
			"a safe-to-smoke flow parked an invocation behind a requirement",
		);
		report.ok(`all ${SAFE_ORDER.length} safe-to-smoke flows ran on a signed-out client with an honest outcome and no deferral.`);

		/* ---------------------------------------------------------- */
		/* E5.7 — needs-fixture, on a signed-in allowlisted client      */
		/* ---------------------------------------------------------- */

		const cookie = await stack.signedInCookie();
		await stack.control("gateway", "/stub/import-ready", { method: "POST" });
		const client = await openClient({ origin, cookie });
		await client.controller.loadSession();
		report.equals(
			client.store.collections.identitySessions.get("identity")?.state,
			"signed-in",
			"the signed-in client never recorded its session",
		);

		// Fixtures the walk substitutes. Each is built through a real controller
		// act, never by reaching around the store.
		client.controller.createWorldDocument();
		const documentId = client.worldDocuments()[0]?.id ?? "";
		report.check(documentId !== "", "the world-note fixture was never created");
		const approvalCardId = "approval-smoke-1";
		client.store.dispatch({
			type: "card.upsert",
			actor: "user",
			card: {
				id: approvalCardId,
				kind: "approval",
				title: "A smoke approval",
				status: "active",
				createdAt: Date.now(),
				ordinal: 900,
				// No runId/nodeId/iteration on purpose: the honest "not linked to
				// a run" answer is the path worth smoking.
				payload: { capability: "session:net-write", detail: "May the smoke proceed?" },
			},
		});
		const fixtures: Fixtures = {
			cardId: approvalCardId,
			approvalCardId,
			runCardId: approvalCardId,
			documentId,
			toastId: "toast-that-does-not-exist",
			grantCardId: "",
		};
		const walk: Walk = { client, report, fixtures, invoked };
		// Same discipline as the safe walk: without an unmade selection,
		// /repos.watch.confirm would satisfy a requirement that was never unmet.
		report.equals(
			client.controller.commands.state().needsSelection,
			true,
			"the signed-in client already carried a watched selection, so the chooser walk would prove nothing",
		);
		report.equals(client.store.session().maximizedCardId, null, "a card was already maximized before /card.maximize ran");
		report.equals(
			[...FIXTURE_ORDER, "send", "clear"].sort().join(","),
			[...namesIn("needs-fixture")].sort().join(","),
			"FIXTURE_ORDER (plus the two flows with their own clients) and the needs-fixture class disagree",
		);
		for (const name of FIXTURE_ORDER) {
			if (name === "flow.run.retry") {
				// Whatever flow.create/flow.run rendered is the run card; fall back
				// to the approval card so the id is always real.
				const runCard = client.cards().find((card) => card.kind !== "approval" && card.kind !== "repo-chooser");
				fixtures.runCardId = runCard?.id ?? approvalCardId;
				fixtures.cardId = runCard?.id ?? approvalCardId;
			}
			if (name === "toast.dismiss") {
				/*
				 * Raise a real toast first. Nothing above this line leaves one on
				 * screen: `commands.run` returns the refusal to its caller, and
				 * only the pointer path (`runCommand` → `surfaceCommandFailure`)
				 * turns a refusal into a toast. Dismissing an id no toast ever
				 * carried is how this invocation used to pass while doing nothing.
				 */
				client.controller.runCommand("reco.dismiss");
				await client.settle(
					"a refused button invocation raised no toast, so /toast.dismiss has nothing to dismiss",
					() => client.store.collections.toasts.size > 0,
					10_000,
				);
				const toast = [...client.store.collections.toasts.values()][0];
				report.check(toast !== undefined, "the toast fixture was never raised");
				fixtures.toastId = toast?.id ?? "toast-that-does-not-exist";
			}
			await smoke(walk, name);
		}
		report.ok(`all ${FIXTURE_ORDER.length} fixture-backed flows ran against the doubles with an honest outcome.`);

		/*
		 * An honest outcome is not the same as a wired seam: a flow whose seam
		 * never left the browser would answer honestly too. The platform double
		 * records every call the Worker forwarded with the credential it arrived
		 * under, so this is where the issues, PR, keys, notifications, env,
		 * branches and files invocations above stop being "it did not throw".
		 */
		const platform = await report.json<{ calls?: ReadonlyArray<{ method: string; path: string; authorization: string }> }>(
			await stack.control("gateway", "/stub/platform-calls"),
			200,
			"the platform-calls control",
		);
		const calls = platform.calls ?? [];
		report.check(calls.length > 0, "the smoke reached the platform proxy zero times, so those flows proved nothing");
		const unauthenticated = calls.filter((call) => call.authorization.trim() === "");
		report.equals(
			unauthenticated.length,
			0,
			`the Worker forwarded ${unauthenticated.length} platform call(s) with no credential: ${unauthenticated
				.map((call) => call.path)
				.join(", ")}`,
		);
		const families = new Set(calls.map((call) => `/${call.path.split("/")[2] ?? ""}`));
		report.check(
			families.size >= 3,
			`the smoke exercised only ${families.size} platform famil(ies): ${[...families].join(", ")}`,
		);
		report.ok(`the fixture walk reached the platform proxy ${calls.length} time(s) across ${families.size} families, every call carrying a minted credential.`);

		const sendClient = await openClient({ origin, cookie });
		await sendClient.controller.loadSession();
		await smoke({ client: sendClient, report, fixtures, invoked }, "send");
		report.ok("/send drove a whole turn through the Worker on its own client.");

		/* ---------------------------------------------------------- */
		/* E5.8 — /clear keeps before it clears                        */
		/* ---------------------------------------------------------- */

		const sweepClient = await openClient({ origin, cookie });
		await sweepClient.controller.loadSession();
		sweepClient.controller.send("remember that I prefer dark mode");
		await sweepClient.idle(30_000);
		const beforeClear = sweepClient.messages();
		report.check(beforeClear.length > 0, "the sweep client never built a transcript to clear");

		stack.chat.script({
			frames: [
				{
					type: "delta",
					kind: "text",
					text: '{"notes":[{"title":"Prefers dark mode","body":"Will prefers dark mode.","confidence":0.9}]}',
				},
				{ type: "done", reason: "stop" },
			],
		});
		await smoke({ client: sweepClient, report, fixtures, invoked }, "clear");

		const kept = sweepClient.worldDocuments().filter((document) => document.sources.includes("chat-sweep"));
		report.equals(kept.length, 1, "the sweep kept a different number of world notes than the model named");
		report.equals(kept[0]?.title, "Prefers dark mode", "the kept note carries the wrong title");
		report.equals(kept[0]?.path, "Prefers dark mode.md", "the kept note was filed under the wrong path");
		report.equals(kept[0]?.updatedBy, "smithers", "the kept note was not attributed to Smithers");
		const journal = [...sweepClient.store.collections.transitions.values()].sort(
			(left, right) => left.revision - right.revision,
		);
		const upsertAt = journal.find((row) => row.type === "world.document.upserted")?.revision;
		const clearedAt = journal.find((row) => row.type === "conversation.cleared")?.revision;
		report.check(upsertAt !== undefined, "no world.document.upserted transition was journaled by the sweep");
		report.check(clearedAt !== undefined, "no conversation.cleared transition was journaled");
		report.check(
			upsertAt !== undefined && clearedAt !== undefined && upsertAt < clearedAt,
			`the note was kept at revision ${String(upsertAt)} and the chat cleared at ${String(clearedAt)}: the keep must precede the clear`,
		);
		const afterClear = sweepClient.messages();
		report.equals(afterClear.length, 1, "the cleared transcript is not a single line");
		report.equals(afterClear[0]?.text, "Saved 1 note to World. Cleared.", "the cleared transcript says the wrong thing");
		report.equals(sweepClient.cards().length, 0, "the clear left cards behind");
		report.ok("/clear swept one note into World, journaled the keep BEFORE the clear, and left one calm line.");

		/*
		 * The other half. Each injection is a different way runSweep answers
		 * `undefined`, and each must leave the transcript exactly as it was —
		 * proved by id, because a count alone cannot tell "kept everything and
		 * added a line" from "cleared and re-seeded".
		 */
		const injections: ReadonlyArray<{ readonly what: string; readonly script: Parameters<typeof stack.chat.script>[0] }> = [
			{ what: "an HTTP 500 from the chat upstream", script: { frames: [], status: 500, body: "chat upstream down" } },
			{
				what: "a 200 whose answer carries no JSON at all",
				script: {
					frames: [
						{ type: "delta", kind: "text", text: "I had a look and there is nothing to keep." },
						{ type: "done", reason: "stop" },
					],
				},
			},
			{
				what: "a 200 whose notes field is not an array",
				script: {
					frames: [
						{ type: "delta", kind: "text", text: '{"notes":"everything"}' },
						{ type: "done", reason: "stop" },
					],
				},
			},
		];
		for (const injection of injections) {
			const failClient = await openClient({ origin, cookie });
			await failClient.controller.loadSession();
			stack.chat.reset();
			failClient.controller.send("some conversation worth keeping");
			await failClient.idle(30_000);
			const before = failClient.messages();
			const beforeWorld = failClient.worldDocuments().length;
			const beforeCards = failClient.cards().length;
			report.check(before.length > 0, `the ${injection.what} client never built a transcript`);

			stack.chat.script(injection.script);
			const outcome = await within("/clear", 40_000, failClient.controller.commands.run("clear"));
			honest(report, "clear", outcome);

			const after = failClient.messages();
			for (const message of before) {
				report.check(
					after.some((survivor) => survivor.id === message.id),
					`${injection.what}: /clear dropped message ${message.id}, so a failed sweep lost the conversation`,
				);
			}
			report.equals(after.length, before.length + 1, `${injection.what}: /clear added more than the one honest line`);
			report.check(
				after.some((message) => message.text.includes("left it exactly as it was")),
				`${injection.what}: /clear never said it left the conversation alone`,
			);
			report.equals(failClient.worldDocuments().length, beforeWorld, `${injection.what}: a failed sweep still wrote a world note`);
			report.equals(failClient.cards().length, beforeCards, `${injection.what}: a failed sweep still swept the cards`);
			const rows = [...failClient.store.collections.transitions.values()];
			report.check(
				!rows.some((row) => row.type === "conversation.cleared"),
				`${injection.what}: the conversation was cleared despite the failed sweep`,
			);
			report.check(
				!rows.some((row) => row.type === "world.document.upserted"),
				`${injection.what}: a world note was written despite the failed sweep`,
			);
		}
		report.ok("a failed sweep clears NOTHING: all three failure shapes kept every message by id, every card, and every note.");

		// Signed out there is nothing to review, so no turn is spent reviewing it.
		const anonymous = await openClient({ origin });
		await anonymous.controller.loadSession();
		const anonymousOutcome = await within("/clear", 20_000, anonymous.controller.commands.run("clear"));
		honest(report, "clear", anonymousOutcome);
		report.equals(anonymous.countCalls("POST", "/api/agent/turn"), 0, "a signed-out /clear spent a turn reviewing an empty conversation");
		report.equals(
			anonymous.messages().map((message) => message.text).join("|"),
			"Cleared — there was nothing new worth keeping.",
			"a signed-out /clear did not say plainly that nothing was kept",
		);
		report.ok("a signed-out /clear clears immediately and spends no turn on a conversation it cannot sweep.");
		stack.chat.reset();

		/* ---------------------------------------------------------- */
		/* E5.1 / E5.2 / E5.3 / E5.4 — at the keyboard                 */
		/* ---------------------------------------------------------- */

		let session: CdpSession | undefined;
		try {
			session = await browser.open(cookie);
		} catch (error) {
			if (!(error instanceof BrowserUnavailableError)) throw error;
			console.log(`skip: E5 — E5.1/E5.2/E5.4 need a headless page: ${error.message}`);
		}

		if (session !== undefined) {
			const page = session.page;
			await waitUntil(
				report,
				"the app shell never published its [data-flows] registry manifest",
				async () => (await page.evaluate<ReadonlyArray<string>>(REGISTERED_COMMANDS)).length > 0,
				30_000,
			);

			// E5.1 — the manifest IS the registry, and every visible affordance names one of its flows.
			const manifest = await page.evaluate<ReadonlyArray<string>>(REGISTERED_COMMANDS);
			const pageClient = await openClient({ origin, cookie });
			await pageClient.controller.loadSession();
			report.equals(
				manifest.join(" "),
				pageClient.controller.commands.all().map((command) => command.name).join(" "),
				"the rendered [data-flows] manifest is not the registry the controller reports",
			);
			/*
			 * The balance chip only renders once GET /api/billing/balance has
			 * landed. Read the affordances before it does and the corner chrome
			 * is simply absent, which is how a count-based tolerance drifts
			 * between runs. Wait for it, so what follows measures one settled
			 * page rather than whichever half of it had arrived.
			 */
			await waitUntil(
				report,
				"the balance chip never rendered, so the affordance read would measure half a page",
				async () => (await page.evaluate<number>(`document.querySelectorAll(".corner-balance-chip").length`)) === 1,
				30_000,
			);
			const affordances = await page.evaluate<ReadonlyArray<Affordance>>(VISIBLE_AFFORDANCES);
			report.check(affordances.length > 0, "the signed-in page rendered no interactive affordances at all");
			const unnamed = unnamedAffordances(affordances, manifest);
			const unnamedShapes = await page.evaluate<ReadonlyArray<UnnamedShape>>(UNNAMED_SHAPES);

			/*
			 * E5.1 reads: every visible interactive affordance resolves to a
			 * named command also reachable by /name. It is NOT closed. Three
			 * affordances carry no data-flow, and each pin below names the flow
			 * its handler already calls — `runs: null` meaning it calls none and
			 * is therefore not a command at all. (The corner theme button was a
			 * fourth until it took data-flow="dark-mode"; nothing about it is
			 * tolerated here any more.)
			 *
			 * The pins cannot rot in either direction:
			 *  - a FIFTH unnamed affordance fails (`unexpected`);
			 *  - a pinned affordance that starts carrying a data-flow must carry
			 *    the flow its handler already calls, not some other name;
			 *  - a pin whose gap is closed FAILS and has to be deleted, which is
			 *    how the theme button left this list;
			 *  - `runs` is resolved against the live registry, so a pin naming a
			 *    flow the registry does not carry fails too — which is what makes
			 *    "the fix is one attribute" a checked claim rather than a hope;
			 *  - `runs: null` is checked structurally in the page, not asserted
			 *    in a comment.
			 */
			interface UnnamedPin {
				/** The affordance's accessible name, as VISIBLE_AFFORDANCES reads it. */
				readonly label: string;
				/** The flow its handler already calls, or null when it calls none. */
				readonly runs: string | null;
				/** Why it is or is not an affordance E5.1 covers, and what closing it takes. */
				readonly why: string;
			}
			const KNOWN_UNNAMED: ReadonlyArray<UnnamedPin> = [
				{
					label: "Show your balance",
					runs: "billing.balance",
					why: "App.tsx's corner chip calls controller.runCommand(\"billing.balance\") on click, so it is a command affordance missing only data-flow=\"billing.balance\".",
				},
				{
					label: "Send message",
					runs: "send",
					why: "@smthrs/ui's ChatComposer submit button. The label is that component's own `submitLabel` default, which App.tsx does not override, so it is the one pinned label that greps to node_modules rather than to src. Its onSubmit calls controller.runCommandArgs(\"send\", text). ChatComposer spreads unknown props onto its <form>, so App.tsx can bind it with data-flow=\"send\" on the composer, but Probes' TABBABLE_FLOWS reads data-flow off the element itself and would then report send as pointer-only, so that probe needs the same closest() fallback VISIBLE_AFFORDANCES already has.",
				},
				{
					label: "The read behind this",
					runs: null,
					why: "ChatCards' reco evidence <summary>: a native <details> disclosure of text already in the card. It runs no handler and changes no app state, so there is no command for /name to reach. It appears here only because VISIBLE_AFFORDANCES lists summary in its selector.",
				},
			];
			const unexpected = unnamed.filter(
				(entry) => !KNOWN_UNNAMED.some((pin) => entry.startsWith(`${pin.label} →`)),
			);
			report.equals(
				unexpected.length,
				0,
				`visible affordances resolving to no registered flow, beyond the ${KNOWN_UNNAMED.length} E5.1 already knows about: ${unexpected.join(" | ")}`,
			);
			const pageRegistry = pageClient.controller.commands.all();
			for (const pin of KNOWN_UNNAMED) {
				report.check(pin.why.trim() !== "", `the "${pin.label}" pin states no reason`);
				if (pin.runs !== null) {
					// "One attribute away" holds only if the flow exists and is typeable.
					const submit = parseSubmit(`/${pin.runs}`, pageRegistry);
					report.equals(
						submit.kind === "command" ? submit.name : `(${submit.kind})`,
						pin.runs,
						`the "${pin.label}" pin says it runs /${pin.runs}, which is not a flow the registry carries`,
					);
				}
				const affordance = affordances.find((entry) => entry.label === pin.label);
				if (affordance === undefined) continue;
				if (affordance.flow !== null) {
					report.equals(
						affordance.flow,
						pin.runs,
						`"${pin.label}" now carries data-flow="${affordance.flow}", which is not the flow its handler calls`,
					);
					report.fail(
						`"${pin.label}" carries data-flow="${affordance.flow}" now, so its E5.1 gap is closed: delete its KNOWN_UNNAMED pin`,
					);
					continue;
				}
				const shape = unnamedShapes.find((entry) => entry.label === pin.label);
				report.check(shape !== undefined, `"${pin.label}" is unnamed but the shape probe never saw it`);
				if (pin.runs === null) {
					// The "it is not a command" claim, checked in the page.
					report.equals(
						`${shape?.tag ?? "(missing)"}/${String(shape?.nativeDisclosure ?? false)}`,
						"summary/true",
						`"${pin.label}" is pinned as a native disclosure rather than a command, but the page says otherwise`,
					);
				}
			}
			const namedFlows = [...new Set(affordances.map((affordance) => affordance.flow).filter((flow): flow is string => flow !== null))];
			report.check(namedFlows.length > 0, "no visible affordance carries a data-flow, so none is reachable by /name");
			for (const flow of namedFlows) {
				const submit = parseSubmit(`/${flow}`, pageRegistry);
				report.equals(
					submit.kind === "command" ? submit.name : `(${submit.kind})`,
					flow,
					`the affordance bound to ${flow} is not reachable by typing /${flow}`,
				);
			}
			report.ok(
				`E5.1: ${affordances.length - unnamed.length} of ${affordances.length} visible affordance(s) resolve to one of the ${manifest.length} registered flows and each of the ${namedFlows.length} named flows is reachable by /name. Still open, each pinned with the flow it already calls: ${unnamed.join(" | ") || "nothing"}.`,
			);

			/*
			 * E5.4 — the composer is reachable by Tab alone. Focus is dropped to
			 * the document first: the composer autofocuses on mount, and a test
			 * that starts there proves nothing about the tab ring.
			 */
			await page.evaluate<boolean>(`(() => {
				document.activeElement?.blur?.();
				return document.activeElement === document.body;
			})()`);
			report.equals(
				await page.evaluate<boolean>(`document.activeElement?.tagName === "TEXTAREA"`),
				false,
				"focus could not be moved off the composer, so the Tab walk would prove nothing",
			);
			let tabs = 0;
			let onComposer = await page.evaluate<boolean>(`document.activeElement?.tagName === "TEXTAREA"`);
			while (!onComposer && tabs < 40) {
				await page.press("Tab");
				tabs += 1;
				onComposer = await page.evaluate<boolean>(`document.activeElement?.tagName === "TEXTAREA"`);
			}
			report.check(onComposer, `the composer never took focus after ${tabs} Tab presses, so the journey is not keyboard-only`);

			// E5.4 — a whole turn, typed and submitted with no pointer.
			await page.type("what can you do?");
			await page.press("Enter");
			await waitUntil(
				report,
				"the keyboard-submitted prompt never produced a reply in the transcript",
				async () => hasSmithersMessage(await page.text()),
				60_000,
			);
			const transcript = await page.text();
			report.includes(transcript, "what can you do?", "the keyboard-submitted prompt never appeared in the transcript");
			report.ok(`E5.4: Tab reached the composer in ${tabs} press(es) and Enter submitted a whole turn with no pointer.`);

			// E5.4 — the slash menu is driven entirely from the keyboard.
			await page.evaluate(FOCUS_COMPOSER);
			await page.type("/");
			await waitUntil(
				report,
				'typing "/" never opened the slash menu',
				async () => (await page.evaluate<ReadonlyArray<SlashOption>>(SLASH_OPTIONS)).length > 0,
				10_000,
			);
			const opened = await page.evaluate<ReadonlyArray<SlashOption>>(SLASH_OPTIONS);
			report.check(opened.length > 1, "the slash menu listed one option, so arrow navigation cannot be proved");
			report.equals(opened[0]?.selected, "true", "the slash menu opened with nothing selected");
			await pressKey(session, "ArrowDown", "ArrowDown", 40);
			const down = await page.evaluate<ReadonlyArray<SlashOption>>(SLASH_OPTIONS);
			report.equals(down[1]?.selected, "true", "ArrowDown did not move the slash-menu selection to the second option");
			report.equals(down[0]?.selected, "false", "ArrowDown left the first option selected as well");
			await pressKey(session, "ArrowUp", "ArrowUp", 38);
			const up = await page.evaluate<ReadonlyArray<SlashOption>>(SLASH_OPTIONS);
			report.equals(up[0]?.selected, "true", "ArrowUp did not move the slash-menu selection back to the first option");
			await page.press("Escape");
			report.equals(
				await page.evaluate<number>(`document.querySelectorAll(".slash-menu").length`),
				0,
				"Escape did not close the slash menu",
			);
			report.ok("E5.4: ArrowDown, ArrowUp and Escape drive the slash menu with no pointer.");

			// E5.4 — the C-3 structural rule, from the row's own probe source.
			const tabbable = new Set(await page.evaluate<ReadonlyArray<string>>(TABBABLE_FLOWS));
			report.check(tabbable.has("textarea"), "the composer is not in the page's tab ring");
			const pointerOnly = (await page.evaluate<ReadonlyArray<Affordance>>(VISIBLE_AFFORDANCES))
				.filter((affordance) => affordance.flow !== null && !tabbable.has(affordance.flow))
				.map((affordance) => affordance.flow ?? "");
			report.equals(pointerOnly.length, 0, `affordances a keyboard cannot reach: ${pointerOnly.join(", ")}`);
			report.ok("E5.4: every affordance carrying a flow name is in the tab ring.");

			// E5.3 at the keyboard — the typed name leads, and Enter runs it.
			await page.evaluate(FOCUS_COMPOSER);
			await page.type("/flows");
			await waitUntil(
				report,
				'typing "/flows" never opened the slash menu',
				async () => (await page.evaluate<ReadonlyArray<SlashOption>>(SLASH_OPTIONS)).length > 0,
				10_000,
			);
			const typed = await page.evaluate<ReadonlyArray<SlashOption>>(SLASH_OPTIONS);
			report.equals(
				typed.map((option) => option.name).join(","),
				"/flows,/flow.list",
				"typing /flows did not lead with the flow the user named",
			);
			await page.press("Enter");
			await waitUntil(
				report,
				"/flows + Enter rendered no catalog",
				async () => (await page.text()).includes("Everything Smithers can do right now:"),
				20_000,
			);
			/*
			 * The other half of exact-name precedence: flow.list did NOT also
			 * run. Excluded here are the two strings /flow.list really renders —
			 * its card title and its answer — both captured from a live
			 * invocation earlier in this same run rather than written down, so
			 * this cannot become an exclusion against a literal the product does
			 * not contain. The card is excluded structurally as well, because a
			 * flow.list that failed before answering would still upsert one.
			 *
			 * The complementary check — type /flow.list at the keyboard and watch
			 * these assertions fire — cannot be staged today. Browser.ts's
			 * `page.type` builds the CDP `code` as `Key${character.toUpperCase()}`,
			 * so "." dispatches as the invalid code `Key.` and the renderer drops
			 * it: no e2e suite can type a dotted flow name, and 71 of the 88 have
			 * a dot. That is a harness gap, not a product one, and it is why the
			 * card-title readability guard below is here.
			 */
			report.check(
				flowListRendered.title !== "" && flowListRendered.answer !== "",
				"/flow.list rendered nothing for this stage to exclude, so the precedence proof would be vacuous",
			);
			const afterEnter = await page.text();
			/*
			 * The text exclusions read document.body.innerText. Establish that
			 * this surface can see a card title at all — otherwise excluding
			 * flow.list's title would pass because the reader is blind, not
			 * because the card is absent. The page already carries cards, so
			 * every title they render must be in the text.
			 */
			const renderedCardTitles = await page.evaluate<ReadonlyArray<string>>(
				`Array.from(document.querySelectorAll(".smithers-card-title")).map((element) => (element.textContent ?? "").trim()).filter((title) => title.length > 0)`,
			);
			report.check(
				renderedCardTitles.length > 0,
				"the page carries no cards, so nothing establishes that its text can see a card title",
			);
			for (const title of renderedCardTitles) {
				report.includes(
					afterEnter,
					title,
					"a rendered card title is missing from the page text, so excluding flow.list's title would prove nothing",
				);
			}
			report.excludes(
				afterEnter,
				flowListRendered.title,
				"/flows + Enter rendered flow.list's workflow-list card, so it ran flow.list instead of the flow the user typed",
			);
			report.excludes(
				afterEnter,
				flowListRendered.answer,
				"/flows + Enter wrote flow.list's answer into the transcript, so it ran flow.list instead of the flow the user typed",
			);
			report.equals(
				await page.evaluate<number>(`document.querySelectorAll('.smithers-card[data-kind="workflow-list"]').length`),
				0,
				"/flows + Enter left a workflow-list card on the page, which only flow.list mints",
			);
			report.ok(
				`E5.3: typing /flows and pressing Enter runs flows, never the flow.list its summary also matches (neither ${JSON.stringify(flowListRendered.title)} nor its listing reached the page).`,
			);

			/*
			 * E5.2 — bare "/" leads with the recommendation and Enter runs it.
			 *
			 * The leader has to be decided by app STATE, not by whatever the
			 * reco double happens to be serving, so the reco seam answers its
			 * honest degraded shape for this stage: the digest needed GitHub,
			 * the watched selection did not. With no live recommendation, a
			 * selection already confirmed and no connectors, the recommendation
			 * rule names `connect`.
			 *
			 * The empty suggestion row is the settle signal. App.tsx renders one
			 * primary pill while a recommendation waits or a selection is
			 * unmade, and none once both are answered — so zero pills means the
			 * reco and watched reads have both landed, and the menu read below
			 * cannot race them.
			 */
			stack.fronts.reco.handle("GET", "/api/reco/first-run", () =>
				Response.json({
					degraded: true,
					honestMessage: "I couldn't read your GitHub work just now — ask me anything and we'll start from here.",
				}),
			);
			await page.reload();
			await waitUntil(
				report,
				"the app shell never came back after the reload",
				async () => (await page.evaluate<ReadonlyArray<string>>(REGISTERED_COMMANDS)).length > 0,
				30_000,
			);
			await waitUntil(
				report,
				"the app never settled on a state with no recommendation and no unmade selection",
				async () =>
					(await page.evaluate<number>(`document.querySelectorAll(".smithers-suggestions [data-flow]").length`)) === 0,
				30_000,
			);
			await page.evaluate(FOCUS_COMPOSER);
			await page.type("/");
			await waitUntil(
				report,
				'typing "/" never opened the slash menu after the reload',
				async () => (await page.evaluate<ReadonlyArray<SlashOption>>(SLASH_OPTIONS)).length > 0,
				10_000,
			);
			const bare = await page.evaluate<ReadonlyArray<SlashOption>>(SLASH_OPTIONS);
			/*
			 * `world` is what `recommendedNames` names for this state. Signing in
			 * IS the GitHub connector (AppController's snapshot: `hasConnectors:
			 * signedIn || …`), so with the selection made and no live
			 * recommendation, "see what Smithers understands" leads and "connect
			 * work" follows it. Enter runs whatever leads, so the menu must
			 * agree with that rule rather than with registry order.
			 */
			const recommended = "world";
			report.equals(bare[0]?.name, `/${recommended}`, "the slash menu did not lead with the recommended flow");
			report.equals(bare[0]?.gold, "true", "the leading slash option is not marked as the recommendation");
			report.equals(bare[0]?.selected, "true", "the leading slash option is not the one Enter would run");
			report.check(
				bare.slice(1).every((option) => option.selected !== "true"),
				"more than one slash option is selected, so Enter runs an ambiguous flow",
			);
			await page.press("Enter");
			await waitUntil(
				report,
				`bare "/" + Enter did not run /${recommended}`,
				async () =>
					(await page.evaluate<string | null>(
						`document.querySelector(".chat-frame")?.getAttribute("data-pane") ?? null`,
					)) === recommended,
				15_000,
			);
			report.equals(
				await page.evaluate<string>(`document.querySelector("textarea")?.value ?? "(no composer)"`),
				"",
				'bare "/" + Enter left the slash text in the composer',
			);
			report.ok(`E5.2: "/" opened with /${recommended} first, marked gold and selected, and bare "/" + Enter ran it.`);
			stack.fronts.reco.clear();
			session.close();
		}

		/* ---------------------------------------------------------- */
		/* E5.7 — admin-only                                           */
		/* ---------------------------------------------------------- */

		await stack.makeAdmin();
		const adminClient = await openClient({ origin, cookie });
		await adminClient.controller.loadSession();
		report.equals(
			adminClient.controller.commands.all().length,
			88,
			"an admin session does not register all 88 flows",
		);
		const adminFixtures: Fixtures = { ...fixtures, grantCardId: "" };
		const adminWalk: Walk = { client: adminClient, report, fixtures: adminFixtures, invoked };
		report.equals(
			[...ADMIN_ORDER].sort().join(","),
			[...namesIn("admin-only")].sort().join(","),
			"ADMIN_ORDER and the admin-only class disagree",
		);
		for (const name of ADMIN_ORDER) {
			if (name === "admin.grant.confirm") {
				const card = adminClient.cards().find((entry) => /grant/i.test(entry.title) && entry.status === "active");
				adminFixtures.grantCardId = card?.id ?? "grant-card-that-does-not-exist";
			}
			if (name === "admin.grant.cancel") {
				// The confirm above consumed the first card; raise another as a fixture.
				await within("the admin.grant fixture", 20_000, adminClient.controller.commands.run("admin.grant", "10 octocat"));
				const card = adminClient.cards().find((entry) => /grant/i.test(entry.title) && entry.status === "active");
				adminFixtures.grantCardId = card?.id ?? "grant-card-that-does-not-exist";
			}
			await smoke(adminWalk, name);
		}
		report.ok(`all ${ADMIN_ORDER.length} admin-only flows ran on an admin session with an honest outcome.`);

		/* ---------------------------------------------------------- */
		/* E5.7 — the skips, and the tally                             */
		/* ---------------------------------------------------------- */

		const adminNames = new Set(adminClient.controller.commands.all().map((command) => command.name));
		for (const name of namesIn("destructive-skip")) {
			report.check(!invoked.has(name), `${name} is destructive-skip but the smoke invoked it anyway`);
			// Skipped is not the same as absent: it must still be registered.
			report.check(adminNames.has(name), `${name} is classified but the registry no longer carries it`);
		}
		report.ok(`the ${namesIn("destructive-skip").length} destructive flows are registered and provably never invoked.`);

		const expected = registered.length - namesIn("destructive-skip").length;
		const notInvoked = registered.filter(
			(name) => !invoked.has(name) && SMOKE_TABLE[name]?.klass !== "destructive-skip",
		);
		report.equals(notInvoked.length, 0, `classified but never invoked: ${notInvoked.join(", ")}`);
		report.equals(invoked.size, expected, "the smoke invoked a different number of flows than it classified");
		/*
		 * Say the number that is true. This suite invokes 83 of 88; the other 5
		 * are proved registered and proved never invoked above, and calling that
		 * "88 smoked" would be the same kind of overclaim the floor exists to
		 * stop.
		 */
		report.ok(
			`${invoked.size} of ${registered.length} registered flows invoked, ${namesIn("destructive-skip").length} deliberately not (${namesIn("destructive-skip").join(", ")}) — those 5 are proved registered and proved untouched, never smoked.`,
		);
		await wait(50);
	},
});
