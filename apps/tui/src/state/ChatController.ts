import type { StartAgentTurnResult } from "smithers-shared/NativeAgent";
import type { AgentTurnFrame } from "smithers-shared/NativeAgent";
import { applyFrame, TranscriptStore } from "./Transcript";
import { buildTurnRequest } from "./TurnRequest";

/*
 * The chat controller: owns the turn lifecycle against the store. Components
 * call submit/cancel; frames arrive through the transport's publish callback
 * and fold into the store. The store is the only state; this class is wiring.
 */
export interface TuiTransport {
	readonly start: (request: import("smithers-shared/NativeAgent").StartAgentTurnRequest) =>
		| StartAgentTurnResult
		| Promise<StartAgentTurnResult>;
	readonly cancel: (runId: string) => unknown;
}

export class ChatController {
	private turnCounter = 0;
	private activeRunId: string | null = null;

	constructor(
		readonly store: TranscriptStore,
		private readonly transport: TuiTransport,
	) {}

	readonly publish = (frame: AgentTurnFrame): void => {
		applyFrame(this.store, frame);
		if (frame.type === "done" && frame.runId === this.activeRunId) {
			this.activeRunId = null;
			this.store.setPhase("idle");
		}
	};

	readonly isResponding = (): boolean => this.activeRunId !== null;

	/** Composer submit: append the user message, build the request, start the turn. */
	readonly submit = async (draft: string): Promise<void> => {
		if (this.activeRunId !== null) return;
		this.turnCounter += 1;
		const runId = `tui-${Date.now()}-${this.turnCounter}`;
		const built = buildTurnRequest(runId, this.store.entries(), draft);
		if (built.status !== "ok") {
			if (built.status === "oversized") {
				this.store.appendEvent(
					`That message is too large for one turn (${built.bytes} bytes; the limit is 64 KiB on the boundary).`,
				);
			}
			return;
		}
		this.store.appendUserMessage(runId, draft.trim());
		this.activeRunId = runId;
		this.store.setPhase("responding");
		const result = await this.transport.start(built.request);
		if (result.status === "error") {
			this.store.settleAssistant(runId, "failed", `That turn failed. ${result.message}`);
			this.activeRunId = null;
			this.store.setPhase("idle");
		}
	};

	/** Esc: cancel the in-flight turn through the transport's cancel contract. */
	readonly cancelActive = (): void => {
		const runId = this.activeRunId;
		if (runId === null) return;
		void this.transport.cancel(runId);
		// The local abort means no terminal frame may ever arrive; settle
		// honestly now rather than leaving the turn visibly streaming.
		this.store.settleAssistant(runId, "interrupted", "Stopped the current response.");
		this.activeRunId = null;
		this.store.setPhase("idle");
	};
}
