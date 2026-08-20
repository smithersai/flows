/*
 * Authentication, sign-out, and session expiry (E1.2, E1.9, E1.10).
 *
 * Three properties the desktop app's whole door rests on:
 *
 *  - E1.9 sign-out returns the real client to the signed-out chat AND kills
 *    the session. Both halves, because either one alone is a live bug: a
 *    store cleared while the cookie still authenticates signs the user back
 *    in on the next reload, and a killed session the client never noticed
 *    leaves the chat pretending to be signed in.
 *  - E1.10 a session that expires mid-session surfaces in the chat off
 *    exactly ONE identity re-probe — never a dead end, never a 401 loop.
 *  - E1.2 the signed-out page IS the chat, and its first Tab stop is the
 *    sign-in affordance.
 *
 * Every path constant comes from smithers-shared/AgentApiRoutes and every
 * page predicate from src/launch-checklist/Probes.ts, so a rename moves the
 * assertion with the product instead of leaving a green string behind.
 */
import {
	AUTH_LOGOUT_PATH,
	AUTH_SESSION_PATH,
	BILLING_BALANCE_PATH,
	TURN_PATH,
} from "smithers-shared/AgentApiRoutes";
import { wait, waitUntil } from "../Assert.ts";
import { openClient, type Client } from "../Client.ts";
import { defineSuite } from "../Suite.ts";
import { REGISTERED_COMMANDS, TABBABLE_FLOWS, waitForText } from "../../src/launch-checklist/Probes.ts";

/** The sign-in CTA's command name, as App.tsx binds it and Flows.ts registers it. */
const SIGN_IN_FLOW = "auth.sign-in";
/** The sign-out command name, as Flows.ts registers it. */
const SIGN_OUT_FLOW = "auth.sign-out";
/** AppController's calm signed-out reply (AppController.ts, send()). */
const SIGNED_OUT_REPLY = "Sign in with GitHub first — that's the one step between you and this conversation.";
/** AppController's honest balance failure line (refreshBalanceImpl). */
/** withToast's key for the balance read (AppController.ts, refreshBalance). */
const BALANCE_TOAST_KEY = "billing.balance.refresh";
/** The lead-in AppController composes around GET /api/auth/scopes (fetchScopesPlain). */
const SCOPES_LEAD_IN = "Before GitHub asks, here is what Smithers will use:";
/** App.tsx's synthetic signed-out message (the `auth-state` row). */
const SIGNED_OUT_HEADLINE = "Smithers is a design-partner preview";

/** Toast debounce off and auto-dismiss parked, so a settled toast is readable. */
const CLIENT_TIMING = { toastDebounceMs: 0, toastAutoDismissMs: 120_000 } as const;

const identityRow = (client: Client) => client.store.collections.identitySessions.get("identity");

const toastByKey = (client: Client, key: string) =>
	[...client.store.collections.toasts.values()].find((toast) => toast.key === key);

const signInReply = (client: Client) => client.messages().find((message) => message.action?.flow === SIGN_IN_FLOW);

export default defineSuite({
	id: "E1-auth-session",
	title: "sign-out, mid-session expiry, and the signed-out page's first Tab stop",
	run: async ({ origin, stack, report, browser }) => {
		/* ---------------- E1.9: sign-out ---------------- */

		/*
		 * The wire half. The clearing Set-Cookie has to survive the product
		 * Worker's identity proxy: handlePlatformProxy rebuilds a response and
		 * keeps only content-type, so moving /api/auth/logout behind it would
		 * drop the clear and leave every user signed in after signing out.
		 */
		const wireCookie = await stack.signIn();
		const before = await report.json<{ login?: string }>(
			await fetch(`${origin}${AUTH_SESSION_PATH}`, { headers: { cookie: wireCookie } }),
			200,
			"the session probe before sign-out",
		);
		report.equals(before.login, "will", "the minted cookie did not name the stub user before sign-out");

		const logout = await fetch(`${origin}${AUTH_LOGOUT_PATH}`, {
			method: "POST",
			headers: { cookie: wireCookie },
		});
		const logoutType = logout.headers.get("content-type") ?? "";
		const clearing = logout.headers.get("set-cookie") ?? "";
		await logout.body?.cancel();
		report.equals(logout.status, 200, "sign-out through the Worker");
		report.excludes(
			logoutType,
			"text/html",
			"sign-out answered a page; the client reads response.ok on JSON and never follows one",
		);
		report.includes(clearing, "stub_session=", "sign-out did not restate the session cookie through the proxy");
		report.check(
			/max-age=0/i.test(clearing),
			`sign-out did not carry the cookie clear through the Worker (set-cookie: ${clearing || "(none)"}).`,
		);
		const afterWire = await report.json<{ status?: string; login?: string }>(
			await fetch(`${origin}${AUTH_SESSION_PATH}`, { headers: { cookie: wireCookie } }),
			200,
			"the session probe after sign-out",
		);
		report.equals(afterWire.status, "signed-out", "the old cookie still opened a session after sign-out");
		report.equals(afterWire.login, undefined, "the post-sign-out session probe still named an account");

		/*
		 * The client half, driven through the command registry so a renamed or
		 * unregistered flow is a failure rather than a silent no-op.
		 */
		const outCookie = await stack.signIn();
		const out = await openClient({ origin, cookie: outCookie, ...CLIENT_TIMING });
		await out.controller.loadSession();
		report.equals(identityRow(out)?.state, "signed-in", "the client did not record the session before sign-out");

		report.check(out.controller.runCommand(SIGN_OUT_FLOW) === true, `no command named /${SIGN_OUT_FLOW} is registered.`);
		await waitUntil(report, "sign-out never returned the client to the signed-out state", () => identityRow(out)?.state === "signed-out");
		const clearedRow = identityRow(out);
		report.equals(clearedRow?.login, null, "sign-out left the account name in the store");
		report.equals(clearedRow?.allowlisted, false, "sign-out left the allowlist grant in the store");
		report.equals(clearedRow?.admin, false, "sign-out left the admin grant in the store");

		// The other half of "clears the session cookie": the authority stopped
		// honouring it, so a reload with the same jar cannot sign back in.
		const outAfter = await report.json<{ status?: string }>(
			await fetch(`${origin}${AUTH_SESSION_PATH}`, { headers: { cookie: outCookie } }),
			200,
			"the session probe with the cookie the client signed out of",
		);
		report.equals(outAfter.status, "signed-out", "the client's sign-out left its own session alive on the server");

		out.controller.send("still there?");
		await waitUntil(report, "a send after sign-out never resolved to the sign-in step", () => signInReply(out) !== undefined);
		report.includes(signInReply(out)?.text ?? "", SIGNED_OUT_REPLY, "the post-sign-out reply was not the calm sign-in line");
		await out.idle();
		report.equals(out.countCalls("POST", TURN_PATH), 0, "a send after sign-out still reached the turn seam");
		report.ok(
			"E1.9 sign-out clears the cookie through the Worker, kills the session, empties the identity row, and the next send resolves to the sign-in step.",
		);

		/*
		 * Sign-out is not optimistic. A logout the identity service refuses must
		 * leave the client signed in, because the cookie it could not clear
		 * still authenticates: a store cleared here would show a signed-out chat
		 * to a session that is still live.
		 */
		const refusedCookie = await stack.signIn();
		const refused = await openClient({ origin, cookie: refusedCookie, ...CLIENT_TIMING });
		await refused.controller.loadSession();
		report.equals(identityRow(refused)?.state, "signed-in", "the client did not record the session before the refused sign-out");
		stack.fronts.identity.failOnce("POST", AUTH_LOGOUT_PATH, 500);
		report.check(refused.controller.runCommand(SIGN_OUT_FLOW) === true, `no command named /${SIGN_OUT_FLOW} is registered.`);
		await waitUntil(report, "the refused sign-out never reached the logout seam", () => refused.countCalls("POST", AUTH_LOGOUT_PATH) === 1);
		// The dispatch, if the client made one, is synchronous on the response;
		// this window is for the store subscription, not for the network.
		await wait(300);
		report.equals(
			identityRow(refused)?.state,
			"signed-in",
			"a refused sign-out cleared the client anyway, so the chat reads signed-out while the cookie still authenticates",
		);
		const stillLive = await report.json<{ login?: string }>(
			await fetch(`${origin}${AUTH_SESSION_PATH}`, { headers: { cookie: refusedCookie } }),
			200,
			"the session probe after the refused sign-out",
		);
		report.equals(stillLive.login, "will", "the refused sign-out killed the session anyway, so the state above proved nothing");

		/* ---------------- E1.10: a session that expires mid-session ---------------- */

		const liveCookie = await stack.signIn();
		const live = await openClient({ origin, cookie: liveCookie, ...CLIENT_TIMING });
		await live.controller.loadSession();
		report.equals(identityRow(live)?.state, "signed-in", "the client was not signed in before the expiry");

		// Baseline: the balance seam answers for this session, so the failure
		// below is the expiry and not a seam that never worked.
		await live.controller.refreshBalance();
		report.equals(toastByKey(live, BALANCE_TOAST_KEY)?.status, "ok", "the balance read failed before the session expired");
		report.check(
			live.store.collections.billingAccounts.get("billing")?.state !== "unavailable",
			"the balance seam was already unavailable before the session expired.",
		);

		await stack.control("identity", "/stub/expire-sessions", { method: "POST" });

		const probesBefore = live.countCalls("GET", AUTH_SESSION_PATH);
		const balanceBefore = live.countCalls("GET", BILLING_BALANCE_PATH);
		/*
		 * Three seam reads at once, the way a returning window fires them. The
		 * 401 seam has to collapse the burst into ONE identity re-probe; one
		 * re-probe per 401 is the loop this row exists to forbid.
		 */
		await Promise.all([live.controller.refreshBalance(), live.controller.refreshBalance(), live.controller.refreshBalance()]);
		await waitUntil(report, "the expired session never surfaced: the client still believes it is signed in", () => identityRow(live)?.state === "signed-out");

		const probes = live.countCalls("GET", AUTH_SESSION_PATH) - probesBefore;
		report.equals(probes, 1, "the identity re-probes the expiry burst produced");
		const balanceReads = live.countCalls("GET", BILLING_BALANCE_PATH) - balanceBefore;
		report.equals(balanceReads, 3, "the balance reads the expiry burst produced (a retry storm is the 401 loop)");

		/*
		 * The expiry signs the client out, and signing out FORGETS the previous
		 * account's state — transcript, balance, toasts alike (AppStore's
		 * forgetAccountState). So what the expired read owes the user is not a
		 * toast that outlives the account it described: it is that nothing of
		 * that account is left on screen still claiming to be current, and that
		 * the chat itself now carries the sign-in step (checked below). This
		 * block used to demand a "failed" balance toast, which the sign-out
		 * deliberately clears, so the row was red on a claim rather than on a
		 * defect.
		 */
		report.equals(
			toastByKey(live, BALANCE_TOAST_KEY),
			undefined,
			"a toast about the expired account's balance outlived the account",
		);
		report.equals(
			live.store.collections.billingAccounts.get("billing"),
			undefined,
			"the expired account's balance stayed on screen as if it were current",
		);

		// The signed-out re-probe re-reads the scope copy the chat's sign-in
		// message renders; without it the message falls back to "may not work yet".
		report.includes(identityRow(live)?.scopesPlain ?? "", SCOPES_LEAD_IN, "the signed-out re-probe did not reload the plain-words scope copy");

		const turnsBefore = stack.chat.requests().length;
		live.controller.send("are you still with me?");
		await waitUntil(report, "after the expiry a send did not resolve to the sign-in step — a dead end", () => signInReply(live) !== undefined);
		report.includes(signInReply(live)?.text ?? "", SIGNED_OUT_REPLY, "the post-expiry reply was not the calm sign-in line");
		await live.idle();
		report.equals(live.countCalls("POST", TURN_PATH), 0, "a send after the expiry still reached the turn seam");
		report.equals(stack.chat.requests().length, turnsBefore, "a send after the expiry still started a model turn");
		report.ok(
			"E1.10 a mid-session expiry surfaces off exactly one re-probe, forgets the expired account's balance and its toasts rather than leaving them on screen, reloads the scope copy, and the next send offers sign-in instead of dead-ending.",
		);

		/* ---------------- E1.2: the signed-out page's first Tab stop ---------------- */

		/*
		 * Declared here rather than as `browser: true` on the suite: the runner
		 * skips a whole browser suite on a machine with no Chrome, which would
		 * take E1.9 and E1.10 down with it. Only this section needs a page.
		 */
		if (!browser.available) {
			console.log(`skip: E1.2 — ${browser.reason ?? "no system browser"}`);
			return;
		}
		// Deliberately cookie-less: the row is about the signed-OUT view.
		const session = await browser.open();
		try {
			const page = session.page;
			/*
			 * The document reads `complete` before React has mounted, so wait for
			 * the composer rather than for the load. The re-navigations cover the
			 * one flake this shares with every other suite: `wrangler dev` reloads
			 * itself when a sibling touches apps/server, and a navigation that
			 * landed mid-reload sits on Chrome's error page forever.
			 */
			let mounted = false;
			for (let attempt = 0; attempt < 6 && !mounted; attempt += 1) {
				if (attempt > 0) await page.reload();
				for (let tick = 0; tick < 50 && !mounted; tick += 1) {
					mounted = (await page.evaluate<boolean>(`document.querySelector("textarea") !== null`)) === true;
					if (!mounted) await wait(200);
				}
			}
			report.check(mounted, "the signed-out page rendered no composer, so the chat is not the page.");
			const settled = await waitForText(page, (text) => text.includes(SIGNED_OUT_HEADLINE), 30_000, Date.now, wait);
			report.check(
				settled.ok,
				`the signed-out page never rendered the sign-in message: ${settled.text.trim().slice(0, 200)}`,
			);

			const tabbable = await page.evaluate<ReadonlyArray<string>>(TABBABLE_FLOWS);
			report.check(
				tabbable[0] === SIGN_IN_FLOW,
				`the first Tab stop was ${tabbable[0] ?? "(none)"}, expected ${SIGN_IN_FLOW} (${SIGN_IN_FLOW} sits at index ${tabbable.indexOf(SIGN_IN_FLOW)}; order: ${tabbable.slice(0, 6).join(", ")}).`,
			);
			// A first Tab stop bound to a name the registry dropped is a dead key.
			const registered = await page.evaluate<ReadonlyArray<string>>(REGISTERED_COMMANDS);
			report.check(
				registered.includes(SIGN_IN_FLOW),
				`the first Tab stop names ${SIGN_IN_FLOW}, which the live registry does not list (${registered.length} commands).`,
			);
			report.ok("E1.2 the signed-out page is the chat, and its first Tab stop is the registered sign-in affordance.");
		} finally {
			session.close();
		}
	},
});
