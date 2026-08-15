import type { ElectrobunRPCSchema } from "electrobun";
import type {
	AgentTurnFrame,
	StartAgentTurnRequest,
	StartAgentTurnResult,
} from "./NativeAgent";
import type {
	PickLocalRepositoryResult,
	RepositoryAccess,
} from "./NativeRepository";

export interface SmithersNativeRPC extends ElectrobunRPCSchema {
	readonly bun: {
		readonly requests: {
			readonly pickLocalRepository: {
				readonly params: { readonly access: RepositoryAccess };
				readonly response: PickLocalRepositoryResult;
			};
			readonly startAgentTurn: {
				readonly params: StartAgentTurnRequest;
				readonly response: StartAgentTurnResult;
			};
			readonly cancelAgentTurn: {
				readonly params: { readonly runId: string };
				readonly response: { readonly status: "cancelled" | "not-found" };
			};
			/**
			 * Open a URL in the SYSTEM browser (never the webview). The native
			 * sign-in handoff runs GitHub OAuth there because an embedded webview
			 * has no platform authenticator — passkeys can only work outside.
			 */
			readonly openExternal: {
				readonly params: { readonly url: string };
				readonly response: { readonly opened: boolean };
			};
		};
		readonly messages: Record<never, never>;
	};
	readonly webview: {
		readonly requests: Record<never, never>;
		readonly messages: {
			readonly agentFrame: AgentTurnFrame;
		};
	};
}
