/*
 * Harness self-test.
 *
 * Proves the harness end to end before any product suite depends on it: the
 * stack boots, the SPA serves under the isolation headers, a programmable front
 * answers and faults on demand, the identity and chat seams answer through the
 * Worker, the model relay receives the injected key, and the real client wires
 * up against the injected fetch. It asserts the harness, not the product.
 */
import { defineSuite } from "../Suite.ts";
import { openClient } from "../Client.ts";
import { MODEL_RELAY_KEY } from "../ModelRelay.ts";

export default defineSuite({
	id: "H-0",
	title: "the hermetic harness boots, serves, fronts, scripts and drives the real client",
	run: async ({ origin, stack, report }) => {
		const page = await fetch(origin);
		const html = await page.text();
		report.check(page.status === 200, `the root page answered HTTP ${page.status}.`);
		report.includes(html, "<", "the root page did not look like HTML");
		for (const header of ["cross-origin-opener-policy", "cross-origin-embedder-policy"]) {
			report.check(page.headers.get(header) !== null, `missing ${header} on the SPA response.`);
		}
		report.ok("the stack booted and the SPA served with COOP/COEP headers.");

		// The front is what lets a suite add a route without editing a shared file.
		stack.fronts.identity.handle("GET", "/stub/harness-probe", () => new Response("front-route"));
		const routed = await fetch(`${stack.fronts.identity.url}/stub/harness-probe`);
		report.equals(await routed.text(), "front-route", "a front-registered route did not answer");
		stack.fronts.identity.failOnce("GET", "/stub/harness-probe", 503, '{"code":"armed"}');
		const faulted = await fetch(`${stack.fronts.identity.url}/stub/harness-probe`);
		report.equals(faulted.status, 503, "the armed one-shot fault did not answer");
		const recovered = await fetch(`${stack.fronts.identity.url}/stub/harness-probe`);
		report.equals(recovered.status, 200, "the one-shot fault did not clear after one call");
		report.ok("a front serves a suite-registered route and a one-shot fault, then recovers.");

		const signedOut = await report.json<{ status?: string }>(
			await fetch(`${origin}/api/auth/session`),
			200,
			"the signed-out session probe",
		);
		report.equals(signedOut.status, "signed-out", "the identity seam did not answer signed-out");

		const cookie = await stack.signedInCookie();
		const session = await report.json<{ login?: string; allowlisted?: boolean }>(
			await fetch(`${origin}/api/auth/session`, { headers: { cookie } }),
			200,
			"the signed-in session probe",
		);
		report.equals(session.login, "will", "the minted cookie did not resolve to the stub user");
		report.equals(session.allowlisted, true, "the minted cookie was not allowlisted");
		const identityPaths = stack.fronts.identity.requests().map((entry) => entry.path);
		for (const path of ["/api/auth/github/start", "/api/auth/github/callback", "/api/auth/session"]) {
			report.check(
				identityPaths.includes(path),
				`the identity front never saw ${path}, so the Worker did not reach the double through the front`,
			);
		}
		report.ok("the identity seam answers through the front and signedInCookie() mints an allowlisted session.");

		const turn = await fetch(`${origin}/api/agent/turn`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({
				runId: "harness-selftest-1",
				messages: [{ role: "user", content: "hello" }],
				instructions: "Be brief.",
			}),
		});
		report.equals(turn.status, 200, "the scripted chat turn");
		report.equals(
			turn.headers.get("content-type"),
			"application/x-ndjson",
			"the turn did not stream NDJSON",
		);
		const kinds = (await turn.text())
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { type: string }).type);
		report.equals(kinds[0], "delta", "the streamed turn did not open with a delta");
		report.check(kinds.includes("card"), `the streamed turn carried no card (saw ${kinds.join(",")}).`);
		report.equals(kinds[kinds.length - 1], "done", "the streamed turn did not end with done");
		report.equals(stack.chat.requests().length, 1, "the chat double recorded the wrong number of turns");
		report.ok("the chat double's default script streamed delta → card → done through /api/agent/turn.");

		const relay = await fetch(`${origin}/api/model/stream`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ model: "stub-model", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
		});
		report.equals(relay.status, 200, "the model relay call");
		report.includes(await relay.text(), "message_stop", "the relay stream did not carry the scripted lines");
		const relayRequests = stack.modelRelay.requests();
		report.equals(relayRequests.length, 1, "the model relay recorded the wrong number of calls");
		report.equals(
			relayRequests[0]?.headers["x-api-key"],
			MODEL_RELAY_KEY,
			"the Worker did not inject MODEL_RELAY_API_KEY into the relay call",
		);
		report.ok("the model relay double answers /api/model/stream and proves the key injection.");

		const relayState = await report.json<{ provisions?: number }>(
			await stack.control("gateway", "/stub/relay-state"),
			200,
			"the gateway relay-state control",
		);
		report.equals(typeof relayState.provisions, "number", "the gateway control did not answer its state");
		report.ok("stack.control() reaches a double's /stub/* surface through its front.");

		const client = await openClient({ origin, cookie });
		await client.controller.loadSession();
		report.equals(
			client.store.collections.identitySessions.get("identity")?.state,
			"signed-in",
			"the injected-fetch client did not record the signed-in session",
		);
		report.check(
			client.countCalls("GET", "/api/auth/session") > 0,
			"the client's call log recorded no session probe",
		);
		report.ok("openClient() drives the real store and controller over the injected fetch, with no global patched.");
	},
});
