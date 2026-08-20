/*
 * The hermetic e2e harness — the programmable front.
 *
 * A "front" is a reverse proxy that sits between the product Worker and one
 * test double. It exists so a suite can add routes, faults and delays at
 * runtime instead of editing scripts/stub-backends.ts, which every other suite
 * shares. The Worker's *_UPSTREAM_URL points at the front, never at the double.
 *
 * A registered path matches exactly, or by prefix when it ends with "*".
 */

export interface FrontRequest {
	readonly method: string;
	readonly path: string;
	readonly search: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

/** Return undefined to fall through to the double. */
export type FrontHandler = (request: Request, url: URL) => Response | Promise<Response> | undefined;

export interface Front {
	readonly name: string;
	readonly port: number;
	/** http://127.0.0.1:<port> — what the Worker's *_UPSTREAM_URL points at. */
	readonly url: string;
	/** Register an override. Return undefined from the handler to fall through to the double. */
	readonly handle: (method: string, path: string, handler: FrontHandler) => void;
	/** Answer the next call to `path` with `status`/`body`, once. */
	readonly failOnce: (method: string, path: string, status: number, body?: string) => void;
	/** Drop the connection on the next call to `path`, once (a network drop). */
	readonly dropOnce: (method: string, path: string) => void;
	/** Delay every call to `path` by `ms` until cleared. */
	readonly delay: (path: string, ms: number) => void;
	/** Everything that reached this front, oldest first. */
	readonly requests: () => ReadonlyArray<FrontRequest>;
	/** Repoint at a freshly created double. Used by Stack.reset(). */
	readonly setUpstream: (port: number) => void;
	/** Drop every override, fault, delay and recorded request. */
	readonly clear: () => void;
	readonly stop: () => void;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exact match, or prefix match when the registered pattern ends with "*". */
const matches = (pattern: string, path: string): boolean =>
	pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : pattern === path;

const findKey = <T>(table: Map<string, T>, method: string, path: string): string | undefined => {
	const wanted = method.toUpperCase();
	for (const key of table.keys()) {
		const space = key.indexOf(" ");
		if (key.slice(0, space) !== wanted) continue;
		if (matches(key.slice(space + 1), path)) return key;
	}
	return undefined;
};

/** A body that errors the moment it is read — what a dropped connection looks like to the Worker. */
const droppedBody = (): ReadableStream<Uint8Array> =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.error(new Error("the e2e front dropped this connection"));
		},
	});

export const createFront = (name: string, upstreamPort: number): Front => {
	let upstream = upstreamPort;
	const handlers = new Map<string, FrontHandler>();
	const failures = new Map<string, Array<{ status: number; body: string }>>();
	const drops = new Map<string, number>();
	const delays = new Map<string, number>();
	const recorded: Array<FrontRequest> = [];

	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const method = request.method.toUpperCase();
			const headers: Record<string, string> = {};
			for (const [key, value] of request.headers) headers[key.toLowerCase()] = value;
			const body = method === "GET" || method === "HEAD" ? "" : await request.text();
			recorded.push({ method, path: url.pathname, search: url.search, headers, body });

			for (const [pattern, ms] of delays) {
				if (matches(pattern, url.pathname)) await wait(ms);
			}

			const dropKey = findKey(drops, method, url.pathname);
			if (dropKey !== undefined) {
				const left = (drops.get(dropKey) ?? 0) - 1;
				if (left <= 0) drops.delete(dropKey);
				else drops.set(dropKey, left);
				return new Response(droppedBody(), { status: 200 });
			}

			const failureKey = findKey(failures, method, url.pathname);
			if (failureKey !== undefined) {
				const queue = failures.get(failureKey);
				const next = queue?.shift();
				if (queue !== undefined && queue.length === 0) failures.delete(failureKey);
				if (next !== undefined) {
					return new Response(next.body, {
						status: next.status,
						headers: { "content-type": "application/json" },
					});
				}
			}

			const handlerKey = findKey(handlers, method, url.pathname);
			if (handlerKey !== undefined) {
				const replay = new Request(request.url, {
					method,
					headers: request.headers,
					...(body === "" ? {} : { body }),
				});
				const answer = await handlers.get(handlerKey)?.(replay, url);
				if (answer !== undefined) return answer;
			}

			/*
			 * `redirect: "manual"` is load-bearing: the identity double answers the
			 * sign-in start with a 302 the Worker must see. A following fetch would
			 * chase it and hand the Worker the wrong response entirely.
			 * `accept-encoding: identity` keeps the body uncompressed so the headers
			 * copied back cannot describe an encoding the body no longer carries.
			 */
			const forwarded = Object.fromEntries(
				Object.entries(headers).filter(
					([key]) => key !== "host" && key !== "content-length" && key !== "accept-encoding",
				),
			);
			const upstreamResponse = await fetch(`http://127.0.0.1:${upstream}${url.pathname}${url.search}`, {
				method,
				redirect: "manual",
				headers: { ...forwarded, "accept-encoding": "identity" },
				...(body === "" ? {} : { body }),
			});
			const out = new Headers(upstreamResponse.headers);
			out.delete("content-encoding");
			out.delete("content-length");
			return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers: out });
		},
	});

	return {
		name,
		port: server.port ?? 0,
		url: `http://127.0.0.1:${server.port ?? 0}`,
		handle: (method, path, handler) => void handlers.set(`${method.toUpperCase()} ${path}`, handler),
		failOnce: (method, path, status, body = '{"status":"error","message":"e2e front fault"}') => {
			const key = `${method.toUpperCase()} ${path}`;
			const queue = failures.get(key) ?? [];
			queue.push({ status, body });
			failures.set(key, queue);
		},
		dropOnce: (method, path) => {
			const key = `${method.toUpperCase()} ${path}`;
			drops.set(key, (drops.get(key) ?? 0) + 1);
		},
		delay: (path, ms) => {
			if (ms <= 0) delays.delete(path);
			else delays.set(path, ms);
		},
		requests: () => recorded,
		setUpstream: (port) => void (upstream = port),
		clear: () => {
			handlers.clear();
			failures.clear();
			drops.clear();
			delays.clear();
			recorded.length = 0;
		},
		stop: () => void server.stop(true),
	};
};
