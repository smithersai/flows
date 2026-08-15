import { afterEach, describe, expect, test } from "bun:test";
import { MODEL_STREAM_PATH } from "smithers-shared/AgentApiRoutes";
import worker from "./index";
import type { WorkerEnv } from "./index";

/*
 * The relay boundary, driven through the Worker's real fetch handler with the
 * upstream fetch patched — no network. The contract under test: session-free
 * dev mode passes through, the provider key is injected and the client's
 * placeholder never forwarded, the sealed-step law rejects tool-bearing
 * bodies, and an unconfigured relay answers 501 instead of forwarding a
 * request that can only come back 401.
 */

const env = (overrides: Partial<WorkerEnv> = {}): WorkerEnv =>
	({
		ASSETS: { fetch: async () => new Response("not-found", { status: 404 }) },
		...overrides,
	}) as WorkerEnv;

const relayRequest = (body: unknown, headers: Record<string, string> = {}): Request =>
	new Request(`https://app.test${MODEL_STREAM_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			"x-api-key": "browser-relay-placeholder",
			...headers,
		},
		body: JSON.stringify(body),
	});

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("the model relay route", () => {
	test("injects the provider key and streams the provider body back verbatim", async () => {
		const captured: Array<Request> = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			captured.push(new Request(input as Request | string, init));
			return new Response("event: message_stop\ndata: {}\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;

		const response = await worker.fetch(
			relayRequest({ model: "claude-sonnet-5", stream: true, messages: [] }),
			env({ MODEL_RELAY_API_KEY: "sk-real-provider-key" }),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(await response.text()).toContain("message_stop");

		expect(captured).toHaveLength(1);
		const sent = captured[0]!;
		expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
		expect(sent.headers.get("x-api-key")).toBe("sk-real-provider-key");
		expect(sent.headers.get("anthropic-version")).toBe("2023-06-01");
		// The browser's placeholder credential dies at the boundary.
		expect(sent.headers.get("x-api-key")).not.toBe("browser-relay-placeholder");
	});

	test("honors MODEL_RELAY_URL as the upstream override", async () => {
		const urls: Array<string> = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			urls.push(new Request(input as Request | string, init).url);
			return new Response("ok", { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as typeof fetch;
		await worker.fetch(
			relayRequest({ model: "claude-sonnet-5" }),
			env({ MODEL_RELAY_API_KEY: "k", MODEL_RELAY_URL: "https://relay.test/v1/messages" }),
		);
		expect(urls).toEqual(["https://relay.test/v1/messages"]);
	});

	test("rejects a tool-bearing body — the relay serves sealed author calls only", async () => {
		const response = await worker.fetch(
			relayRequest({ model: "claude-sonnet-5", tools: [{ name: "bash" }] }),
			env({ MODEL_RELAY_API_KEY: "k" }),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("sealed author calls only");
	});

	test("answers 501 when the relay key is not configured", async () => {
		const response = await worker.fetch(relayRequest({ model: "claude-sonnet-5" }), env());
		expect(response.status).toBe(501);
		expect(await response.text()).toContain("MODEL_RELAY_API_KEY");
	});

	test("surfaces an upstream failure with its status and detail", async () => {
		globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 })) as typeof fetch;
		const response = await worker.fetch(
			relayRequest({ model: "claude-sonnet-5" }),
			env({ MODEL_RELAY_API_KEY: "k" }),
		);
		expect(response.status).toBe(529);
		expect(await response.text()).toContain("overloaded");
	});

	test("only POST is allowed", async () => {
		const response = await worker.fetch(
			new Request(`https://app.test${MODEL_STREAM_PATH}`, { method: "GET" }),
			env({ MODEL_RELAY_API_KEY: "k" }),
		);
		expect(response.status).toBe(405);
	});
});
