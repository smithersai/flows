/*
 * The workspace seam owns the two workflow requests.
 *
 * They used to be issued from AppController, which put the GitHub pane's Flows
 * tab outside the network law. These tests hold the wire to its contract from
 * the seam's own side: the URLs, the methods, the bodies, and every branch of
 * the provision answer — including the mid-provision poll, which is the one
 * that used to stampede the gateway.
 */
import { describe, expect, test } from "bun:test";
import type { StorageApi } from "@tanstack/db";
import { createAppStore } from "../AppStore";
import { createWorkflowSeam } from "./WorkflowSeam";
import type { SeamContext } from "./SeamContext";

interface Call {
	readonly url: string;
	readonly init: RequestInit | undefined;
}

const memoryStorage = (): StorageApi => {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key),
	};
};

const seamOf = async (answers: ReadonlyArray<{ status: number; body: unknown }>) => {
	const calls: Call[] = [];
	let next = 0;
	const respond = (url: string, init?: RequestInit): Promise<Response> => {
		calls.push({ url, init });
		const answer = answers[Math.min(next++, answers.length - 1)];
		return Promise.resolve(
			new Response(JSON.stringify(answer?.body ?? {}), {
				status: answer?.status ?? 200,
				headers: { "content-type": "application/json" },
			}),
		);
	};
	const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
	const ctx: SeamContext = {
		http: respond,
		baseUrl: "https://app.test",
		store,
		dispatch: store.dispatch,
		actor: () => "user",
		nextOrdinal: () => 1,
	};
	const waited: number[] = [];
	const seam = createWorkflowSeam(ctx, {
		boundedHttp: (url, init) => respond(url, init),
		pollMs: 5,
		wait: (ms) => {
			waited.push(ms);
			return Promise.resolve();
		},
		provisionPath: "/api/workflow/provision",
		rpcPath: "/api/workflow/rpc",
	});
	return { seam, calls, waited };
};

describe("the workspace seam issues the workflow requests", () => {
	test("provision POSTs the repository to the provision endpoint", async () => {
		const { seam, calls } = await seamOf([{ status: 200, body: { status: "ready" } }]);
		expect(await seam.provisionWorkspace("will/flows")).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://app.test/api/workflow/provision");
		expect(calls[0]?.init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ repo: "will/flows" });
	});

	test("a mid-provision answer polls to a ready one instead of stampeding", async () => {
		const { seam, calls, waited } = await seamOf([
			{ status: 200, body: { status: "provisioning" } },
			{ status: 200, body: { status: "provisioning" } },
			{ status: 200, body: { status: "ready" } },
		]);
		expect(await seam.provisionWorkspace("will/flows")).toBe(true);
		expect(calls).toHaveLength(3);
		expect(waited).toEqual([5, 5]);
	});

	test("a repository with no cloud mirror gets a sentence, not a raw failure", async () => {
		const { seam } = await seamOf([{ status: 200, body: { status: "no-cloud-repo" } }]);
		expect(await seam.provisionWorkspace("will/flows")).toContain("will/flows");
	});

	test("a refused provision keeps the upstream's own message", async () => {
		const { seam } = await seamOf([{ status: 503, body: { message: "The gateway is draining." } }]);
		expect(await seam.provisionWorkspace("will/flows")).toBe("The gateway is draining.");
	});

	test("rpc POSTs repo, method and params to the rpc endpoint", async () => {
		const { seam, calls } = await seamOf([{ status: 200, body: { ok: true, payload: [{ key: "review" }] } }]);
		const result = await seam.workflowRpc("will/flows", "listWorkflows", {});
		expect(result).toEqual({ status: "ok", payload: [{ key: "review" }] });
		expect(calls[0]?.url).toBe("https://app.test/api/workflow/rpc");
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			repo: "will/flows",
			method: "listWorkflows",
			params: {},
		});
	});

	test("a gateway refusal comes back as its own message", async () => {
		const { seam } = await seamOf([{ status: 200, body: { ok: false, error: { message: "unknown workflow" } } }]);
		expect(await seam.workflowRpc("will/flows", "run", {})).toEqual({
			status: "error",
			message: "unknown workflow",
		});
	});

	test("an unreadable answer is refused rather than guessed at", async () => {
		const { seam } = await seamOf([{ status: 200, body: { surprise: true } }]);
		expect(await seam.workflowRpc("will/flows", "run", {})).toEqual({
			status: "error",
			message: "The workspace answered in a shape I didn't understand.",
		});
	});
});
