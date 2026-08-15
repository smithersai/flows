import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { TURN_PATH } from "../shared/AgentApiRoutes";
import { installAgentApi } from "./AgentApi";
import type { MiddlewareHost } from "./AgentApi";
import type { AgentRuntimeContext } from "../shared/AgentContext";

const contextFixture = (overrides: Partial<AgentRuntimeContext> = {}): AgentRuntimeContext => ({
	version: 1,
	product: "smithers",
	capturedAt: 1786223000000,
	revision: 7,
	surface: "chat",
	theme: "dark",
	selectedWorldDocument: null,
	connectors: [],
	github: { connected: false, login: null, watchedRepos: null },
	worldState: { documentCount: 0, documents: [] },
	capabilities: ["Hold a streaming conversation in this chat and read its visible transcript."],
	limitations: ["Cannot see or control the host environment beyond what this context block states."],
	...overrides,
});

/**
 * The context must cross the web server boundary: the browser posts it to
 * /api/agent/turn, and the boundary renders it into the instructions the
 * upstream chat service sees — while the structured context itself never
 * reaches upstream.
 */
const upstreamBodies: unknown[] = [];
const upstream = Bun.serve({
	port: 0,
	fetch: async (request) => {
		upstreamBodies.push(await request.json());
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					controller.enqueue(encoder.encode(`${JSON.stringify({ type: "delta", kind: "text", text: "You are in Smithers." })}\n`));
					controller.enqueue(encoder.encode(`${JSON.stringify({ type: "done" })}\n`));
					controller.close();
				},
			}),
			{ headers: { "content-type": "application/x-ndjson" } },
		);
	},
});
afterAll(() => upstream.stop(true));

const startBoundary = () => {
	const routes: Array<{ path: string; handler: Parameters<MiddlewareHost["use"]>[1] }> = [];
	const host: MiddlewareHost = { use: (path, handler) => routes.push({ path, handler }) };
	installAgentApi(host, { chatUrl: `${upstream.url.origin}/chat` });
	const server = createServer((req, res) => {
		const path = (req.url ?? "").split("?")[0] ?? "";
		const route = routes.find(
			(candidate) => path === candidate.path || path.startsWith(`${candidate.path}/`),
		);
		if (route === undefined) {
			res.statusCode = 404;
			res.end();
			return;
		}
		route.handler(req, res);
	});
	server.listen(0);
	const port = (server.address() as AddressInfo).port;
	return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
};

describe("installAgentApi runtime context boundary", () => {
	test("renders the posted context into the upstream instructions across the web server boundary", async () => {
		const boundary = startBoundary();
		try {
			const context = contextFixture({ surface: "connectors", revision: 42 });
			const response = await fetch(`${boundary.origin}${TURN_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					runId: "run-context",
					messages: [{ role: "user", content: "hey smithers what app am I in" }],
					instructions: "Be brief.",
					context,
				}),
			});
			expect(response.status).toBe(200);
			await response.text();

			expect(upstreamBodies).toHaveLength(1);
			const upstreamBody = upstreamBodies[0] as Record<string, unknown>;
			// Upstream sees one instructions string with the rendered context…
			const instructions = String(upstreamBody.instructions);
			expect(instructions.startsWith("Be brief.")).toBe(true);
			expect(instructions).toContain("Runtime context");
			expect(instructions).toContain("running INSIDE the Smithers product");
			expect(instructions).toContain("Current surface: connectors");
			expect(instructions).toContain("app-state revision 42");
			// …and the structured context itself never crosses to upstream.
			expect("context" in upstreamBody).toBe(false);
		} finally {
			boundary.close();
		}
	});

	test("rejects a malformed context instead of forwarding an arbitrary blob", async () => {
		const boundary = startBoundary();
		try {
			const response = await fetch(`${boundary.origin}${TURN_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					runId: "run-bad-context",
					messages: [{ role: "user", content: "hi" }],
					instructions: "Be brief.",
					context: { version: 99, product: "not-smithers" },
				}),
			});
			expect(response.status).toBe(400);
		} finally {
			boundary.close();
		}
	});
});
