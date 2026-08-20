/*
 * The native sign-in handoff, end to end (E1.11) and its single-use expiring
 * claim (E1.12).
 *
 * This is the desktop app's ONLY sign-in path: GitHub passkeys cannot complete
 * inside the embedded webview, so OAuth runs in the system browser and the
 * session travels back to the app through a polled claim. Until this suite it
 * had been exercised only against a hand-written fetch mock
 * (src/mainview/state/AuthHandoff.test.ts), which cannot see the product
 * Worker's proxy at all.
 *
 * The epistemic limit, stated plainly: the server half lives in the identity
 * Worker, which is not in this repository. What this suite proves is that the
 * CLIENT and the product Worker honour the contract the double states — the
 * mint reaches the identity seam through the proxy, the binding survives the
 * query string, the ready claim's Set-Cookie survives the proxy and names a
 * real session, the 200 HTML success page is not replaced by the Worker's
 * error surface, and a 404 stops the poll instead of running it out for five
 * minutes. It does NOT prove the deployed identity Worker agrees; that is what
 * the canary drift check is for.
 */
import type { FetchLike } from "smithers-shared/NativeAgent";
import {
	AUTH_NATIVE_CLAIM_PATH,
	AUTH_NATIVE_START_PATH,
	AUTH_SESSION_PATH,
	AUTH_SIGN_IN_PATH,
} from "smithers-shared/AgentApiRoutes";
import { wait, waitUntil } from "../Assert.ts";
import { memoryStorage, NO_NATIVE_REPOSITORIES } from "../Client.ts";
import type { Stack } from "../Stack.ts";
import { defineSuite } from "../Suite.ts";
import { createAppController, type AppController } from "../../src/mainview/state/AppController.ts";
import { createAppStore, type AppStore } from "../../src/mainview/state/AppStore.ts";
import { createWebAgent } from "../../src/mainview/native/WebAgent.ts";

/** AppController.ts:651 — one toast key narrates the whole arc. */
const HANDOFF_TOAST_KEY = "auth.sign-in.handoff";

interface JarClient {
	readonly store: AppStore;
	readonly controller: AppController;
	/** What the app's own cookie jar holds, "" when empty. */
	readonly cookie: () => string;
	readonly countCalls: (method: string, path: string) => number;
}

/*
 * openClient() attaches ONE fixed cookie and never learns a new one. The whole
 * point of the handoff is that the claim's Set-Cookie lands in the app's own
 * jar, so this suite wires the same real store, controller and agent behind a
 * fetch that keeps a jar, exactly as a browser does. Nothing patches a global.
 */
const openJarClient = async (options: {
	readonly origin: string;
	readonly handoffPollMs: number;
	readonly openExternal: (url: string) => Promise<boolean>;
}): Promise<JarClient> => {
	let cookie = "";
	const calls: Array<{ method: string; path: string }> = [];
	const jarFetch: FetchLike = async (input, init) => {
		const base =
			typeof input === "string" || input instanceof URL ? new Request(input, init) : (input as Request);
		const url = new URL(base.url);
		calls.push({ method: base.method.toUpperCase(), path: url.pathname });
		// A browser sends its jar to the same origin and to nothing else.
		const sameOrigin = url.origin === options.origin;
		const request =
			cookie === "" || !sameOrigin || base.headers.has("cookie")
				? base
				: new Request(base, { headers: new Headers([...base.headers, ["cookie", cookie]]) });
		const response = await fetch(request);
		const issued = sameOrigin ? response.headers.get("set-cookie") : null;
		if (issued !== null) {
			// Max-Age=0 is the clear; anything else replaces what the jar holds.
			cookie = /max-age=0/i.test(issued) ? "" : (issued.split(";")[0] ?? "");
		}
		return response;
	};

	const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
	const controller = createAppController(
		store,
		NO_NATIVE_REPOSITORIES,
		createWebAgent({ baseUrl: options.origin, fetchImpl: jarFetch }),
		{
			baseUrl: options.origin,
			fetchImpl: jarFetch,
			workflowPollMs: 150,
			handoffPollMs: options.handoffPollMs,
			openExternal: options.openExternal,
		},
	);
	return {
		store,
		controller,
		cookie: () => cookie,
		countCalls: (method, path) =>
			calls.filter((call) => call.method === method.toUpperCase() && call.path === path).length,
	};
};

const handoffToast = (client: JarClient) =>
	[...client.store.collections.toasts.values()].find((toast) => toast.key === HANDOFF_TOAST_KEY);

const identityStateOf = (client: JarClient) =>
	client.store.collections.identitySessions.get("identity")?.state;

interface BrowserLeg {
	/** Every URL openExternal was handed, oldest first. */
	readonly opened: Array<string>;
	/** The handoff ids the identity double held live when each tab opened. */
	readonly liveAtOpen: Array<ReadonlyArray<string>>;
	/** What the OAuth callback answered THAT tab. */
	readonly callbacks: Array<{
		status: number;
		contentType: string;
		setCookie: string | null;
		body: string;
	}>;
}

const newLeg = (): BrowserLeg => ({ opened: [], liveAtOpen: [], callbacks: [] });

interface HandoffLedger {
	readonly live: ReadonlyArray<{ id: string; state: string; expiresInMs: number }>;
	readonly spent: ReadonlyArray<{ id: string; reason: string }>;
	readonly claims: ReadonlyArray<{ at: string; handoffId: string; outcome: string; status: number }>;
}

const ledgerOf = async (control: Stack["control"]): Promise<HandoffLedger> =>
	(await (await control("identity", "/stub/handoffs")).json()) as HandoffLedger;

/*
 * The system-browser door, with a jar of its OWN — that separation is the
 * property under test: the OAuth tab must not be how the app gets its session.
 * It records what the callback answered so the suite can prove the tab was
 * handed the success PAGE and no cookie.
 */
const systemBrowser =
	(origin: string, control: Stack["control"], leg: BrowserLeg) =>
	async (url: string): Promise<boolean> => {
		leg.opened.push(url);
		try {
			leg.liveAtOpen.push((await ledgerOf(control)).live.map((entry) => entry.id));
			const start = await fetch(url, { redirect: "manual" });
			const location = start.headers.get("location");
			await start.body?.cancel();
			if (location === null) return false;
			const callback = await fetch(new URL(location, origin).toString(), { redirect: "manual" });
			leg.callbacks.push({
				status: callback.status,
				contentType: callback.headers.get("content-type") ?? "",
				setCookie: callback.headers.get("set-cookie"),
				body: await callback.text(),
			});
			return true;
		} catch {
			/*
			 * nativeSignIn does not await its own promise, so a throw here would
			 * surface as an unhandled rejection instead of a suite failure. An
			 * unopenable browser is exactly what `false` means.
			 */
			return false;
		}
	};

const claimWith = (origin: string, body: unknown): Promise<Response> =>
	fetch(`${origin}${AUTH_NATIVE_CLAIM_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

export default defineSuite({
	id: "E1.11/E1.12",
	title: "the native sign-in handoff lands a session, states its failures, and its claim is single-use and expiring",
	run: async ({ origin, stack, report }) => {
		/* ---------------- E1.11: the handoff completes ---------------- */
		const leg = newLeg();
		const app = await openJarClient({
			origin,
			handoffPollMs: 25,
			openExternal: systemBrowser(origin, stack.control, leg),
		});
		await app.controller.loadSession();
		report.equals(
			identityStateOf(app),
			"signed-out",
			"the handoff client did not start from the signed-out state, so signIn() would have refused before the handoff",
		);
		const outcome = await app.controller.commands.run("auth.sign-in");
		report.equals(outcome.status, "executed", "the auth.sign-in flow did not run");
		await waitUntil(
			report,
			"the native handoff never landed a session: the client still believes it is signed out",
			() => identityStateOf(app) === "signed-in",
			25_000,
		);

		report.equals(
			app.countCalls("POST", AUTH_NATIVE_START_PATH),
			1,
			"the handoff did not mint exactly one handoff through /api/auth/native/start",
		);
		report.equals(leg.opened.length, 1, "the handoff did not open exactly one browser window");
		const openedUrl = new URL(leg.opened[0] ?? "");
		report.equals(openedUrl.origin, origin, "the handoff opened a tab off the app's own origin");
		report.equals(openedUrl.pathname, AUTH_SIGN_IN_PATH, "the handoff opened something other than the OAuth start");
		const boundId = openedUrl.searchParams.get("handoff");
		/*
		 * The id the app put in the tab must be the id the identity service
		 * minted. A double-encoded, truncated or swapped-for-the-pollSecret
		 * binding fails here rather than five minutes later as a timeout.
		 */
		report.equals(
			leg.liveAtOpen[0]?.length,
			1,
			"the identity service did not hold exactly one live handoff when the browser opened",
		);
		report.equals(
			boundId,
			leg.liveAtOpen[0]?.[0] ?? null,
			"the OAuth tab carried a handoff binding the identity service never minted",
		);
		report.check(
			app.countCalls("POST", AUTH_NATIVE_CLAIM_PATH) >= 1,
			"the handoff never polled /api/auth/native/claim",
		);
		report.ok(
			"E1.11 — the handoff mints through the Worker's identity proxy and opens the OAuth start on the app's own origin, bound to the id the identity service minted.",
		);

		// The mint and the poll must reach the identity seam, not be answered by
		// the product Worker: a route moved onto a local handler dies here.
		const identityPaths = stack.fronts.identity.requests().map((entry) => entry.path);
		for (const path of [AUTH_NATIVE_START_PATH, AUTH_NATIVE_CLAIM_PATH]) {
			report.check(
				identityPaths.includes(path),
				`the identity service never saw ${path}, so the product Worker did not proxy it`,
			);
		}
		const claimBody = stack.fronts.identity
			.requests()
			.filter((entry) => entry.path === AUTH_NATIVE_CLAIM_PATH)
			.map((entry) => JSON.parse(entry.body || "{}") as { handoffId?: unknown; pollSecret?: unknown });
		report.check(
			claimBody.length >= 1 &&
				claimBody.every(
					(entry) =>
						entry.handoffId === boundId &&
						typeof entry.pollSecret === "string" &&
						entry.pollSecret !== "",
				),
			`a claim reached the identity service without the minted credentials: ${JSON.stringify(claimBody).slice(0, 200)}`,
		);

		report.check(
			app.cookie().startsWith("stub_session="),
			`the ready claim's session cookie never reached the app's own jar (jar: ${JSON.stringify(app.cookie())})`,
		);
		report.equals(
			app.store.collections.identitySessions.get("identity")?.login,
			"will",
			"the handoff landed a session that names the wrong account",
		);
		const settled = handoffToast(app);
		report.equals(settled?.status, "ok", `the handoff arc did not resolve its toast: ${JSON.stringify(settled)}`);
		report.equals(settled?.title, "Signed in", "the handoff success toast did not state that sign-in finished");
		report.equals(
			settled?.detail,
			"Connected as will.",
			"the handoff success toast did not name the account, so the re-probe after the claim did not land",
		);
		report.ok(
			"E1.11 — the ready claim's Set-Cookie survives the identity proxy, lands in the app's jar, and the re-probe names the account on the one toast that narrates the arc.",
		);

		/*
		 * The OAuth tab is handed a 200 HTML success page and NO cookie: the
		 * session travels by claim. Passing that page through is a special case
		 * in the Worker (apps/server/src/index.ts, the callback branch) —
		 * deleting it replaced a signed-in user's page with the "nothing was
		 * signed in" error surface, which was a live bug.
		 */
		const tab = leg.callbacks[0];
		report.equals(tab?.status, 200, `the handoff-bound OAuth callback answered HTTP ${tab?.status} through the Worker`);
		report.includes(tab?.contentType ?? "", "text/html", "the handoff-bound OAuth callback did not answer the success page");
		report.equals(tab?.setCookie ?? null, null, "the handoff-bound OAuth callback cookied the browser tab instead of the app");
		report.ok(
			"E1.11 — the handoff-bound OAuth callback answers the browser tab a 200 success page with no session cookie; the session reaches the app only through the claim.",
		);

		/* ---------------- E1.11: a failed OAuth states itself ---------------- */
		await stack.control("identity", "/stub/handoff-fail", { method: "POST" });
		const failedLeg = newLeg();
		const failedApp = await openJarClient({
			origin,
			handoffPollMs: 25,
			openExternal: systemBrowser(origin, stack.control, failedLeg),
		});
		await failedApp.controller.loadSession();
		await failedApp.controller.commands.run("auth.sign-in");
		await waitUntil(
			report,
			"a failed OAuth never resolved the handoff toast",
			() => handoffToast(failedApp)?.status === "failed",
			25_000,
		);
		report.equals(
			handoffToast(failedApp)?.detail,
			"GitHub said no.",
			"the handoff failure did not carry the reason the identity service recorded",
		);
		report.equals(identityStateOf(failedApp), "signed-out", "a failed OAuth fabricated a session");
		report.equals(failedApp.cookie(), "", "a failed OAuth left a session cookie in the app's jar");

		/* ---------------- E1.11: a browser that will not open ---------------- */
		const unopenable = await openJarClient({ origin, handoffPollMs: 25, openExternal: async () => false });
		await unopenable.controller.loadSession();
		await unopenable.controller.commands.run("auth.sign-in");
		await waitUntil(
			report,
			"a browser that would not open never failed the handoff arc",
			() => handoffToast(unopenable)?.status === "failed",
			25_000,
		);
		report.includes(
			handoffToast(unopenable)?.detail ?? "",
			"browser couldn't be opened",
			"the unopenable-browser failure did not state itself",
		);
		report.equals(
			unopenable.countCalls("POST", AUTH_NATIVE_START_PATH),
			1,
			"the unopenable-browser arc did not get as far as minting a handoff, so its zero claims prove nothing",
		);
		// Long enough for a dozen polls at 25ms, so "did not poll" is not "has not polled yet".
		await wait(400);
		report.equals(
			unopenable.countCalls("POST", AUTH_NATIVE_CLAIM_PATH),
			0,
			"a handoff whose browser never opened still polled the claim",
		);
		report.ok(
			"E1.11 — a failed OAuth propagates the recorded reason and fabricates no session, and an unopenable browser fails the arc before it polls anything.",
		);

		/* ---------------- E1.12: the claim is single-use ---------------- */
		const minted = await report.json<{ handoffId?: unknown; pollSecret?: unknown; expiresAt?: unknown }>(
			await fetch(`${origin}${AUTH_NATIVE_START_PATH}`, { method: "POST" }),
			200,
			"the native handoff mint",
		);
		report.check(
			typeof minted.handoffId === "string" &&
				minted.handoffId !== "" &&
				typeof minted.pollSecret === "string" &&
				minted.pollSecret !== "",
			`the mint did not answer a typed handoff: ${JSON.stringify(minted).slice(0, 200)}`,
		);
		const handoffId = String(minted.handoffId);
		const pollSecret = String(minted.pollSecret);

		const pending = await report.json<{ status?: string }>(
			await claimWith(origin, { handoffId, pollSecret }),
			200,
			"the claim on a handoff whose OAuth has not completed",
		);
		report.equals(
			pending.status,
			"pending",
			"a handoff whose OAuth has not completed handed an answer over anyway",
		);

		/*
		 * Unknown, wrong-secret, consumed and expired are ONE answer. The client
		 * reads 404 as "that sign-in expired" and reads everything else as "keep
		 * polling", so any other status for a dead handoff is five minutes of
		 * silence in the app.
		 */
		const wrongSecret = await claimWith(origin, { handoffId, pollSecret: "not-the-poll-secret" });
		await wrongSecret.body?.cancel();
		report.equals(wrongSecret.status, 404, "a wrong pollSecret did not answer the non-enumerable 404");
		const unknownId = await claimWith(origin, { handoffId: "no-such-handoff", pollSecret });
		await unknownId.body?.cancel();
		report.equals(unknownId.status, 404, "an unknown handoffId did not answer the non-enumerable 404");

		const wireLeg = newLeg();
		const completed = await systemBrowser(
			origin,
			stack.control,
			wireLeg,
		)(`${origin}${AUTH_SIGN_IN_PATH}?handoff=${encodeURIComponent(handoffId)}`);
		report.check(completed, "the system-browser double could not complete the OAuth leg");

		const ready = await claimWith(origin, { handoffId, pollSecret });
		const readyCookie = ready.headers.get("set-cookie") ?? "";
		const readyBody = await report.json<{ status?: string }>(ready, 200, "the claim on a completed handoff");
		report.equals(readyBody.status, "ready", "a completed handoff did not answer ready");
		report.includes(
			readyCookie,
			"stub_session=",
			"the ready claim did not carry the session cookie through the identity proxy",
		);
		// The cookie must name a session, not merely be a Set-Cookie header.
		const handed = await report.json<{ login?: string; status?: string }>(
			await fetch(`${origin}${AUTH_SESSION_PATH}`, { headers: { cookie: readyCookie.split(";")[0] ?? "" } }),
			200,
			"the session probe with the cookie the claim handed over",
		);
		report.equals(handed.login, "will", "the cookie the claim handed over does not name a session");

		const replay = await claimWith(origin, { handoffId, pollSecret });
		const replayCookie = replay.headers.get("set-cookie");
		await replay.body?.cancel();
		report.equals(
			replay.status,
			404,
			"a replayed claim was answered again — a stolen pollSecret would mint a second session",
		);
		report.equals(replayCookie, null, "a replayed claim put a second session cookie on the wire");
		/*
		 * The double's ledger says WHY the replay was refused. Without it a
		 * double that 404s everything would pass this section proving nothing.
		 */
		const afterReplay = await ledgerOf(stack.control);
		report.equals(
			afterReplay.spent.find((entry) => entry.id === handoffId)?.reason,
			"consumed",
			"the identity service did not record the handoff as consumed",
		);
		const forHandoff = afterReplay.claims.filter((entry) => entry.handoffId === handoffId);
		report.equals(
			forHandoff[forHandoff.length - 1]?.outcome,
			"consumed",
			"the replay was refused for some reason other than the handoff being spent",
		);
		report.ok(
			"E1.12 — a claim is single-use: the second call with the same credentials is refused as consumed, with no second session cookie, and a wrong secret or unknown id is the same non-enumerable 404.",
		);

		/* ---------------- E1.12: expiry outranks readiness ---------------- */
		const aging = await report.json<{ handoffId?: unknown; pollSecret?: unknown }>(
			await fetch(`${origin}${AUTH_NATIVE_START_PATH}`, { method: "POST" }),
			200,
			"the native handoff mint for the expiry check",
		);
		const agingId = String(aging.handoffId);
		const agingSecret = String(aging.pollSecret);
		const agingLeg = newLeg();
		report.check(
			await systemBrowser(
				origin,
				stack.control,
				agingLeg,
			)(`${origin}${AUTH_SIGN_IN_PATH}?handoff=${encodeURIComponent(agingId)}`),
			"the system-browser double could not complete the OAuth leg for the expiry check",
		);
		await stack.control("identity", "/stub/expire-handoffs", { method: "POST" });
		const expired = await claimWith(origin, { handoffId: agingId, pollSecret: agingSecret });
		const expiredCookie = expired.headers.get("set-cookie");
		await expired.body?.cancel();
		report.equals(expired.status, 404, "an expired handoff answered something other than the 404 the client reads as gone");
		report.equals(expiredCookie, null, "an expired handoff handed a session over anyway");
		const afterExpiry = await ledgerOf(stack.control);
		report.equals(
			afterExpiry.spent.find((entry) => entry.id === agingId)?.reason,
			"expired",
			"the identity service did not record the handoff as expired",
		);

		/* ---------------- E1.12: the client stops on the first 404 ---------------- */
		const expiringApp = await openJarClient({
			origin,
			handoffPollMs: 25,
			openExternal: async () => {
				// Open the tab and age the handoff out before the first poll.
				try {
					await stack.control("identity", "/stub/expire-handoffs", { method: "POST" });
					return true;
				} catch {
					return false;
				}
			},
		});
		await expiringApp.controller.loadSession();
		await expiringApp.controller.commands.run("auth.sign-in");
		await waitUntil(
			report,
			"an expired handoff never failed the arc — the client is still polling",
			() => handoffToast(expiringApp)?.status === "failed",
			25_000,
		);
		report.equals(
			handoffToast(expiringApp)?.detail,
			"That sign-in expired — try again.",
			"an expired handoff did not state itself as expired",
		);
		report.equals(identityStateOf(expiringApp), "signed-out", "an expired handoff left the client believing it signed in");
		// A 404 is terminal: more polls here would be the five-minute dead end.
		await wait(400);
		report.equals(
			expiringApp.countCalls("POST", AUTH_NATIVE_CLAIM_PATH),
			1,
			"an expired handoff kept the client polling instead of stopping on the first 404",
		);
		report.ok(
			"E1.12 — expiry outranks readiness on the wire, and the client stops on the first 404 with the honest expired line instead of polling for five minutes.",
		);
	},
});
