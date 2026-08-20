/*
 * Billing and grants — checklist E6.3 to E6.6 and E6.8 to E6.10.
 *
 * Every assertion here is aimed at a product seam, never at a double echoing
 * what it was told:
 *
 *  - E6.10 pins the Worker's billing proxy: the trusted-caller path (never the
 *    deployment bearer), client-supplied identity headers stripped, and an
 *    honest 401 that is answered BEFORE anything reaches the billing seam.
 *  - E6.4 pins `zeroBalanceGuard`'s position in the launch sequence: the
 *    refusal must land before `provisionWorkspace`, so neither the client's
 *    call log nor the gateway front may show a single new request.
 *  - E6.3 pins the complimentary rule: the same $0 store still completes a
 *    chat turn and appends no second refusal.
 *  - E6.5 pins exposure: no checkout-shaped command name, both billing
 *    commands unreachable by the model, no card-collection copy in the served
 *    bundle, and the payment routes session-gated and proxied to the platform
 *    rather than to the billing worker.
 *  - E6.6, E6.8 and E6.9 pin the product's admin door: it authenticates with
 *    the admin token, attributes the grant to the VALIDATED admin login rather
 *    than to anything the caller sent, timestamps it, and carries a grantId
 *    the sibling can dedupe on. A double that refuses unattributed grants is
 *    what turns each of those into a real check.
 *
 * One case is not a row and says so where it stands: the untimestamped POST
 * between E6.6 and E6.8 talks only to the billing double, so it is recorded as
 * the precondition E6.8 leans on rather than claiming E6.7.
 */
import {
	ADMIN_GRANT_PATH,
	BILLING_BALANCE_PATH,
	BILLING_USAGE_PATH,
	RECO_WATCHED_PATH,
	TURN_PATH,
	WORKFLOW_PROVISION_PATH,
} from "smithers-shared/AgentApiRoutes";
import { STUB_ADMIN_TOKEN, STUB_PRODUCT_TOKEN } from "../../scripts/stub-backends.ts";
import { CARD_COLLECTION_COPY, CHECKOUT_COPY } from "../../src/launch-checklist/Probes.ts";
import { nameOf } from "../../src/mainview/flows/registry.ts";
import { openClient } from "../Client.ts";
import { defineSuite } from "../Suite.ts";
import { wait } from "../Assert.ts";

/*
 * AppController.ts does not export its refusal text (it is module-local), so
 * it is restated here exactly as ZeroBalanceLaunch.test.ts restates it. A
 * reword in the product turns this suite red, which is the point: the row is
 * about the words the user reads.
 */
const ZERO_BALANCE_TEXT =
	"Balance is at $0 — workflow runs pause until more balance is added. Run /billing.upgrade to add balance; chat stays free in the meantime.";

/** apps/server/src/index.ts, proxyToBilling's signed-out refusal. */
const SIGNED_OUT_BILLING_MESSAGE =
	"Sign in before reading your balance — the identity service did not validate a session.";

/** apps/server/src/index.ts, requireTurnSession's signed-out refusal. */
const SIGNED_OUT_TURN_MESSAGE = "Sign in to run a Smithers turn.";

/** apps/ui/src/mainview/flows/agentTools.ts, userOnlyError with no per-command alternative. */
const USER_ONLY_REFUSAL =
	"failed: /billing.upgrade is user-only — it is a control the human clicks, already visible on their screen";

/** Row D-3's own predicate over registered command names (Rows.ts). */
const CHECKOUT_SHAPED_NAME = /checkout|top-?up|payment|card/i;

/*
 * The payment half of that predicate. `card` alone also matches the card
 * WINDOW controls (card.maximize, card.minimize), which have nothing to do
 * with a payment card — see the D-3 note below.
 */
const PAYMENT_SHAPED_NAME = /checkout|top-?up|payment/i;

/*
 * The only registered names D-3's raw predicate matches today. Both are
 * hidden, user-only card-window controls (Flows.ts card.maximize /
 * card.minimize), so D-3 as written reports them as "checkout-shaped
 * commands" on a live canary. Pinning the exact set keeps this suite as
 * strict as the row while staying honest about what it found: a NEW match —
 * a real billing.checkout, say — turns this red.
 */
const D3_KNOWN_CARD_WINDOW_CONTROLS = ["card.maximize", "card.minimize"];

/*
 * The attribute half of row A-6's card-collection probe (Rows.ts), written so
 * it survives minification: a card input is identified by its autocomplete
 * token, which is the one string a bundler cannot rename.
 */
const CARD_SHAPED_INPUT = /\bcc-(number|exp|exp-month|exp-year|csc|name)\b/i;

/** The chat double's scripted reply, distinctive enough to prove it reached the transcript. */
const CHAT_REPLY = "chat is complimentary at zero balance";

interface BalanceBody {
	readonly balance?: { readonly totalUsd?: string };
	readonly state?: string;
	readonly allowedToStartWork?: boolean;
}

interface UsageBody {
	readonly runId?: string;
	readonly totalUsd?: string;
	readonly rateCardVersion?: string;
	readonly charges?: ReadonlyArray<{ readonly chargeId?: string }>;
}

interface GrantRecord {
	readonly granted?: boolean;
	readonly grantId?: string;
	readonly userId?: string;
	readonly kind?: string;
	readonly amountUsd?: number;
	readonly requester?: string;
	readonly requestedAt?: string;
	readonly recordedAt?: string;
	readonly expiresAt?: string | null;
	readonly duplicate?: boolean;
}

export default defineSuite({
	id: "E6",
	title: "billing at $0, the exposure rule, and the grants admin door (E6.3–E6.6, E6.8–E6.10)",
	// Drains the balance, credits grants and flips the identity admin flag.
	// stack.reset() recreates all three doubles, but 90 keeps this suite last.
	order: 90,
	run: async ({ origin, stack, report }) => {
		const cookie = await stack.signedInCookie();
		const billingUrl = stack.fronts.billing.url;

		/*
		 * flow.run and flow.create both declare requires: ["signed-in",
		 * "repos-selected"] (Flows.ts). Without a durable selection the
		 * requirement axis defers into repos.watch and the balance guard is
		 * never reached, so the selection is written first.
		 */
		const watched = await fetch(`${origin}${RECO_WATCHED_PATH}`, {
			method: "PUT",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ selected: ["will/flows"], via: "command" }),
		});
		report.equals(watched.status, 200, "the watched-repos write");

		/* ---------------------------------------------------------------- */
		/* E6.10 — /api/billing/usage, signed in and signed out.             */
		/* ---------------------------------------------------------------- */

		const balance = await report.json<BalanceBody>(
			await fetch(`${origin}${BILLING_BALANCE_PATH}`, { headers: { cookie } }),
			200,
			"the signed-in balance read",
		);
		report.equals(balance.balance?.totalUsd, "500", "the signed-in balance in dollars");
		report.equals(balance.state, "ok", "the signed-in balance state");
		report.equals(balance.allowedToStartWork, true, "the signed-in allowedToStartWork");
		// introUsd is a CLIENT card field (AppController's balance card payload),
		// never a wire field. Pinning its absence keeps the two from drifting.
		report.check(
			!Object.hasOwn(balance, "introUsd"),
			`the balance wire carried introUsd: ${JSON.stringify(balance)}`,
		);

		/*
		 * The spoofed x-user-login is the point of this read. The proxy strips
		 * every client-supplied identity claim and re-states the VALIDATED
		 * login, so a browser can never pick which account it bills.
		 */
		const usageBefore = await report.json<UsageBody>(
			await fetch(`${origin}${BILLING_USAGE_PATH}?run=billing-e2e-1`, {
				headers: { cookie, "x-user-login": "octocat" },
			}),
			200,
			"the signed-in usage read",
		);
		report.equals(usageBefore.runId, "billing-e2e-1", "the usage read's run id");
		report.equals(usageBefore.totalUsd, "0", "the usage total before any charge");
		report.equals(usageBefore.charges?.length, 0, "the usage charge count before any charge");
		report.equals(usageBefore.rateCardVersion, "stub-2026-08-08", "the usage rate card version");

		const auth = await report.json<{ lastBalanceAuth?: { mode?: string; account?: string } }>(
			await fetch(`${billingUrl}/stub/last-auth`),
			200,
			"the billing double's last-auth control",
		);
		// "bearer" here would be the D-1/D-2/A-5 defect: a signed-in read
		// silently re-keyed onto the shared deployment account.
		report.equals(auth.lastBalanceAuth?.mode, "trusted", "the usage read's authentication mode");
		report.equals(auth.lastBalanceAuth?.account, "will", "the account the usage read was billed to");

		await stack.control("billing", "/stub/charge", { method: "POST" });
		const usageAfter = await report.json<UsageBody>(
			await fetch(`${origin}${BILLING_USAGE_PATH}?run=billing-e2e-1`, { headers: { cookie } }),
			200,
			"the signed-in usage read after a charge",
		);
		report.equals(usageAfter.totalUsd, "0.05375", "the usage total after one charge");
		report.equals(usageAfter.charges?.length, 1, "the usage charge count after one charge");
		report.equals(usageAfter.charges?.[0]?.chargeId, "stub-charge-1", "the charge id");

		/*
		 * The signed-out half. The refusal must be the Worker's own: if the
		 * identity gate were dropped the request would fall onto the
		 * deployment bearer and the double would answer 200, so the front's
		 * request log is asserted alongside the status.
		 */
		const frontMark = stack.fronts.billing.requests().length;
		for (const path of [`${BILLING_USAGE_PATH}?run=billing-e2e-1`, BILLING_BALANCE_PATH]) {
			const refused = await report.json<{ message?: string }>(
				await fetch(`${origin}${path}`),
				401,
				`the signed-out read of ${path}`,
			);
			report.equals(refused.message, SIGNED_OUT_BILLING_MESSAGE, `the signed-out refusal for ${path}`);
		}
		const reachedBilling = stack.fronts.billing
			.requests()
			.slice(frontMark)
			.filter((entry) => entry.path.startsWith("/api/billing/"));
		report.equals(
			reachedBilling.length,
			0,
			`a signed-out billing read reached the seam anyway: ${JSON.stringify(reachedBilling.map((entry) => entry.path))}`,
		);
		report.ok(
			"/api/billing/usage answers a signed-in user in dollars through the trusted-caller path with the client's identity headers stripped, and a signed-out read is refused before it reaches the seam (E6.10).",
		);

		/* ---------------------------------------------------------------- */
		/* E6.3 / E6.4 — the client at $0.                                   */
		/* ---------------------------------------------------------------- */

		// Drain reaches accounts that already exist, so it runs after the reads above.
		await stack.control("billing", "/stub/drain", { method: "POST" });

		const client = await openClient({ origin, cookie });
		await client.controller.loadSession();
		await client.settle(
			"the client never took the drained balance",
			() => client.store.collections.billingAccounts.get("billing")?.state === "empty",
		);
		const account = client.store.collections.billingAccounts.get("billing");
		report.equals(account?.allowedToStartWork, false, "allowedToStartWork after the drain");
		report.equals(account?.totalUsd, "0", "the drained balance the store recorded");
		await client.settle(
			"the watched selection never mirrored, so the requirement axis would defer the launch",
			() => Array.isArray(client.store.collections.watchedRepos.get("watched")?.selected),
		);

		const refusals = (): number =>
			client.messages().filter((message) => message.text === ZERO_BALANCE_TEXT).length;

		for (const [name, args] of [
			["flow.run", "review-pr"],
			["flow.create", "summarize my open issues"],
		] as const) {
			const callMark = client.calls().length;
			const gatewayMark = stack.fronts.gateway.requests().length;
			const before = refusals();
			const outcome = await client.controller.commands.run(name, args);
			report.equals(outcome.status, "failed", `the /${name} launch at $0`);
			const error = outcome.status === "failed" ? outcome.error : "";
			report.equals(error, ZERO_BALANCE_TEXT, `the /${name} refusal text`);
			report.includes(error, "/billing.upgrade", `the /${name} refusal names the upgrade path`);
			/*
			 * The seam proof, both ends. provisionWorkspace is the first thing
			 * past the guard and the only thing that would POST
			 * /api/workflow/provision, and the gateway front sees every call
			 * that leaves the Worker for the workspace seam.
			 */
			const seamCalls = client
				.calls()
				.slice(callMark)
				.filter((call) => call.path.startsWith("/api/workflow/"));
			report.equals(
				seamCalls.length,
				0,
				`/${name} reached the workflow seam at $0: ${JSON.stringify(seamCalls)}`,
			);
			report.equals(
				stack.fronts.gateway.requests().length - gatewayMark,
				0,
				`/${name} reached the gateway seam at $0`,
			);
			report.equals(
				client.countCalls("POST", WORKFLOW_PROVISION_PATH),
				0,
				`/${name} provisioned a workspace at $0`,
			);
			// The refusal is an embedded transcript message, per THE EMBED LAW.
			report.equals(refusals(), before + 1, `the /${name} refusal was not appended to the transcript once`);
			const posted = client.messages().find((message) => message.text === ZERO_BALANCE_TEXT);
			report.equals(posted?.role, "smithers", `the /${name} refusal's transcript role`);
		}

		/*
		 * The button path, which is the one that can double-surface: a pointer
		 * failure normally becomes a toast, and surfaceCommandFailure skips
		 * exactly this refusal because it is already an embedded message.
		 */
		client.controller.runCommandArgs("flow.run", "review-pr");
		await client.settle("the button-driven refusal never landed", () => refusals() === 3);
		await wait(300);
		const toasts = [...client.store.collections.toasts.values()];
		report.equals(
			toasts.filter((toast) => toast.key === "command.failed.flow.run").length,
			0,
			`the $0 refusal double-surfaced as a toast: ${JSON.stringify(toasts)}`,
		);
		report.equals(
			toasts.filter((toast) => toast.detail === ZERO_BALANCE_TEXT).length,
			0,
			"the $0 refusal text appeared in a toast detail",
		);
		report.ok(
			"at $0 flow.run and flow.create short-circuit before any workflow or gateway seam call, post the notice naming /billing.upgrade once as an embedded message, and never double-surface it as a toast (E6.4).",
		);

		stack.chat.script({
			frames: [
				{ type: "delta", kind: "text", text: CHAT_REPLY },
				{ type: "done", reason: "stop" },
			],
		});
		const chatMark = client.calls().length;
		const refusalsBeforeChat = refusals();
		client.controller.send("what is the status of my repo?");
		await client.settle(
			"the $0 chat turn never produced a reply",
			() =>
				client
					.messages()
					.some((message) => message.role === "smithers" && message.text.includes(CHAT_REPLY)),
			30_000,
		);
		const turnCalls = client
			.calls()
			.slice(chatMark)
			.filter((call) => call.method === "POST" && call.path === TURN_PATH);
		report.equals(turnCalls.length, 1, "the number of turn POSTs the $0 chat made");
		report.equals(turnCalls[0]?.status, 200, "the $0 chat turn's HTTP status");
		report.equals(refusals(), refusalsBeforeChat, "the $0 chat appended a workflow-pause refusal of its own");
		report.equals(
			client.store.collections.billingAccounts.get("billing")?.allowedToStartWork,
			false,
			"the balance stopped reading $0 during the chat turn",
		);
		report.ok(
			"at $0 the interactive chat still completes a turn and the model's words reach the transcript, with no pause notice of its own (E6.3).",
		);

		/* ---------------------------------------------------------------- */
		/* E6.5 — nothing top-up, checkout or card-collection is exposed.    */
		/* ---------------------------------------------------------------- */

		const names = client.controller.commands.all().map((item) => item.name);
		const paymentShaped = names.filter((name) => PAYMENT_SHAPED_NAME.test(name));
		report.equals(paymentShaped.length, 0, `payment-shaped command names are registered: ${paymentShaped}`);
		const checkoutShaped = names.filter((name) => CHECKOUT_SHAPED_NAME.test(name)).sort();
		report.equals(
			checkoutShaped.join(","),
			D3_KNOWN_CARD_WINDOW_CONTROLS.join(","),
			"the names D-3's predicate matches changed",
		);
		// What makes those two benign: they are card-window mechanics the human
		// clicks, hidden from the catalog and unreachable by the model.
		for (const name of D3_KNOWN_CARD_WINDOW_CONTROLS) {
			const item = client.controller.commands.all().find((candidate) => candidate.name === name);
			report.equals(item?.hidden, true, `${name} is listed in the catalog`);
		}
		/*
		 * The two billing commands ARE registered, and that is not the
		 * violation: the rule is that they are the human's own control, never
		 * a model-invocable payment flow and never a card form on this origin.
		 * Asserting their presence keeps the row honest about what it forbids.
		 */
		for (const name of ["billing.upgrade", "billing.portal"]) {
			report.check(names.includes(name), `${name} is no longer registered, so the exposure rule moved`);
		}

		const callable = client.controller.commands.callable().map(nameOf);
		const disclosed = client.controller.commands.disclosed().map((descriptor) => descriptor.name);
		for (const name of [...D3_KNOWN_CARD_WINDOW_CONTROLS, "billing.upgrade", "billing.portal"]) {
			report.check(!callable.includes(name), `${name} is model-invocable`);
			report.check(!disclosed.includes(name), `${name} is disclosed to the model's catalog`);
		}
		const checkoutMark = client.calls().length;
		const refused = await client.controller.commands.runForAgent("billing.upgrade", "pro");
		report.equals(refused.status, "failed", "the agent's billing.upgrade invocation");
		report.equals(
			refused.status === "failed" ? refused.error : "",
			USER_ONLY_REFUSAL,
			"the agent's billing.upgrade refusal text",
		);
		const checkoutCalls = client
			.calls()
			.slice(checkoutMark)
			.filter((call) => call.path.startsWith("/api/billing/"));
		report.equals(
			checkoutCalls.length,
			0,
			`the refused agent invocation still called billing: ${JSON.stringify(checkoutCalls)}`,
		);

		// Rendered copy: everything the user has read in this session.
		const rendered = [
			client.transcript(),
			...client.cards().map((card) => card.title),
			...[...client.store.collections.toasts.values()].map((toast) => `${toast.title} ${toast.detail}`),
		].join("\n");
		report.check(!CARD_COLLECTION_COPY.test(rendered), `card-collection copy is in the transcript: ${rendered.slice(0, 300)}`);
		report.check(!CHECKOUT_COPY.test(rendered), `checkout copy is in the transcript: ${rendered.slice(0, 300)}`);

		/*
		 * The served application, not just its shell. index.html is 500 bytes;
		 * the module it loads is where a card form would actually ship.
		 * CHECKOUT_COPY is deliberately NOT run over the bundle: BillingSeam.ts
		 * legitimately contains "Checkout is ready: ".
		 */
		const document = await fetch(origin);
		report.equals(document.status, 200, "the served SPA document");
		const html = await document.text();
		const entry = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
		report.check(entry !== undefined, `the served document loads no module script: ${html.slice(0, 300)}`);
		const bundle = await fetch(`${origin}${entry ?? ""}`);
		report.equals(bundle.status, 200, "the served SPA module");
		const code = await bundle.text();
		report.check(code.length > 100_000, `the served module is too small to be the app: ${code.length} bytes`);
		for (const [what, text] of [
			["document", html],
			["module", code],
		] as const) {
			const copy = CARD_COLLECTION_COPY.exec(text);
			report.check(copy === null, `card-collection copy is in the served ${what}: ${copy?.[0]}`);
			const input = CARD_SHAPED_INPUT.exec(text);
			report.check(input === null, `a card-shaped input is in the served ${what}: ${input?.[0]}`);
		}

		// The payment routes are session-gated by the turn gate, not open doors.
		for (const path of ["/api/billing/checkout", "/api/billing/portal"]) {
			const gated = await report.json<{ message?: string }>(
				await fetch(`${origin}${path}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ plan: "pro" }),
				}),
				401,
				`the signed-out ${path}`,
			);
			report.equals(gated.message, SIGNED_OUT_TURN_MESSAGE, `the signed-out refusal for ${path}`);
		}

		/*
		 * The route split. /api/billing/checkout is an EXACT platform-proxy
		 * match, so it leaves for Smithers Cloud carrying the user's own token
		 * and never touches the billing worker. The Cloud double's own 404
		 * coming back proves both halves: which upstream answered, and that
		 * this origin serves no payment form of its own.
		 */
		const billingMark = stack.fronts.billing.requests().length;
		const gatewayMark = stack.fronts.gateway.requests().length;
		const checkout = await fetch(`${origin}/api/billing/checkout`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ plan: "pro" }),
		});
		report.equals(checkout.status, 404, "the signed-in checkout call");
		const checkoutType = checkout.headers.get("content-type") ?? "";
		report.includes(checkoutType, "application/json", "the checkout answer's content type");
		report.excludes(checkoutType, "text/html", "the checkout answer's content type");
		const checkoutBody = (await checkout.json()) as { message?: string };
		report.equals(
			checkoutBody.message,
			"gateway stub: no route /api/billing/checkout",
			"the upstream that answered the checkout call",
		);
		const billingSaw = stack.fronts.billing
			.requests()
			.slice(billingMark)
			.filter((request) => request.path === "/api/billing/checkout");
		report.equals(billingSaw.length, 0, "the checkout call reached the billing worker");
		const gatewaySaw = stack.fronts.gateway
			.requests()
			.slice(gatewayMark)
			.filter((request) => request.path === "/api/billing/checkout");
		report.equals(gatewaySaw.length, 1, "the checkout call did not reach the platform seam exactly once");
		report.ok(
			"no top-up, checkout or card-collection surface is exposed — no checkout-shaped command name, both billing commands user-only and refused to the agent, no card copy or card-shaped input in the served document or module, and the payment routes session-gated and proxied to the platform rather than to the billing worker (E6.5).",
		);

		/* ---------------------------------------------------------------- */
		/* E6.6 to E6.9 — the grants admin door.                             */
		/* ---------------------------------------------------------------- */

		const grantsUrl = `${billingUrl}/api/billing/admin/grants`;
		const adminHeaders = {
			"content-type": "application/json",
			"x-smithers-admin-token": STUB_ADMIN_TOKEN,
		};
		const grantsOf = async (): Promise<ReadonlyArray<GrantRecord>> => {
			const body = (await (await fetch(`${billingUrl}/stub/grants`)).json()) as {
				grants?: ReadonlyArray<GrantRecord>;
			};
			return body.grants ?? [];
		};
		const balanceOf = async (login: string): Promise<string> => {
			const response = await fetch(`${billingUrl}${BILLING_BALANCE_PATH}`, {
				headers: {
					origin,
					"x-smithers-service-token": STUB_PRODUCT_TOKEN,
					"x-user-login": login,
				},
			});
			const body = (await response.json()) as BalanceBody;
			return body.balance?.totalUsd ?? "";
		};

		/*
		 * E6.6, both surfaces. The 401 belongs to the billing sibling's own
		 * admin route; the product Worker's door answers the canonical 404 to
		 * a signed-out or non-admin caller so the admin surface stays
		 * non-enumerable. Do not "fix" that 404 into a 401.
		 */
		const unauthorized = await report.json<{ error?: string }>(
			await fetch(grantsUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					userId: "grantee-one",
					grantId: "admin:e2e-unauthorized",
					amountUsd: 25,
					requester: "billing-e2e",
					timestamp: new Date().toISOString(),
				}),
			}),
			401,
			"the untokened grant",
		);
		report.equals(unauthorized.error, "Unauthorized admin", "the untokened grant's refusal");

		const canonical = await fetch(`${origin}/api/definitely-not-a-route`);
		const canonicalBody = await canonical.text();
		const doorProbes: ReadonlyArray<{ what: string; headers: Record<string, string> }> = [
			{ what: "signed out", headers: {} },
			// The session is allowlisted but not admin until makeAdmin() below.
			{ what: "signed in but not admin", headers: { cookie } },
		];
		for (const probe of doorProbes) {
			const closed = await fetch(`${origin}${ADMIN_GRANT_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...probe.headers },
				body: JSON.stringify({ login: "octocat", amountUsd: 25 }),
			});
			report.equals(closed.status, canonical.status, `the product grant door answered ${probe.what}`);
			report.equals(await closed.text(), canonicalBody, `the product grant door's ${probe.what} body`);
		}
		report.equals((await grantsOf()).length, 0, "a refused grant still wrote an audit record");
		report.ok(
			"the grants surface refuses an untokened call with 401 and the product's own admin door answers a signed-out and a non-admin caller with the canonical 404, writing nothing (E6.6).",
		);

		/*
		 * PRECONDITION for E6.8, not a proof of E6.7.
		 *
		 * This POSTs an untimestamped grant straight at the billing DOUBLE. No
		 * product code is on the path, and both literals it asserts — the 400
		 * and "timestamp_required" — exist only in scripts/stub-backends.ts, so
		 * on its own it says nothing except that the double does what this repo
		 * told it to do. It is kept because it is what gives the NEXT case its
		 * teeth: the product door's 201 below is evidence that the Worker
		 * stamped the grant only because a grant with no timestamp is refused
		 * here. Row E6.7 itself — does the DEPLOYED billing service refuse an
		 * unattributed grant — is a canary claim and already has a live probe:
		 * row E-2 in src/launch-checklist/Rows.ts, which puts the same request
		 * at the real upstream. Nothing local can settle it.
		 *
		 * The body is complete except for the timestamp: the double validates
		 * userId, then grantId, then amountUsd, then requester, then timestamp,
		 * so an incomplete body would fail on the wrong check and the
		 * precondition would not hold for the reason it claims.
		 */
		const untimestamped = await report.json<{ error?: string; code?: string }>(
			await fetch(grantsUrl, {
				method: "POST",
				headers: adminHeaders,
				body: JSON.stringify({
					userId: "grantee-one",
					grantId: "admin:e2e-untimestamped",
					amountUsd: 25,
					requester: "billing-e2e",
				}),
			}),
			400,
			"the untimestamped grant",
		);
		report.equals(untimestamped.code, "timestamp_required", "the untimestamped grant's code");
		report.equals(untimestamped.error, "timestamp is required", "the untimestamped grant's message");
		report.equals((await grantsOf()).length, 0, "an untimestamped grant still wrote an audit record");
		console.log(
			"note: E6 — precondition, not a proven row: the billing double refuses an untimestamped grant with 400 timestamp_required and writes nothing. " +
				"Only the double is on that path, so it stands under E6.8 below rather than claiming E6.7; the live row stays on the canary.",
		);

		/*
		 * E6.8, through the PRODUCT door — the half this repo owns. The Worker
		 * must mint a grantId, attribute the grant to the validated admin
		 * login, and stamp it fresh; the sibling refuses anything less, so a
		 * regression in any of the three comes back as a 400 rather than a 201.
		 * The bogus requester in the body is the assertion: it must be ignored.
		 */
		await stack.makeAdmin();
		const productGrant = await fetch(`${origin}${ADMIN_GRANT_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ login: "grantee-one", amountUsd: 25, requester: "not-the-admin" }),
		});
		report.equals(productGrant.status, 201, `the product grant door: ${(await productGrant.clone().text()).slice(0, 200)}`);
		const granted = (await productGrant.json()) as GrantRecord;
		report.equals(granted.granted, true, "the product grant's granted flag");
		report.equals(granted.userId, "grantee-one", "the product grant's grantee");
		report.equals(granted.kind, "promotional", "the product grant's kind");
		report.equals(granted.amountUsd, 25, "the product grant's amount");
		report.equals(granted.requester, "will", "the product grant's requester");
		report.check(
			granted.grantId !== undefined && /^admin:product-/.test(granted.grantId),
			`the product grant's id is not a minted admin id: ${granted.grantId}`,
		);
		report.check(
			granted.requestedAt !== undefined && Number.isFinite(Date.parse(granted.requestedAt)),
			`the product grant carries no parseable timestamp: ${granted.requestedAt}`,
		);
		report.equals(granted.expiresAt, null, "the product grant's expiry");

		const audit = await grantsOf();
		report.equals(audit.length, 1, "the audit records the product grant wrote");
		report.equals(audit[0]?.grantId, granted.grantId, "the audit record's grant id");
		report.equals(audit[0]?.requester, "will", "the audit record's requester");
		report.equals(audit[0]?.requestedAt, granted.requestedAt, "the audit record's timestamp");
		report.equals(await balanceOf("grantee-one"), "525", "the grantee's balance after one grant");
		report.ok(
			"a grant through the product's admin door credits the account exactly once with a 201 and a full audit record attributed to the validated admin login, not to anything the caller sent (E6.8).",
		);

		/*
		 * E6.9. The grantId the product minted is the idempotency key: replay
		 * it byte for byte and the sibling answers from the record it already
		 * wrote. If the Worker ever stopped sending a stable grantId, the
		 * replay would land as a second grant and the balance would move.
		 */
		const replay = await report.json<GrantRecord>(
			await fetch(grantsUrl, {
				method: "POST",
				headers: adminHeaders,
				body: JSON.stringify({
					userId: "grantee-one",
					grantId: granted.grantId,
					amountUsd: 25,
					requester: "will",
					timestamp: granted.requestedAt,
				}),
			}),
			200,
			"the replayed grant",
		);
		report.equals(replay.duplicate, true, "the replayed grant's duplicate flag");
		report.equals(replay.grantId, granted.grantId, "the replayed grant's id");
		report.equals(replay.recordedAt, audit[0]?.recordedAt, "the replayed grant echoed a fresh record");
		report.equals((await grantsOf()).length, 1, "the replay wrote a second audit record");
		report.equals(await balanceOf("grantee-one"), "525", "the replay credited the account again");

		/*
		 * The product door's own replay is two grants by construction: it mints
		 * a fresh id per confirmed request, because the human's confirmation
		 * card is the gate, not an idempotency key. Assert the observable fact
		 * rather than a refusal that does not exist.
		 */
		const second = await fetch(`${origin}${ADMIN_GRANT_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ login: "grantee-one", amountUsd: 25 }),
		});
		report.equals(second.status, 201, "the second product-level grant");
		const secondGrant = (await second.json()) as GrantRecord;
		report.check(
			secondGrant.grantId !== granted.grantId,
			`the product door reused a grant id, so a confirmed grant would silently dedupe: ${secondGrant.grantId}`,
		);
		report.equals((await grantsOf()).length, 2, "the audit records after a second product grant");
		report.equals(await balanceOf("grantee-one"), "550", "the grantee's balance after two product grants");
		report.ok(
			"replaying the grantId the product minted answers duplicate without writing a record or crediting again, while a second confirmed product grant mints a fresh id and credits once more (E6.9).",
		);
	},
});
