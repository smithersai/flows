import { isAgentTurnFrame } from "smithers-shared/NativeAgent";
import type { AgentTurnFrame } from "smithers-shared/NativeAgent";
import type { Card } from "smithers-shared/Cards";

/*
 * The TUI transcript: the in-memory headless state layer for the terminal chat.
 * Components are projections of this store (via useSyncExternalStore); nothing
 * in the render tree owns application state.
 *
 * TODO: persistence. This round keeps collections in memory; a persisted
 * transcript (and a proper collection boundary) lands with the shared-package
 * extraction. Do NOT pull wa-sqlite into the TUI.
 *
 * TODO(mirror): live mirroring with a running UI instance (shared live
 * session / state sync between the two frontends) plugs in here: the store is
 * the seam a synced authority would replace.
 */

export type MessageStatus = "streaming" | "complete" | "failed" | "interrupted";

export interface MessageEntry {
	readonly kind: "message";
	readonly id: string;
	readonly role: "user" | "assistant";
	readonly text: string;
	readonly reasoning?: string;
	readonly status: MessageStatus;
	readonly detail?: string;
}

export interface ToolEntry {
	readonly kind: "tool";
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
	/*
	 * TODO(tools): the TUI does not execute tools this round — a `tool_call`
	 * frame renders compactly and the turn ends. The client tool loop
	 * (continuation turn carrying function_call_output) is the follow-up seam.
	 */
	readonly output?: string;
}

export interface CardEntry {
	readonly kind: "card";
	readonly id: string;
	readonly cardKind: Card["kind"];
	readonly title: string;
	readonly status: string;
}

/** Chain turn frames (link.*, call.*, gate, park) rendered as one compact line. */
export interface EventEntry {
	readonly kind: "event";
	readonly id: string;
	readonly text: string;
}

export type TranscriptEntry = MessageEntry | ToolEntry | CardEntry | EventEntry;

export type ChatPhase = "idle" | "responding";

export class TranscriptStore {
	private entriesValue: Array<TranscriptEntry> = [];
	private versionValue = 0;
	private phaseValue: ChatPhase = "idle";
	private readonly listeners = new Set<() => void>();
	private sequence = 0;

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/** The useSyncExternalStore snapshot: a monotonically increasing version. */
	readonly getVersion = (): number => this.versionValue;

	readonly entries = (): ReadonlyArray<TranscriptEntry> => this.entriesValue;

	readonly phase = (): ChatPhase => this.phaseValue;

	readonly setPhase = (phase: ChatPhase): void => {
		if (this.phaseValue === phase) return;
		this.phaseValue = phase;
		this.versionValue += 1;
		for (const listener of this.listeners) listener();
	};

	private nextId(prefix: string): string {
		this.sequence += 1;
		return `${prefix}-${this.sequence}`;
	}

	private commit(entries: Array<TranscriptEntry>): void {
		this.entriesValue = entries;
		this.versionValue += 1;
		for (const listener of this.listeners) listener();
	}

	private append(entry: TranscriptEntry): void {
		this.commit([...this.entriesValue, entry]);
	}

	private replace(id: string, entry: TranscriptEntry): void {
		this.commit(this.entriesValue.map((existing) => (existing.id === id ? entry : existing)));
	}

	readonly get = (id: string): TranscriptEntry | undefined =>
		this.entriesValue.find((entry) => entry.id === id);

	readonly appendUserMessage = (turnId: string, text: string): void => {
		this.append({
			kind: "message",
			id: `message-${turnId}-user`,
			role: "user",
			text,
			status: "complete",
		});
	};

	readonly appendDelta = (runId: string, channel: "reasoning" | "text", delta: string): void => {
		if (delta === "") return;
		const id = `message-${runId}-assistant`;
		const existing = this.get(id);
		if (existing === undefined) {
			this.append({
				kind: "message",
				id,
				role: "assistant",
				text: channel === "text" ? delta : "",
				...(channel === "reasoning" ? { reasoning: delta } : {}),
				status: "streaming",
			});
			return;
		}
		if (existing.kind !== "message") return;
		this.replace(id, {
			...existing,
			text: channel === "text" ? existing.text + delta : existing.text,
			reasoning: channel === "reasoning" ? (existing.reasoning ?? "") + delta : existing.reasoning,
		});
	};

	readonly settleAssistant = (
		runId: string,
		status: Exclude<MessageStatus, "streaming">,
		detail?: string,
	): void => {
		const id = `message-${runId}-assistant`;
		const existing = this.get(id);
		if (existing === undefined) {
			// A kill or failure before the first delta: say what happened on that
			// turn rather than leaving the user's message hanging with nothing
			// after it. An ordinary stop with no prose settles silently.
			if (status === "complete") return;
			this.append({
				kind: "message",
				id,
				role: "assistant",
				text: detail ?? "That turn ended without a response.",
				status,
				...(detail === undefined ? {} : { detail }),
			});
			return;
		}
		if (existing.kind !== "message") return;
		this.replace(id, { ...existing, status, ...(detail === undefined ? {} : { detail }) });
	};

	readonly appendToolCall = (callId: string, name: string, args: string): void => {
		this.append({ kind: "tool", id: `tool-${callId}`, name, arguments: args });
	};

	readonly upsertCard = (card: Card): void => {
		const entry: CardEntry = {
			kind: "card",
			id: `card-${card.id}`,
			cardKind: card.kind,
			title: card.title,
			status: card.status,
		};
		if (this.get(entry.id) === undefined) {
			this.append(entry);
		} else {
			this.replace(entry.id, entry);
		}
	};

	readonly patchCard = (cardId: string, patch: { title?: string; status?: string }): void => {
		const id = `card-${cardId}`;
		const existing = this.get(id);
		if (existing === undefined || existing.kind !== "card") return;
		this.replace(id, {
			...existing,
			title: patch.title ?? existing.title,
			status: patch.status ?? existing.status,
		});
	};

	readonly appendEvent = (text: string): void => {
		this.append({ kind: "event", id: this.nextId("event"), text });
	};
}

/** The one-line placeholder the TUI renders for any card (HTML embeds are disabled this round). */
// TODO(open-in-app): render a link that opens this card in the native app
export const cardPlaceholder = (entry: CardEntry): string =>
	`[card] ${entry.cardKind}: ${entry.title} (${entry.status})`;

/** The compact one-line rendering of a tool call (and its output, once tools execute). */
export const toolCallLine = (entry: ToolEntry): string =>
	entry.output === undefined
		? `[tool] ${entry.name} ${entry.arguments}`
		: `[tool] ${entry.name} ${entry.arguments} → ${entry.output}`;

/** The visible message history for a turn request: complete, non-empty prose only. */
// TODO(shared): move to a shared package (derived from contextMessages in apps/ui/src/mainview/state/AgentTurnPolicy.ts)
export const transcriptMessages = (
	entries: ReadonlyArray<TranscriptEntry>,
): ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: string }> =>
	entries
		.filter(
			(entry): entry is MessageEntry =>
				entry.kind === "message" && entry.status !== "streaming" && entry.text.trim() !== "",
		)
		.map((entry) => ({
			role: entry.role,
			content: entry.text,
		}));

/** Fold one wire frame into transcript state. */
// TODO(shared): move to a shared package (derived from the frame handling in apps/ui/src/mainview/state/AppController.ts)
export const applyFrame = (store: TranscriptStore, frame: AgentTurnFrame): void => {
	switch (frame.type) {
		case "delta":
			store.appendDelta(frame.runId, frame.kind, frame.text);
			break;
		case "done":
			if (frame.error !== undefined) {
				store.settleAssistant(frame.runId, "failed", `That turn failed. ${frame.error}`);
			} else if (frame.reason === "cancelled") {
				store.settleAssistant(frame.runId, "interrupted", "Stopped the current response.");
			} else {
				store.settleAssistant(frame.runId, "complete");
			}
			break;
		case "card":
			store.upsertCard(frame.card);
			break;
		case "card.update":
			store.patchCard(frame.id, frame.patch);
			break;
		case "tool_call":
			store.appendToolCall(frame.call_id, frame.name, frame.arguments);
			break;
		case "link.authored":
			store.appendEvent(`[chain] link ${frame.link} authored`);
			break;
		case "call.started":
			store.appendEvent(`[chain] call ${frame.name} started`);
			break;
		case "call.settled":
			store.appendEvent(`[chain] call ${frame.name} settled (${frame.verdict})`);
			break;
		case "gate.rejected":
			store.appendEvent(
				`[chain] gate rejected (${frame.kind})${frame.message === undefined ? "" : `: ${frame.message}`}`,
			);
			break;
		case "link.ended":
			store.appendEvent(`[chain] link ${frame.link} ended (${frame.outcome})`);
			break;
		case "steering.drained":
			store.appendEvent(`[chain] steering drained (${frame.count})`);
			break;
		case "park":
			store.appendEvent(`[chain] parked (${frame.code})`);
			if (frame.card !== undefined) store.upsertCard(frame.card);
			break;
	}
};

/*
 * Decode an NDJSON AgentTurnFrame stream into transcript state: the same
 * line-split/parse/validate fold both transports run, exposed on the headless
 * layer so tests (and the smoke script) drive the store without a network.
 * Returns the number of frames applied.
 */
// TODO(shared): move to a shared package (the line fold mirrors apps/ui/src/mainview/native/WebAgent.ts streamFrames)
export const feedNdjson = (store: TranscriptStore, text: string): number => {
	let applied = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isAgentTurnFrame(parsed)) continue;
		applyFrame(store, parsed);
		applied += 1;
	}
	return applied;
};
