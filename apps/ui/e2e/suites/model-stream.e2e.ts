/*
 * E3.13 — /api/model/stream is session-gated and actually streams.
 * E3.14 — /api/tools/browser-fetch refuses unsafe targets.
 *
 * Both routes already have server unit tests (apps/server/src/ModelStream.test.ts,
 * apps/server/src/index.test.ts "the browser tool route"). Those tests call
 * worker.fetch() in bun with globalThis.fetch patched, so four things stay
 * unproven there and are what this suite adds:
 *
 * 1. The session gate with a REAL identity seam. The unit tests either leave
 *    IDENTITY_UPSTREAM_URL unset or patch fetch to answer 401 unconditionally,
 *    so neither ever mints a session and neither ever proves the signed-in path
 *    through the gate.
 * 2. The gate runs BEFORE the upstream call. The relay double records every
 *    request it receives, so an anonymous refusal that still forwarded would be
 *    visible here as a recorded call. That is the assertion that a re-ordering
 *    of the router turns red — spend, not just status.
 * 3. The provider's SSE crossing a real socket inside workerd. The unit test
 *    answers from a patched fetch in the same process, so it never exercises
 *    workerd's body plumbing, the no-store directive, or byte-for-byte
 *    passthrough over the wire.
 * 4. The client halves: the product's own relay author seat (layerAuthor, the
 *    @smthrs/model Anthropic wire) decodes a provider stream that travelled
 *    through the deployed Worker, and AppController.openBrowser surfaces the
 *    SSRF guard's own sentence on a browser card instead of a fabricated read.
 *
 * Not covered here, and worth naming: the ABSENCE of buffering on the relay.
 * The provider double answers with a complete body, so a Worker that read the
 * upstream to the end and re-wrapped it would be indistinguishable from here —
 * content-length and all. Proving that needs a double that can pause mid-body;
 * the note against e2e/ModelRelay.ts asks for one.
 *
 * Not covered here, deliberately: the "answers safe ones" half of E3.14. A safe
 * read requires https to a public host with a valid certificate, resolved
 * through the live DNS-over-HTTPS resolver (BrowserFetch.resolveHostOverHttps).
 * No local double can satisfy that without weakening the guard. This suite
 * instead proves the guard is targeted rather than blanket: a public IP literal
 * passes every pre-DNS check and fails at the read, which is the assertion a
 * "refuse everything" regression trips.
 */
import { Effect } from "effect";
import { Author } from "@smthrs/chain";
import type { Card } from "smithers-shared/Cards";
import { MODEL_STREAM_PATH, TOOLS_BROWSER_FETCH_PATH } from "smithers-shared/AgentApiRoutes";
import type { FetchLike } from "smithers-shared/NativeAgent";
import { DEFAULT_MODEL_ID, layerAuthor } from "../../src/mainview/chain/StreamModel.ts";
import { openClient } from "../Client.ts";
import { MODEL_RELAY_KEY } from "../ModelRelay.ts";
import { defineSuite } from "../Suite.ts";

/** What the browser's model seat sends as its x-api-key (src/mainview/chain/StreamModel.ts). */
const PLACEHOLDER_KEY = "browser-relay-placeholder";

/*
 * The scripted answer arrives as two text deltas. Splitting the proof string
 * across two SSE events means a Worker that re-serialized or re-chunked the
 * provider stream would hand the author seat something other than the whole
 * string back.
 */
const PROOF_HEAD = "relay-stream-";
const PROOF_TAIL = "proof-8805";
const PROOF_TEXT = `${PROOF_HEAD}${PROOF_TAIL}`;

const relayScript = (): ReadonlyArray<string> => [
	"event: message_start",
	`data: ${JSON.stringify({
		type: "message_start",
		message: {
			id: "msg_e2e_relay",
			type: "message",
			role: "assistant",
			model: DEFAULT_MODEL_ID,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 7, output_tokens: 0 },
		},
	})}`,
	"",
	"event: content_block_start",
	`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
	"",
	...[PROOF_HEAD, PROOF_TAIL].flatMap((chunk) => [
		"event: content_block_delta",
		`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } })}`,
		"",
	]),
	"event: content_block_stop",
	`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
	"",
	"event: message_delta",
	`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } })}`,
	"",
	"event: message_stop",
	`data: ${JSON.stringify({ type: "message_stop" })}`,
	"",
];

/** The sealed author call the browser makes, minus the credential the Worker replaces. */
const authorBody = (extra: Record<string, unknown> = {}): string =>
	JSON.stringify({
		model: DEFAULT_MODEL_ID,
		stream: true,
		max_tokens: 64,
		messages: [{ role: "user", content: "hello" }],
		...extra,
	});

const relayHeaders = (cookie?: string): Record<string, string> => ({
	"content-type": "application/json",
	"anthropic-version": "2023-06-01",
	// The browser really does send this placeholder; it must die at the boundary.
	"x-api-key": PLACEHOLDER_KEY,
	...(cookie === undefined ? {} : { cookie }),
});

/** apps/shared/src/BrowserFetch.ts guardTarget — the refusal sentence per unsafe target. */
const HTTPS_ONLY = "Only https:// pages can be read.";
const PRIVATE_HOST = "That address points at a private host, which the browser tool never reads.";

const UNSAFE_TARGETS: ReadonlyArray<readonly [string, string]> = [
	["http://example.com/", HTTPS_ONLY],
	["https://localhost/", PRIVATE_HOST],
	["https://127.0.0.1/", PRIVATE_HOST],
	["https://[::1]/", PRIVATE_HOST],
	// The cloud metadata endpoint — the SSRF target that actually matters.
	["https://169.254.169.254/latest/meta-data/", PRIVATE_HOST],
	["https://10.0.0.5/admin", PRIVATE_HOST],
	["https://db.internal/", PRIVATE_HOST],
	["https://gateway.lan/", PRIVATE_HOST],
];

const isBrowserCard = (card: Card): card is Extract<Card, { kind: "browser" }> => card.kind === "browser";

/**
 * `wrangler dev` restarts the Worker when it reloads, and it reloads on its own
 * whenever a concurrent lane takes the fixed inspector port (9229) out from
 * under it. A request in flight across a restart either answers 503 "Your
 * worker restarted mid-request" or has its socket closed. Neither is the
 * route's answer, so the request is sent again. Every other status is returned
 * exactly as it came, including a real 503.
 *
 * The public-literal probe below holds one request open for the browser tool's
 * full 10s timeout, which is the window a restart is most likely to land in.
 */
const RESTARTED = "restarted mid-request";
const POST_ATTEMPTS = 4;

interface JsonAnswer {
	readonly status: number;
	readonly message: string | undefined;
	readonly errorStatus: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const postJson = async (url: string, headers: Record<string, string>, body: unknown): Promise<JsonAnswer> => {
	let lastError: unknown;
	for (let attempt = 0; attempt < POST_ATTEMPTS; attempt += 1) {
		let response: Response;
		try {
			response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		} catch (error) {
			// The Worker went away mid-request; give it a moment to come back.
			lastError = error;
			await sleep(1_000);
			continue;
		}
		const text = await response.text();
		if (response.status === 503 && text.includes(RESTARTED) && attempt + 1 < POST_ATTEMPTS) {
			await sleep(500);
			continue;
		}
		let parsed: { status?: unknown; message?: unknown } = {};
		try {
			parsed = JSON.parse(text) as { status?: unknown; message?: unknown };
		} catch {
			// A non-JSON body is reported through `message` so the failure text carries it.
			parsed = { message: text.slice(0, 300) };
		}
		return {
			status: response.status,
			message: typeof parsed.message === "string" ? parsed.message : undefined,
			errorStatus: parsed.status,
		};
	}
	throw lastError instanceof Error
		? lastError
		: new Error(`POST ${url} never completed in ${POST_ATTEMPTS} attempts.`);
};

const JSON_HEADERS = { "content-type": "application/json" } as const;

export default defineSuite({
	id: "E3.13+E3.14",
	title: "the model relay is session-gated, streams, and hides the deployment key; the browser tool refuses unsafe targets",
	run: async ({ origin, stack, report }) => {
		const cookie = await stack.signedInCookie();
		stack.modelRelay.script(relayScript());

		/*
		 * E3.13, gate. The body is deliberately invalid for the relay (no model,
		 * and tools present). A router that gated after validation would answer
		 * 400; a router that forwarded first would leave a recorded relay call.
		 */
		const anonymous = await postJson(`${origin}${MODEL_STREAM_PATH}`, relayHeaders(), {
			tools: [{ name: "bash" }],
		});
		report.equals(anonymous.status, 401, `the anonymous relay call answered ${anonymous.message ?? "nothing"}`);
		report.equals(anonymous.message, "Sign in to run a Smithers turn.", "the anonymous relay refusal");
		report.equals(
			stack.modelRelay.requests().length,
			0,
			"the anonymous relay call reached the provider anyway — the session gate runs after the forward",
		);
		report.ok("an anonymous /api/model/stream call is refused before the provider is called at all.");

		/* E3.13, the signed-in stream. */
		const relay = await fetch(`${origin}${MODEL_STREAM_PATH}`, {
			method: "POST",
			headers: relayHeaders(cookie),
			body: authorBody(),
		});
		report.equals(relay.status, 200, "the signed-in relay call");
		report.includes(
			relay.headers.get("content-type") ?? "",
			"text/event-stream",
			"the relay answered the wrong content type",
		);
		report.equals(relay.headers.get("cache-control"), "no-store", "the relay response cache directive");
		report.equals(
			relay.headers.get("content-encoding"),
			null,
			"the relay re-encoded the provider stream instead of passing the bytes through",
		);

		/*
		 * What the read below proves: the Worker hands back a readable body and
		 * every provider byte survives the crossing, in order. What it does NOT
		 * prove is the absence of buffering — the provider double answers with a
		 * complete body, so a Worker that awaited response.text() and re-wrapped
		 * it would look identical from here, content-length included. Proving
		 * that needs a relay double that can pause mid-body; see the note filed
		 * against e2e/ModelRelay.ts.
		 */
		const stream = relay.body;
		report.check(stream !== null, "the relay answered 200 with no body to read.");
		const reader = (stream as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		const chunks: Array<string> = [];
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			if (next.value !== undefined) chunks.push(decoder.decode(next.value, { stream: true }));
		}
		const streamed = chunks.join("");
		report.includes(streamed, "message_start", "the relay stream lost the provider's opening event");
		report.includes(streamed, PROOF_HEAD, "the relay stream lost the first scripted delta");
		report.includes(streamed, PROOF_TAIL, "the relay stream lost the second scripted delta");
		report.check(
			streamed.indexOf(PROOF_HEAD) < streamed.indexOf(PROOF_TAIL),
			"the relay stream delivered the scripted deltas out of order",
		);
		report.includes(streamed, "message_stop", "the relay stream never terminated the provider message");
		report.ok(
			`the signed-in relay hands back the provider's SSE verbatim and in order, no-store, in ${chunks.length} chunk(s).`,
		);

		/* E3.13, the credential boundary. */
		const forwarded = stack.modelRelay.requests();
		report.equals(forwarded.length, 1, "the relay double recorded the wrong number of provider calls");
		const sent = forwarded[0];
		report.equals(sent?.headers["x-api-key"], MODEL_RELAY_KEY, "the Worker did not inject the deployment key");
		report.check(
			sent?.headers["x-api-key"] !== PLACEHOLDER_KEY,
			"the browser's placeholder credential survived the relay boundary",
		);
		report.equals(sent?.headers["cookie"], undefined, "the caller's session cookie was forwarded to the provider");
		report.equals(
			sent?.headers["anthropic-version"],
			"2023-06-01",
			"the relay dropped the caller's anthropic-version",
		);
		report.ok("the Worker forwards the deployment key and forwards neither the placeholder key nor the session cookie.");

		/*
		 * E3.13, the sealed-step law through the real router. A signed-in caller
		 * gets the 400, and no provider call is spent on it.
		 */
		const withTools = await postJson(`${origin}${MODEL_STREAM_PATH}`, relayHeaders(cookie), {
			model: DEFAULT_MODEL_ID,
			stream: true,
			messages: [{ role: "user", content: "hello" }],
			tools: [{ name: "bash" }],
		});
		report.equals(withTools.status, 400, `the tool-bearing relay call answered ${withTools.message ?? "nothing"}`);
		report.equals(
			withTools.message,
			"The model relay serves sealed author calls only — no tools.",
			"the tool-bearing relay refusal",
		);
		report.equals(
			stack.modelRelay.requests().length,
			1,
			"the tool-bearing call was forwarded to the provider despite the sealed-step refusal",
		);
		report.ok("a signed-in tool-bearing relay call is refused without spending a provider call.");

		/*
		 * E3.13, the client half: the product's own relay author seat decodes a
		 * provider stream that travelled through the deployed Worker. The unit
		 * test drives this seat against an injected Response; here the bytes
		 * cross a socket, the router, and the relay double.
		 */
		const seatFetch: FetchLike = async (input, init) => {
			const base = typeof input === "string" || input instanceof URL ? new Request(input, init) : input;
			return fetch(new Request(base, { headers: new Headers([...base.headers, ["cookie", cookie]]) }));
		};
		const authored = await Effect.runPromise(
			Effect.gen(function* () {
				const author = yield* Author.Author;
				return yield* author.author({ prefix: "You are Smithers.", context: ["e2e relay probe"] });
			}).pipe(Effect.provide(layerAuthor({ baseUrl: origin, fetchImpl: seatFetch }))) as Effect.Effect<
				string,
				never,
				never
			>,
		);
		report.equals(authored, PROOF_TEXT, "the relay author seat did not decode the streamed provider text");
		const seatCalls = stack.modelRelay.requests();
		report.equals(seatCalls.length, 2, "the author seat did not reach the provider exactly once");
		const seatBody = seatCalls[1]?.body as { model?: unknown; stream?: unknown; tools?: unknown } | undefined;
		report.equals(seatBody?.model, DEFAULT_MODEL_ID, "the Worker rewrote the model the client asked for");
		report.equals(seatBody?.stream, true, "the author seat's request did not ask the provider to stream");
		report.check(
			!Array.isArray(seatBody?.tools) || (seatBody?.tools as ReadonlyArray<unknown>).length === 0,
			"the author seat sent tools on a sealed author call",
		);
		report.equals(seatCalls[1]?.headers["x-api-key"], MODEL_RELAY_KEY, "the author seat's call lost the key injection");
		report.ok("the product's relay author seat streams through the Worker and decodes the provider text end to end.");

		/*
		 * E3.14, gate. An anonymous caller aiming at a private host must meet the
		 * 401, not the 422: the guard's verdict is itself information, so an
		 * unauthenticated prober must never be able to use the route as an
		 * address oracle.
		 */
		const anonymousTool = await postJson(`${origin}${TOOLS_BROWSER_FETCH_PATH}`, JSON_HEADERS, {
			url: "https://127.0.0.1/",
		});
		report.equals(
			anonymousTool.status,
			401,
			`the anonymous browser-tool call answered ${anonymousTool.message ?? "nothing"}`,
		);
		report.equals(
			anonymousTool.message,
			"Sign in to run a Smithers turn.",
			"the anonymous browser-tool refusal",
		);
		report.ok("an anonymous /api/tools/browser-fetch call meets the session gate, not the address guard.");

		/* E3.14, the refusal surface inside workerd, with the real DoH resolver wired. */
		for (const [url, message] of UNSAFE_TARGETS) {
			const refused = await postJson(`${origin}${TOOLS_BROWSER_FETCH_PATH}`, { ...JSON_HEADERS, cookie }, { url });
			report.equals(refused.status, 422, `the browser tool answered ${url} with ${refused.message ?? "nothing"}`);
			report.equals(refused.errorStatus, "error", `the refusal for ${url} was not shaped as an error`);
			report.equals(refused.message, message, `the refusal sentence for ${url}`);
		}
		report.ok(`the browser tool refuses all ${UNSAFE_TARGETS.length} unsafe targets with the guard's own sentence.`);

		const malformed = await postJson(`${origin}${TOOLS_BROWSER_FETCH_PATH}`, { ...JSON_HEADERS, cookie }, { nope: true });
		report.equals(malformed.status, 400, `a browser-tool call with no url answered ${malformed.message ?? "nothing"}`);
		report.equals(malformed.message, "Body must be { url }.", "the missing-url refusal");

		const notAUrl = await postJson(
			`${origin}${TOOLS_BROWSER_FETCH_PATH}`,
			{ ...JSON_HEADERS, cookie },
			{ url: "not a url at all" },
		);
		report.equals(notAUrl.status, 422, `a browser-tool call with a junk url answered ${notAUrl.message ?? "nothing"}`);
		report.equals(notAUrl.message, "That is not a URL I can read.", "the unparseable-url refusal");
		report.ok("a body with no url is a 400 and an unparseable url is a guarded 422.");

		/*
		 * The refusals above would all still pass if the guard had been widened
		 * into "refuse everything". 192.0.2.1 is TEST-NET-1: a public, routable
		 * literal that clears every pre-DNS check and needs no resolver, so the
		 * tool must get as far as attempting the read and fail there instead.
		 * Nothing answers on TEST-NET-1, so this stays offline.
		 */
		const publicLiteral = await postJson(
			`${origin}${TOOLS_BROWSER_FETCH_PATH}`,
			{ ...JSON_HEADERS, cookie },
			{ url: "https://192.0.2.1/" },
		);
		report.equals(
			publicLiteral.status,
			422,
			`a public IP literal answered ${publicLiteral.message ?? "nothing"}`,
		);
		const publicMessage = publicLiteral.message ?? "";
		report.excludes(publicMessage, PRIVATE_HOST, "the guard refused a public address as private");
		report.excludes(publicMessage, HTTPS_ONLY, "the guard refused an https url as non-https");
		report.check(
			publicMessage.startsWith("Reading 192.0.2.1"),
			`a public IP literal did not reach the read stage: ${JSON.stringify(publicMessage)}`,
		);
		report.ok("a public address clears the guard and fails at the read — the refusals above are targeted, not blanket.");

		/*
		 * E3.14, the client half. The guard's sentence must reach the browser card
		 * as the card's error, so the user is told the read was refused rather
		 * than shown a page that was never fetched.
		 */
		const client = await openClient({ origin, cookie });
		const refusal = await client.controller.openBrowser("https://169.254.169.254/latest/meta-data/");
		report.equals(refusal, PRIVATE_HOST, "openBrowser did not return the guard's refusal to its caller");
		const card = client.cards().find(isBrowserCard);
		report.check(card !== undefined, "the refused read left no browser card in the conversation.");
		report.equals(card?.payload.error, PRIVATE_HOST, "the browser card did not carry the guard's refusal");
		report.equals(card?.payload.status, null, "the browser card claimed an HTTP status for a read that never happened");
		report.equals(card?.payload.finalUrl, null, "the browser card claimed a final url for a read that never happened");
		report.equals(card?.payload.frameable, false, "the refused browser card offered itself as frameable");
		report.ok("a refused read renders a browser card carrying the guard's sentence, never a fabricated page.");

		const signedOut = await openClient({ origin });
		await signedOut.controller.openBrowser("https://example.com/");
		const gatedCard = signedOut.cards().find(isBrowserCard);
		report.equals(
			gatedCard?.payload.error,
			"Sign in to run a Smithers turn.",
			"the signed-out browser card did not carry the session gate's refusal",
		);
		report.ok("a signed-out read renders the session gate's own sentence on the card.");
	},
});
