import { describe, expect, test } from "bun:test";
import worker from "./index";
import type { WorkerEnv } from "./index";
import {
	spendTurn,
	TURN_WINDOW_MAX,
	TURN_WINDOW_MS,
	TurnRateLimiter,
	turnLimitResponse,
} from "./turnLimit";
import type { TurnBudget, TurnLimitNamespace, TurnLimitStorage } from "./turnLimit";

/*
 * The per-login turn ceiling. Chat is comped during the alpha, so the balance
 * is not a spend limit and nothing else bounds what one session can cost. These
 * tests hold the ceiling to being an ABUSE guard: it must be invisible to a
 * person, it must not read like a paywall when it does fire, and it must never
 * lock someone out because our own infrastructure hiccuped.
 */

const memoryStorage = (seed?: Record<string, unknown>): TurnLimitStorage => {
	const data = new Map<string, unknown>(Object.entries(seed ?? {}));
	return {
		get: async (key) => data.get(key) as never,
		put: async (key, value) => void data.set(key, value),
	};
};

const memoryLimits = (): TurnLimitNamespace & { readonly logins: () => Array<string> } => {
	const buckets = new Map<string, TurnRateLimiter>();
	return {
		logins: () => [...buckets.keys()],
		idFromName: (name) => name,
		get: (id) => {
			const name = String(id);
			let bucket = buckets.get(name);
			if (bucket === undefined) {
				bucket = new TurnRateLimiter({ storage: memoryStorage() });
				buckets.set(name, bucket);
			}
			return { fetch: (request) => bucket.fetch(request) };
		},
	};
};

const spend = async (limiter: TurnRateLimiter): Promise<TurnBudget> => {
	const response = await limiter.fetch(new Request("https://turn-limit.internal/spend", { method: "POST" }));
	return (await response.json()) as TurnBudget;
};

describe("the per-login turn ceiling (Durable Object state)", () => {
	test("admits every turn up to the ceiling and counts down honestly", async () => {
		const limiter = new TurnRateLimiter({ storage: memoryStorage() });
		const first = await spend(limiter);
		expect(first.allowed).toBe(true);
		expect(first.remaining).toBe(TURN_WINDOW_MAX - 1);

		for (let turn = 2; turn <= TURN_WINDOW_MAX; turn += 1) {
			const budget = await spend(limiter);
			expect(budget.allowed).toBe(true);
			expect(budget.remaining).toBe(TURN_WINDOW_MAX - turn);
		}
		const over = await spend(limiter);
		expect(over.allowed).toBe(false);
		expect(over.remaining).toBe(0);
		expect(typeof over.retryAt).toBe("number");
	});

	test("a refused turn does not push its own reset further away", async () => {
		const opened = Date.now() - 30 * 60 * 1000;
		const storage = memoryStorage({ window: { start: opened, count: TURN_WINDOW_MAX } });
		const limiter = new TurnRateLimiter({ storage });
		const first = await spend(limiter);
		const second = await spend(limiter);
		expect(first.allowed).toBe(false);
		expect(second.retryAt).toBe(first.retryAt);
		expect(first.retryAt).toBe(opened + TURN_WINDOW_MS);
	});

	test("a window older than the budget period starts a fresh one", async () => {
		const storage = memoryStorage({
			window: { start: Date.now() - TURN_WINDOW_MS - 1, count: TURN_WINDOW_MAX },
		});
		const budget = await spend(new TurnRateLimiter({ storage }));
		expect(budget.allowed).toBe(true);
		expect(budget.remaining).toBe(TURN_WINDOW_MAX - 1);
	});

	test("peek reports the state without spending anything", async () => {
		const limiter = new TurnRateLimiter({ storage: memoryStorage() });
		await spend(limiter);
		const peek = async (): Promise<TurnBudget> =>
			(await (await limiter.fetch(new Request("https://turn-limit.internal/peek"))).json()) as TurnBudget;
		expect((await peek()).remaining).toBe(TURN_WINDOW_MAX - 1);
		expect((await peek()).remaining).toBe(TURN_WINDOW_MAX - 1);
	});

	test("with no namespace bound the ceiling fails open", async () => {
		const budget = await spendTurn(undefined, "will");
		expect(budget.allowed).toBe(true);
	});

	test("an unreadable answer from our own Durable Object admits the turn", async () => {
		const broken: TurnLimitNamespace = {
			idFromName: (name) => name,
			get: () => ({ fetch: async () => new Response("not json at all", { status: 500 }) }),
		};
		expect((await spendTurn(broken, "will")).allowed).toBe(true);
	});

	test("each login has its own budget", async () => {
		const limits = memoryLimits();
		for (let turn = 0; turn < TURN_WINDOW_MAX; turn += 1) await spendTurn(limits, "will");
		expect((await spendTurn(limits, "will")).allowed).toBe(false);
		expect((await spendTurn(limits, "someone-else")).allowed).toBe(true);
	});

	test("the refusal reads as a bug report, not a bill", () => {
		const response = turnLimitResponse({ allowed: false, remaining: 0, retryAt: Date.now() + 600_000 }, {});
		expect(response.status).toBe(429);
		expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
	});

	test("the refusal never sends the user to billing", async () => {
		const response = turnLimitResponse({ allowed: false, remaining: 0, retryAt: Date.now() + 600_000 }, {});
		const body = (await response.json()) as { message: string; code: string };
		expect(body.code).toBe("turn_rate_limited");
		expect(body.message).toContain("looping");
		expect(body.message).toContain("balance is untouched");
		for (const word of ["upgrade", "billing", "pay", "plan", "$"]) {
			expect(body.message.toLowerCase()).not.toContain(word);
		}
	});
});

/*
 * The routes. A ceiling that let the upstream call happen first would not save
 * a dollar, so what matters is that a refusal costs nothing beyond one
 * Durable Object read.
 */
describe("the turn routes under the ceiling", () => {
	const identityEnv = (limits: TurnLimitNamespace): WorkerEnv => ({
		ASSETS: { fetch: async () => new Response("<html></html>", { status: 200 }) },
		IDENTITY_UPSTREAM_URL: "https://identity.test",
		SMITHERS_CHAT_URL: "https://upstream.test/chat",
		TURN_LIMITS: limits,
	});

	const signedIn = (path: string, runId: string): Request =>
		new Request(`https://mvp.test${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie: "smithers_session=abc" },
			body: JSON.stringify({ runId, messages: [{ role: "user", content: "hi" }], instructions: "Be brief." }),
		});

	const withStubbedSeams = async (run: (upstreamCalls: () => number) => Promise<void>): Promise<void> => {
		const original = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			const request = typeof input === "string" ? new Request(input, init) : (input as Request);
			if (new URL(request.url).hostname === "identity.test") {
				return new Response(JSON.stringify({ login: "will", allowlisted: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			calls += 1;
			return new Response('{"type":"done"}\n', { status: 200, headers: { "content-type": "application/x-ndjson" } });
		}) as typeof fetch;
		try {
			await run(() => calls);
		} finally {
			globalThis.fetch = original;
		}
	};

	test("a spent budget refuses the turn with 429 before any credential is spent", async () => {
		// A run id may be registered only once; the in-isolate cancel registry is
		// module state, so each test gets its own namespace.
		const lane = "spent-budget";
		const limits = memoryLimits();
		const env = identityEnv(limits);
		await withStubbedSeams(async (upstreamCalls) => {
			for (let turn = 0; turn < TURN_WINDOW_MAX; turn += 1) {
				const ok = await worker.fetch(signedIn("/api/agent/turn", `${lane}-${turn}`), env);
				expect(ok.status).toBe(200);
			}
			const spentBefore = upstreamCalls();
			const refused = await worker.fetch(signedIn("/api/agent/turn", `${lane}-over`), env);
			expect(refused.status).toBe(429);
			expect(upstreamCalls()).toBe(spentBefore);
			expect(refused.headers.get("retry-after")).not.toBeNull();
		});
	});

	test("the model-stream route shares the same budget", async () => {
		// A run id may be registered only once; the in-isolate cancel registry is
		// module state, so each test gets its own namespace.
		const lane = "model-stream";
		const limits = memoryLimits();
		const env = identityEnv(limits);
		await withStubbedSeams(async () => {
			for (let turn = 0; turn < TURN_WINDOW_MAX; turn += 1) {
				await worker.fetch(signedIn("/api/agent/turn", `${lane}-${turn}`), env);
			}
			const refused = await worker.fetch(signedIn("/api/model/stream", `${lane}-stream`), env);
			expect(refused.status).toBe(429);
		});
	});

	test("the budget is keyed by the validated login, never by anything a client sends", async () => {
		// A run id may be registered only once; the in-isolate cancel registry is
		// module state, so each test gets its own namespace.
		const lane = "keyed-by-login";
		const limits = memoryLimits();
		const env = identityEnv(limits);
		await withStubbedSeams(async () => {
			await worker.fetch(signedIn("/api/agent/turn", `${lane}-1`), env);
		});
		expect(limits.logins()).toEqual(["will"]);
	});

	test("killing a turn is never rate limited", async () => {
		// A run id may be registered only once; the in-isolate cancel registry is
		// module state, so each test gets its own namespace.
		const lane = "cancel-unlimited";
		const limits = memoryLimits();
		const env = identityEnv(limits);
		await withStubbedSeams(async () => {
			for (let turn = 0; turn < TURN_WINDOW_MAX; turn += 1) {
				await worker.fetch(signedIn("/api/agent/turn", `${lane}-${turn}`), env);
			}
			const cancel = await worker.fetch(signedIn("/api/agent/turn/cancel", `${lane}-1`), env);
			expect(cancel.status).not.toBe(429);
		});
	});

	test("an ordinary hour of chat never reaches the ceiling", async () => {
		// The guard is worthless if it fires on a real person. Sixty turns is a
		// heavy hour of conversation; the ceiling sits at twice that.
		// A run id may be registered only once; the in-isolate cancel registry is
		// module state, so each test gets its own namespace.
		const lane = "ordinary-hour";
		const limits = memoryLimits();
		const env = identityEnv(limits);
		await withStubbedSeams(async () => {
			for (let turn = 0; turn < 60; turn += 1) {
				const response = await worker.fetch(signedIn("/api/agent/turn", `${lane}-${turn}`), env);
				expect(response.status).toBe(200);
			}
		});
	});
});
