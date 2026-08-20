/*
 * The workspace seam: the two requests the workflow domain makes.
 *
 * `POST /api/workflow/provision` prepares (or resumes) the per-user gateway
 * workspace for a repository; `POST /api/workflow/rpc` is the whitelisted call
 * into that workspace. Both used to be issued from AppController, which put
 * the GitHub pane's Flows tab — a directive-1 surface — outside the network law
 * (AGENTS.md: every request is issued from `state/seams/`). The policy above
 * them stays in the controller: who may run a workflow, which repository the
 * command targets, what the toast says. This seam owns the wire.
 */
import type { SeamContext } from "./SeamContext";
import { errorMessageOf } from "./SeamContext";

export interface WorkflowSeamOptions {
	/** The request-with-a-deadline the controller builds; provision can hang. */
	readonly boundedHttp: (url: string, init: RequestInit) => Promise<Response>;
	/** How long to wait between polls of a mid-provision workspace. */
	readonly pollMs: number;
	/** The controller's own timer, so no seam holds a bun/node process open. */
	readonly wait: (ms: number) => Promise<void>;
	readonly provisionPath: string;
	readonly rpcPath: string;
}

/** An RPC either answered with a payload or refused with a sentence. */
export type WorkflowRpcResult =
	| { readonly status: "ok"; readonly payload: unknown }
	| { readonly status: "error"; readonly message: string };

export interface WorkflowSeam {
	/**
	 * True when the workspace is ready, otherwise the honest sentence for the
	 * transcript. A 409 means mid-provision: polls to a bounded deadline rather
	 * than stampeding the gateway.
	 */
	readonly provisionWorkspace: (repo: string) => Promise<true | string>;
	readonly workflowRpc: (repo: string, method: string, params: unknown) => Promise<WorkflowRpcResult>;
}

export const createWorkflowSeam = (ctx: SeamContext, options: WorkflowSeamOptions): WorkflowSeam => {
	const provisionWorkspace = async (repo: string): Promise<true | string> => {
		const deadline = Date.now() + options.pollMs * 36;
		for (;;) {
			let body: { status?: unknown; message?: unknown } | undefined;
			try {
				const response = await options.boundedHttp(`${ctx.baseUrl}${options.provisionPath}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ repo }),
				});
				if (!response.ok) {
					return await errorMessageOf(response, "The workspace couldn't be prepared.");
				}
				body = (await response.json().catch(() => undefined)) as typeof body;
			} catch {
				return "The workspace couldn't be prepared — the workflow service didn't answer in time.";
			}
			if (body?.status === "ready") return true;
			/*
			 * Wave 12 §4 — the watched set is a GITHUB set; a gateway needs a
			 * Smithers Cloud repository. When they don't coincide the honest
			 * answer is that fact, not the provision seam's raw HTTP failure.
			 */
			if (body?.status === "no-cloud-repo") {
				return `${repo} isn't on Smithers Cloud yet, so there's no workspace to run this on. Add it there and I'll pick it up, or point me at a repo that is.`;
			}
			if (body?.status === "provisioning") {
				if (Date.now() > deadline) {
					return `The workspace for ${repo} is still being prepared — try again in a moment.`;
				}
				await options.wait(options.pollMs);
				continue;
			}
			if (typeof body?.message === "string") return body.message;
			return "The workspace couldn't be prepared.";
		}
	};

	const workflowRpc = async (repo: string, method: string, params: unknown): Promise<WorkflowRpcResult> => {
		let body:
			| {
					status?: unknown;
					message?: unknown;
					ok?: unknown;
					payload?: unknown;
					error?: { message?: unknown } | unknown;
			  }
			| undefined;
		try {
			const response = await ctx.http(`${ctx.baseUrl}${options.rpcPath}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ repo, method, params }),
			});
			if (!response.ok) {
				return { status: "error", message: await errorMessageOf(response, "The workspace didn't answer.") };
			}
			body = (await response.json().catch(() => undefined)) as typeof body;
		} catch {
			return { status: "error", message: "The workspace didn't answer — the workflow service is unreachable." };
		}
		if (body?.ok === true) return { status: "ok", payload: body.payload };
		const gatewayError = body?.error;
		if (body?.ok === false) {
			return {
				status: "error",
				message:
					typeof gatewayError === "object" &&
					gatewayError !== null &&
					"message" in gatewayError &&
					typeof gatewayError.message === "string"
						? gatewayError.message
						: "The workspace refused the call.",
			};
		}
		if (typeof body?.message === "string") return { status: "error", message: body.message };
		return { status: "error", message: "The workspace answered in a shape I didn't understand." };
	};

	return { provisionWorkspace, workflowRpc };
};
