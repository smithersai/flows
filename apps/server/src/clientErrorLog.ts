/**
 * A readable record of what broke in a user's browser.
 *
 * The client already posts its errors to `/api/client-errors`. Until now the
 * handler ran `console.error` and stopped, which means the report survived only
 * as long as someone happened to be running `wrangler tail`. During a private
 * alpha that is the same as having no report at all: the first anyone learns of
 * a broken flow is the user mentioning it, if they bother.
 *
 * So the last reports are kept in one Durable Object — a ring buffer, newest
 * first — and read back through `GET /api/admin/errors`, behind the same admin
 * validation as every other admin route. Deliberately not a log service: no new
 * vendor, no new secret, no egress, and it is bounded, so it cannot grow into a
 * cost of its own.
 *
 * What is stored is what the page sent plus when it arrived, the URL it came
 * from, and the user agent. No session lookup: identifying the reporter would
 * mean an identity round-trip on a route that must stay cheap enough to absorb
 * an error storm, and the report itself is what needs reading.
 */

/** Reports kept. At the route's own ceiling of 120/minute this is a couple of minutes of a storm. */
export const CLIENT_ERROR_LOG_LIMIT = 200;

/**
 * The whole log lives under one Durable Object storage key, and a stored value
 * may not exceed 128 KiB. The route accepts a report of up to 16 KiB, so a
 * count alone is not a bound: two hundred large ones would be megabytes, the
 * `put` would throw, and — because appending must never fail the report — the
 * throw would be swallowed and the log would silently stop recording. Which is
 * the exact failure this module exists to end.
 *
 * So the real constraint is bytes. The budget is set well under the limit to
 * leave room for the key and the store's own framing.
 */
export const CLIENT_ERROR_LOG_MAX_BYTES = 96 * 1024;

/**
 * The most one report may occupy. A stack trace is worth keeping and a 16 KiB
 * blob is not worth evicting fifty other reports for, so an oversized one is
 * truncated rather than dropped: what broke is usually in the first lines.
 */
export const CLIENT_ERROR_RECORD_MAX_BYTES = 4 * 1024;

export interface ClientErrorStorage {
	readonly get: <T>(key: string) => Promise<T | undefined>;
	readonly put: (key: string, value: unknown) => Promise<void>;
}

export interface ClientErrorStub {
	readonly fetch: (request: Request) => Promise<Response>;
}

export interface ClientErrorNamespace {
	readonly idFromName: (name: string) => unknown;
	readonly get: (id: unknown) => ClientErrorStub;
}

export interface ClientErrorRecord {
	/** When the Worker received it, ISO 8601. */
	readonly at: string;
	/** The page that reported, when the request carried a referer. */
	readonly page?: string;
	readonly userAgent?: string;
	/** Exactly what the client posted, parsed when it was JSON and raw text when it was not. */
	readonly report: unknown;
}

const LOG_KEY = "reports";

const sizeOf = (value: unknown): number => JSON.stringify(value)?.length ?? 0;

/** One report, cut to its byte budget. The truncation is stated, never silent. */
export const capRecord = (record: ClientErrorRecord): ClientErrorRecord => {
	if (sizeOf(record) <= CLIENT_ERROR_RECORD_MAX_BYTES) return record;
	const text = typeof record.report === "string" ? record.report : JSON.stringify(record.report) ?? "";
	// Leave room for the surrounding fields and the note.
	const room = Math.max(0, CLIENT_ERROR_RECORD_MAX_BYTES - sizeOf({ ...record, report: "" }) - 40);
	return { ...record, report: `${text.slice(0, room)}… [truncated from ${text.length} characters]` };
};

/** The newest reports that fit, both bounds enforced: count and bytes. */
export const bounded = (records: ReadonlyArray<ClientErrorRecord>): Array<ClientErrorRecord> => {
	const kept = records.slice(0, CLIENT_ERROR_LOG_LIMIT);
	while (kept.length > 1 && sizeOf(kept) > CLIENT_ERROR_LOG_MAX_BYTES) kept.pop();
	return kept;
};

/** Every deployment shares one log; the name is fixed so any request finds it. */
export const CLIENT_ERROR_LOG_NAME = "client-errors";

export class ClientErrorLog {
	constructor(private readonly ctx: { readonly storage: ClientErrorStorage }) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const stored = (await this.ctx.storage.get<ReadonlyArray<ClientErrorRecord>>(LOG_KEY)) ?? [];
		switch (url.pathname) {
			case "/append": {
				const record = (await request.json().catch(() => undefined)) as ClientErrorRecord | undefined;
				if (record === undefined) return new Response("bad record", { status: 400 });
				// Newest first, oldest evicted: a storm never buries the report
				// that is being read right now.
				const next = bounded([capRecord(record), ...stored]);
				await this.ctx.storage.put(LOG_KEY, next);
				return new Response(JSON.stringify({ status: "ok", kept: next.length }), {
					headers: { "content-type": "application/json" },
				});
			}
			case "/read": {
				const asked = Number(url.searchParams.get("limit") ?? CLIENT_ERROR_LOG_LIMIT);
				const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, CLIENT_ERROR_LOG_LIMIT) : CLIENT_ERROR_LOG_LIMIT;
				return new Response(
					JSON.stringify({ status: "ok", total: stored.length, reports: stored.slice(0, limit) }),
					{ headers: { "content-type": "application/json" } },
				);
			}
			default:
				return new Response("not found", { status: 404 });
		}
	}
}

/**
 * Record one report. Never throws and never blocks the answer to the client:
 * a browser that just hit an error is not helped by the report failing too.
 * With no namespace bound (local dev, the stub stack) this is a no-op and the
 * handler's `console.error` remains the only trace, as it always was.
 */
export const appendClientError = async (
	logs: ClientErrorNamespace | undefined,
    record: ClientErrorRecord,
): Promise<void> => {
	if (logs === undefined) return;
	const stub = logs.get(logs.idFromName(CLIENT_ERROR_LOG_NAME));
	await stub
		.fetch(new Request("https://client-errors.internal/append", { method: "POST", body: JSON.stringify(record) }))
		.catch(() => undefined);
};

/** The stored reports, newest first. */
export const readClientErrors = async (
	logs: ClientErrorNamespace | undefined,
	limit?: number,
): Promise<{ readonly total: number; readonly reports: ReadonlyArray<ClientErrorRecord> }> => {
	if (logs === undefined) return { total: 0, reports: [] };
	const stub = logs.get(logs.idFromName(CLIENT_ERROR_LOG_NAME));
	const query = limit === undefined ? "" : `?limit=${limit}`;
	const response = await stub.fetch(new Request(`https://client-errors.internal/read${query}`));
	const body = (await response.json().catch(() => undefined)) as
		| { readonly total: number; readonly reports: ReadonlyArray<ClientErrorRecord> }
		| undefined;
	return body ?? { total: 0, reports: [] };
};
