import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { CANCEL_PATH, TURN_PATH } from "../shared/AgentApiRoutes";
import { installAgentApi } from "./AgentApi";
import type { MiddlewareHost } from "./AgentApi";

/** A fake chat.smithers.sh: emits the wire NDJSON frames the real service emits. */
const upstream = Bun.serve({
	port: 0,
	fetch: (request) =>
		new Response(
			new ReadableStream<Uint8Array>({
				async start(controller) {
					const encoder = new TextEncoder();
					const write = (frame: unknown) =>
						controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
					if (new URL(request.url).searchParams.has("hang")) {
						// Never completes, so the test can observe cancellation.
						request.signal.addEventListener("abort", () => controller.close());
						return;
					}
					write({ type: "delta", kind: "reasoning", text: "thinking" });
					write({ type: "delta", kind: "text", text: "I am Smithers." });
					await Bun.sleep(5);
					write({ type: "done" });
					controller.close();
				},
			}),
			{ headers: { "content-type": "application/x-ndjson" } },
		),
});

/** Routes like connect: longest registration first, prefix match on the path. */
const startBoundary = (chatQuery = "") => {
	const routes: Array<{ path: string; handler: Parameters<MiddlewareHost["use"]>[1] }> = [];
	const host: MiddlewareHost = { use: (path, handler) => routes.push({ path, handler }) };
	installAgentApi(host, { chatUrl: `${upstream.url.origin}/chat${chatQuery}` });
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

const body = (runId: string) =>
	JSON.stringify({
		runId,
		messages: [{ role: "user", content: "Hello who are you" }],
		instructions: "Be brief.",
	});

const post = (origin: string, path: string, payload: string) =>
	fetch(`${origin}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: payload,
	});

const readLines = async (response: Response): Promise<Array<unknown>> => {
	const text = await response.text();
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as unknown);
};

afterAll(() => upstream.stop(true));

describe("installAgentApi", () => {
	test("streams upstream frames back as NDJSON stamped with the runId", async () => {
		const boundary = startBoundary();
		try {
			const response = await post(boundary.origin, TURN_PATH, body("run-stream"));
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("application/x-ndjson");
			expect(await readLines(response)).toEqual([
				{ runId: "run-stream", type: "delta", kind: "reasoning", text: "thinking" },
				{ runId: "run-stream", type: "delta", kind: "text", text: "I am Smithers." },
				{ runId: "run-stream", type: "done" },
			]);
		} finally {
			boundary.close();
		}
	});

	test("cancelling closes the open turn response instead of leaving the browser hanging", async () => {
		const boundary = startBoundary("?hang");
		try {
			const streamed = post(boundary.origin, TURN_PATH, body("run-cancel"));
			const response = await streamed;
			expect(response.status).toBe(200);
			const cancelled = await post(
				boundary.origin,
				CANCEL_PATH,
				JSON.stringify({ runId: "run-cancel" }),
			);
			expect(await cancelled.json()).toEqual({ status: "cancelled" });
			// Resolves only because the boundary ended the response on cancel.
			expect(await readLines(response)).toEqual([]);
		} finally {
			boundary.close();
		}
	});

	test("cancelling an unknown run reports not-found", async () => {
		const boundary = startBoundary();
		try {
			const response = await post(boundary.origin, CANCEL_PATH, JSON.stringify({ runId: "ghost" }));
			expect(await response.json()).toEqual({ status: "not-found" });
		} finally {
			boundary.close();
		}
	});

	test("rejects malformed bodies, wrong methods, and duplicate runs", async () => {
		const boundary = startBoundary("?hang");
		try {
			expect((await post(boundary.origin, TURN_PATH, "{")).status).toBe(400);
			expect((await post(boundary.origin, TURN_PATH, JSON.stringify({ runId: 1 }))).status).toBe(
				400,
			);
			expect((await fetch(`${boundary.origin}${TURN_PATH}`)).status).toBe(405);

			const first = await post(boundary.origin, TURN_PATH, body("run-duplicate"));
			expect(first.status).toBe(200);
			const duplicate = await post(boundary.origin, TURN_PATH, body("run-duplicate"));
			expect(duplicate.status).toBe(409);
			expect(await duplicate.json()).toMatchObject({ status: "error" });
			await post(boundary.origin, CANCEL_PATH, JSON.stringify({ runId: "run-duplicate" }));
			await first.text();
		} finally {
			boundary.close();
		}
	});

	test("reports an upstream failure as a done frame carrying the error", async () => {
		const failing = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 503 }) });
		const routes: Array<{ path: string; handler: Parameters<MiddlewareHost["use"]>[1] }> = [];
		const host: MiddlewareHost = { use: (path, handler) => routes.push({ path, handler }) };
		installAgentApi(host, { chatUrl: `${failing.url.origin}/chat` });
		const server = createServer((req, res) => {
			const route = routes.find((candidate) => (req.url ?? "").startsWith(candidate.path));
			route?.handler(req, res);
		});
		server.listen(0);
		const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		try {
			const frames = await readLines(await post(origin, TURN_PATH, body("run-fail")));
			expect(frames).toHaveLength(1);
			expect(frames[0]).toMatchObject({ runId: "run-fail", type: "done" });
			expect((frames[0] as { error: string }).error).toContain("503");
		} finally {
			server.close();
			failing.stop(true);
		}
	});
});
