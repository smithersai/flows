import { Electroview } from "electrobun/view";
import type {
	AgentTurnFrame,
	StartAgentTurnRequest,
	StartAgentTurnResult,
} from "smithers-shared/NativeAgent";
import type { SmithersNativeRPC } from "smithers-shared/NativeRPC";
import type {
	PickLocalRepositoryResult,
	RepositoryAccess,
} from "smithers-shared/NativeRepository";

const agentFrameListeners = new Set<(frame: AgentTurnFrame) => void>();

const rpc = (() => {
	if (window.__electrobun === undefined) return undefined;
	const nativeRpc = Electroview.defineRPC<SmithersNativeRPC>({
		handlers: {
			requests: {},
			messages: {
				agentFrame: (frame) => {
					for (const listener of agentFrameListeners) listener(frame);
				},
			},
		},
	});
	new Electroview({ rpc: nativeRpc });
	return nativeRpc;
})();

/**
 * Open a URL in the system browser through the native shell; undefined in
 * pure web (a browser page opens tabs itself). The sign-in handoff keys off
 * this: present means OAuth can run outside the webview.
 */
export const nativeOpenExternal: ((url: string) => Promise<boolean>) | undefined =
	rpc === undefined
		? undefined
		: async (url) => (await rpc.proxy.request.openExternal({ url })).opened;

export interface NativeRepositories {
	readonly available: boolean;
	readonly pickLocalRepository: (
		access: RepositoryAccess,
	) => Promise<PickLocalRepositoryResult>;
}

export const nativeRepositories: NativeRepositories = {
	available: rpc !== undefined,
	pickLocalRepository: (access) =>
		rpc === undefined
			? Promise.resolve({
					status: "error",
					code: "native-required",
					message: "Local repositories can only be connected from the Smithers native app.",
				})
			: rpc.proxy.request.pickLocalRepository({ access }),
};

export interface NativeAgent {
	readonly available: boolean;
	readonly startTurn: (request: StartAgentTurnRequest) => Promise<StartAgentTurnResult>;
	readonly cancelTurn: (runId: string) => Promise<void>;
	/**
	 * Mid-turn input (DESIGN.md §14): admit a message into the running turn's
	 * steering queue, drained at the next link boundary. Absent on backends
	 * without steering (the proxy) — callers treat undefined as "not steerable"
	 * and answers false when the run is not live.
	 */
	readonly steer?: (runId: string, text: string) => Promise<boolean>;
	/**
	 * Resolve a chain approval park (DESIGN.md §14): record the human's
	 * decision against the pending ask so a fresh startTurn on the same
	 * lineage converges under it. `ask` reconstructs the record after a
	 * reload from the persisted card. Absent on backends without the seam.
	 */
	readonly resolveApproval?: (
		runId: string,
		decision: "approved" | "denied",
		ask?: { readonly name: string; readonly claim: string },
	) => Promise<boolean>;
	/** Drop every session grant and pending denial (admin /debug.grants.reset). */
	readonly revokeGrants?: () => Promise<void>;
	readonly subscribe: (listener: (frame: AgentTurnFrame) => void) => () => void;
}

const electrobunAgent: NativeAgent | undefined =
	rpc === undefined
		? undefined
		: {
				available: true,
				startTurn: (request) => rpc.proxy.request.startAgentTurn(request),
				cancelTurn: async (runId) => {
					await rpc.proxy.request.cancelAgentTurn({ runId });
				},
				subscribe: (listener) => {
					agentFrameListeners.add(listener);
					return () => agentFrameListeners.delete(listener);
				},
			};

/**
 * The native shell's agent, over the Electrobun RPC bridge. Undefined in pure
 * web, where the agent loop runs in the page itself (the Agent Chain) and the
 * only thing the browser asks a server for is one metered model call.
 */
export const nativeAgent: NativeAgent | undefined = electrobunAgent;
