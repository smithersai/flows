import { describe, expect, test } from "bun:test";
import worker from "./index";
import type { WorkerEnv } from "./index";
import { appendClientError, CLIENT_ERROR_LOG_LIMIT, ClientErrorLog, readClientErrors } from "./clientErrorLog";
import type { ClientErrorNamespace, ClientErrorStorage } from "./clientErrorLog";

/*
 * What broke in a user's browser has to survive longer than a `wrangler tail`.
 * These tests hold the log to being readable afterwards, bounded, and never
 * able to fail the report it is recording.
 */

const memoryStorage = (): ClientErrorStorage => {
	const data = new Map<string, unknown>();
	return {
		get: async (key) => data.get(key) as never,
		put: async (key, value) => void data.set(key, value),
	};
};

const memoryLog = (): ClientErrorNamespace & { readonly names: () => Array<string> } => {
	const logs = new Map<string, ClientErrorLog>();
	return {
		names: () => [...logs.keys()],
		idFromName: (name) => name,
		get: (id) => {
			const name = String(id);
			let log = logs.get(name);
			if (log === undefined) {
				log = new ClientErrorLog({ storage: memoryStorage() });
				logs.set(name, log);
			}
			return { fetch: (request) => log.fetch(request) };
		},
	};
};

const adminEnv = (logs?: ClientErrorNamespace): WorkerEnv => ({
	ASSETS: { fetch: async () => new Response("<html></html>", { status: 200 }) },
	IDENTITY_UPSTREAM_URL: "https://identity.test",
	...(logs === undefined ? {} : { CLIENT_ERRORS: logs }),
});

const withIdentity = async (
	session: { readonly login: string; readonly admin: boolean } | undefined,
	run: () => Promise<void>,
): Promise<void> => {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const request = typeof input === "string" ? new Request(input, init) : (input as Request);
		if (new URL(request.url).hostname === "identity.test") {
			return session === undefined
				? new Response("{}", { status: 401 })
				: new Response(JSON.stringify({ ...session, allowlisted: true }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
		}
		return new Response("{}", { status: 200 });
	}) as typeof fetch;
	try {
		await run();
	} finally {
		globalThis.fetch = original;
	}
};

const report = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
	new Request(`https://mvp.test${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

describe("the client-error log (Durable Object state)", () => {
	test("keeps reports newest first", async () => {
		const logs = memoryLog();
		await appendClientError(logs, { at: "2026-08-18T00:00:00.000Z", report: { message: "first" } });
		await appendClientError(logs, { at: "2026-08-18T00:00:01.000Z", report: { message: "second" } });
		const read = await readClientErrors(logs);
		expect(read.total).toBe(2);
		expect(read.reports.map((row) => (row.report as { message: string }).message)).toEqual(["second", "first"]);
	});

	test("is bounded: an error storm evicts the oldest, never the newest", async () => {
		const logs = memoryLog();
		for (let index = 0; index < CLIENT_ERROR_LOG_LIMIT + 25; index += 1) {
			await appendClientError(logs, { at: new Date(index).toISOString(), report: { index } });
		}
		const read = await readClientErrors(logs);
		expect(read.total).toBe(CLIENT_ERROR_LOG_LIMIT);
		expect((read.reports[0]?.report as { index: number }).index).toBe(CLIENT_ERROR_LOG_LIMIT + 24);
	});

	test("a limit trims the read and never exceeds what is kept", async () => {
		const logs = memoryLog();
		for (let index = 0; index < 10; index += 1) {
			await appendClientError(logs, { at: new Date(index).toISOString(), report: { index } });
		}
		expect((await readClientErrors(logs, 3)).reports).toHaveLength(3);
		expect((await readClientErrors(logs, 10_000)).reports).toHaveLength(10);
	});

	test("with no namespace bound, appending is a no-op and the read is honestly empty", async () => {
		await appendClientError(undefined, { at: "2026-08-18T00:00:00.000Z", report: {} });
		expect(await readClientErrors(undefined)).toEqual({ total: 0, reports: [] });
	});

	test("a failing log never fails the report", async () => {
		const broken: ClientErrorNamespace = {
			idFromName: (name) => name,
			get: () => ({
				fetch: async () => {
					throw new Error("durable object unavailable");
				},
			}),
		};
		await appendClientError(broken, { at: "2026-08-18T00:00:00.000Z", report: {} });
	});
});

describe("the client-error route and its admin read", () => {
	test("a posted error is stored with when it arrived, the page, and the agent", async () => {
		const logs = memoryLog();
		const env = adminEnv(logs);
		const response = await worker.fetch(
			report(
				"/api/client-errors",
				{ message: "Cannot read properties of undefined", stack: "at App" },
				{ referer: "https://canary.smithers.sh/", "user-agent": "TestBrowser/1.0" },
			),
			env,
		);
		expect(response.status).toBe(202);
		const stored = await readClientErrors(logs);
		expect(stored.total).toBe(1);
		expect(stored.reports[0]?.page).toBe("https://canary.smithers.sh/");
		expect(stored.reports[0]?.userAgent).toBe("TestBrowser/1.0");
		expect((stored.reports[0]?.report as { message: string }).message).toBe(
			"Cannot read properties of undefined",
		);
		expect(Date.parse(stored.reports[0]?.at ?? "")).toBeGreaterThan(0);
	});

	test("a report that is not JSON is kept verbatim rather than dropped", async () => {
		const logs = memoryLog();
		const response = await worker.fetch(
			new Request("https://mvp.test/api/client-errors", { method: "POST", body: "boom, not json" }),
			adminEnv(logs),
		);
		expect(response.status).toBe(202);
		expect((await readClientErrors(logs)).reports[0]?.report).toBe("boom, not json");
	});

	test("every deployment writes to one log, so any request finds every report", async () => {
		const logs = memoryLog();
		await worker.fetch(report("/api/client-errors", { message: "a" }), adminEnv(logs));
		await worker.fetch(report("/api/client-errors", { message: "b" }), adminEnv(logs));
		expect(logs.names()).toEqual(["client-errors"]);
	});

	test("the admin read answers the log, newest first", async () => {
		const logs = memoryLog();
		const env = adminEnv(logs);
		await withIdentity({ login: "will", admin: true }, async () => {
			await worker.fetch(report("/api/client-errors", { message: "older" }), env);
			await worker.fetch(report("/api/client-errors", { message: "newer" }), env);
			const response = await worker.fetch(
				new Request("https://mvp.test/api/admin/errors", { headers: { cookie: "smithers_session=abc" } }),
				env,
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				total: number;
				reports: Array<{ report: { message: string } }>;
			};
			expect(body.total).toBe(2);
			expect(body.reports.map((row) => row.report.message)).toEqual(["newer", "older"]);
		});
	});

	test("a non-admin gets the canonical unknown-route 404, never a 403", async () => {
		const env = adminEnv(memoryLog());
		await withIdentity({ login: "someone", admin: false }, async () => {
			const response = await worker.fetch(
				new Request("https://mvp.test/api/admin/errors", { headers: { cookie: "smithers_session=abc" } }),
				env,
			);
			expect(response.status).toBe(404);
			const unknown = await worker.fetch(
				new Request("https://mvp.test/api/definitely-not-a-route", {
					headers: { cookie: "smithers_session=abc" },
				}),
				env,
			);
			expect(await response.text()).toBe(await unknown.text());
		});
	});

	test("an anonymous read is the same 404", async () => {
		const env = adminEnv(memoryLog());
		await withIdentity(undefined, async () => {
			const response = await worker.fetch(new Request("https://mvp.test/api/admin/errors"), env);
			expect(response.status).toBe(404);
		});
	});

	test("with no log bound the admin read says so instead of implying nothing broke", async () => {
		const env = adminEnv();
		await withIdentity({ login: "will", admin: true }, async () => {
			const response = await worker.fetch(
				new Request("https://mvp.test/api/admin/errors", { headers: { cookie: "smithers_session=abc" } }),
				env,
			);
			const body = (await response.json()) as { total: number; note?: string };
			expect(body.total).toBe(0);
			expect(body.note).toContain("nothing is stored");
		});
	});
});
