/*
 * E7.10 / E7.11 / E7.12 — the workflow seam's reconnect, its replay refusal,
 * and the two acts a run card offers.
 *
 * Three lanes, one stack.
 *
 * The seam lane drives `wrangler dev` with raw fetch: the events cursor
 * replays strictly after `afterSeq`, the guards on that cursor answer 400, and
 * `/api/workflow/stream` is proxied as SSE with `Last-Event-ID` forwarded to
 * the relay. The relay double records every resume token it was handed, so a
 * Worker that drops the header is visible rather than assumed.
 *
 * The client lane drives the product's own AppController against a run whose
 * event log this suite writes by hand. It takes the relay tunnel down, appends
 * three events while the connection is dead, brings the tunnel back, and then
 * demands the card's narration equal an exact list. An event lost across the
 * reconnect leaves a hole in that list; an event replayed twice leaves a
 * duplicate. Both are red.
 *
 * The quiet lane reaches the one phase in which the card renders its two
 * buttons and runs both acts through the registry path those buttons dispatch
 * through.
 *
 * Nothing here asserts that a double returned what it was told to return. Every
 * check is on what the Worker forwarded, what the client did with a cursor, or
 * what the card said afterwards.
 */
import type { Card } from "smithers-shared/Cards";
import { ALLOWED_GATEWAY_METHODS, NON_REPLAYABLE_GATEWAY_METHODS } from "../../../server/src/gateway.ts";
import { wait, waitUntil } from "../Assert.ts";
import { openClient, type Client } from "../Client.ts";
import { defineSuite } from "../Suite.ts";

/** The gateway double's `/stub/relay-state`, narrowed to what this suite reads. */
interface RelayState {
	readonly provisions: number;
	readonly eventReads: number;
	readonly streamOpens: number;
	readonly streamResumes: ReadonlyArray<string | null>;
	readonly rpcCalls: ReadonlyArray<{ readonly method: string; readonly gatewayId: string }>;
	readonly eventCursorReads: ReadonlyArray<{
		readonly runId: string;
		readonly afterSeq: number;
		readonly returned: ReadonlyArray<number>;
	}>;
	readonly runs: ReadonlyArray<{ readonly runId: string; readonly status: string; readonly events: number }>;
}

type RunCard = Extract<Card, { kind: "flow-run" }>;

/*
 * Repositories provisioned for the seam lanes. Each E7.11 case forces a
 * re-provision, which resets that repository's floor, so the two cases cannot
 * share one. The names are this suite's alone: the gateway double survives
 * `stack.reset()`, so a shared name would read another suite's counters.
 */
const REPO_STREAM = "will/e2e-stream";
const REPO_REFUSE = "will/e2e-replay-refuse";
const REPO_REPLAY = "will/e2e-replay-retry";

/** The three repositories the reco double will accept as a watched selection. */
const WATCHED = ["will/flows", "will/smithers", "will/mvp"];

/**
 * FORCED_REPROVISION_FLOOR_MS in apps/server/src/gateway.ts. A record minted
 * inside this window answers a tunnel failure with the raw 502 and never
 * re-provisions, so E7.11 is only reachable once the record has aged past it.
 * Wall clock, and not configurable.
 */
const REPROVISION_FLOOR_MS = 31_000;

/** RUN_STEPS_TAIL in apps/ui/src/mainview/state/AppController.ts. */
const RUN_STEPS_TAIL = 8;

const asJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

export default defineSuite({
	id: "E7.10-E7.12",
	title: "the workflow seam reconnects losslessly, refuses a non-replayable replay, and stops or resumes a watch",
	/* Later than the fast suites: this one spends 31s aging a gateway record. */
	order: 60,
	run: async ({ origin, stack, report }) => {
		const cookie = await stack.signedInCookie();

		const relayState = async (): Promise<RelayState> =>
			asJson<RelayState>(await stack.control("gateway", "/stub/relay-state"));
		const gatewayControl = (path: string): Promise<Response> =>
			stack.control("gateway", path, { method: "POST" });
		const emitEvent = (runId: string, event: string, payload: unknown): Promise<Response> =>
			stack.control("gateway", "/stub/emit-event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ runId, event, payload }),
			});

		/*
		 * A `wrangler dev` reload — which another lane's rebuild of the served
		 * assets triggers — drops in-flight connections. A refused connection is
		 * not an answer from the product, so it is retried; every HTTP status the
		 * Worker does answer is handed straight back, retried never.
		 */
		const seamFetch = async (url: string, init?: RequestInit): Promise<Response> => {
			let refusal: unknown;
			for (let attempt = 0; attempt < 20; attempt += 1) {
				try {
					return await fetch(url, init);
				} catch (error) {
					refusal = error;
					await wait(250);
				}
			}
			return report.fail(`the Worker never answered ${url}: ${String(refusal)}`);
		};

		const seamRpc = (repo: string, method: string, params: unknown): Promise<Response> =>
			seamFetch(`${origin}/api/workflow/rpc`, {
				method: "POST",
				headers: { "content-type": "application/json", cookie },
				body: JSON.stringify({ repo, method, params }),
			});
		const seamEvents = (query: string): Promise<Response> =>
			seamFetch(`${origin}/api/workflow/events?${query}`, { headers: { cookie } });

		try {
			/* ---------------------------------------------------------------- */
			/* Wave 0 — provision, and start the clock the E7.11 floor runs on.  */
			/* ---------------------------------------------------------------- */
			const provisionedAt = Date.now();
			for (const repo of [REPO_STREAM, REPO_REFUSE, REPO_REPLAY]) {
				const body = await report.json<{ status?: string; gatewayId?: string }>(
					await seamFetch(`${origin}/api/workflow/provision`, {
						method: "POST",
						headers: { "content-type": "application/json", cookie },
						body: JSON.stringify({ repo }),
					}),
					200,
					`provisioning ${repo}`,
				);
				report.equals(body.status, "ready", `provisioning ${repo} did not report a ready workspace`);
			}

			/* ---------------------------------------------------------------- */
			/* E7.10 seam lane — the events cursor and the SSE resume token.     */
			/* ---------------------------------------------------------------- */

			/*
			 * The Worker builds the relayed URL itself
			 * (`/v1/api/runs/{runId}/events?limit=…&afterSeq=…`). A Worker that
			 * drops or mangles `afterSeq` re-delivers events the card has already
			 * shown, which is the duplication half of a reconnect going wrong.
			 */
			const launch = await report.json<{ ok?: boolean; payload?: { runId?: string } }>(
				await seamRpc(REPO_STREAM, "launchRun", { workflow: "wave4-relay-proof", input: {} }),
				200,
				"launchRun through the workflow seam",
			);
			const seamRunId = launch.payload?.runId;
			if (typeof seamRunId !== "string" || seamRunId === "") {
				report.fail(`the seam's launchRun answered no runId: ${JSON.stringify(launch)}`);
			}
			// The double's approval gate lands 300ms after the launch, so the run
			// has four events by now and the cursor has something to resume past.
			await wait(700);

			const full = await report.json<{ data?: ReadonlyArray<{ seq: number }> }>(
				await seamEvents(`repo=${encodeURIComponent(REPO_STREAM)}&runId=${seamRunId}&afterSeq=0`),
				200,
				"the whole-run events read",
			);
			const seqs = (full.data ?? []).map((row) => row.seq);
			report.equals(
				JSON.stringify(seqs),
				JSON.stringify([1, 2, 3, 4]),
				"a read from cursor 0 did not answer the whole run so far",
			);
			const resumed = await report.json<{ data?: ReadonlyArray<{ seq: number }> }>(
				await seamEvents(`repo=${encodeURIComponent(REPO_STREAM)}&runId=${seamRunId}&afterSeq=3`),
				200,
				"the resumed events read",
			);
			const resumedSeqs = (resumed.data ?? []).map((row) => row.seq);
			report.equals(
				JSON.stringify(resumedSeqs),
				JSON.stringify([4]),
				"a read from cursor 3 did not replay strictly after the cursor",
			);
			report.equals(
				JSON.stringify([...seqs.slice(0, 3), ...resumedSeqs]),
				JSON.stringify([1, 2, 3, 4]),
				"a reconnect at cursor 3 did not reconstruct the run's event log exactly once",
			);
			report.ok("E7.10: /api/workflow/events replays strictly after afterSeq, with no gap and no repeat.");

			for (const [query, message] of [
				[`repo=${encodeURIComponent(REPO_STREAM)}&runId=${seamRunId}&afterSeq=-1`, "afterSeq must be a non-negative integer."],
				[`repo=${encodeURIComponent(REPO_STREAM)}&runId=${seamRunId}&afterSeq=1.5`, "afterSeq must be a non-negative integer."],
				[`repo=${encodeURIComponent(REPO_STREAM)}`, "Query must carry repo and runId."],
			] as ReadonlyArray<readonly [string, string]>) {
				const refusal = await report.json<{ message?: string }>(
					await seamEvents(query),
					400,
					`the events cursor guard for ?${query}`,
				);
				report.equals(refusal.message, message, `the events cursor guard for ?${query} used the wrong words`);
			}
			report.ok("E7.10: a malformed or absent events cursor is refused in the seam's own words.");

			/*
			 * The stream is proxied end to end and `Last-Event-ID` is its only
			 * resumption token. The double records every token it was handed, so a
			 * Worker that stops forwarding the header — which would make every
			 * browser reconnect replay from the beginning — turns this red.
			 */
			const beforeStream = await relayState();
			const firstStream = await seamFetch(`${origin}/api/workflow/stream?repo=${encodeURIComponent(REPO_STREAM)}`, {
				headers: { cookie },
			});
			report.equals(firstStream.status, 200, "the workflow stream did not open");
			report.includes(
				firstStream.headers.get("content-type") ?? "",
				"text/event-stream",
				"the workflow stream was not proxied as SSE",
			);
			report.equals(
				firstStream.headers.get("cache-control"),
				"no-store",
				"the workflow stream was cacheable, so a reconnect could be served a stale frame",
			);
			const firstFrame = await firstStream.text();
			report.includes(firstFrame, "event: change", "the stream's first frame was not a change frame");
			report.includes(firstFrame, "id: 1", "the stream's first frame carried no id to resume from");

			const resumedStream = await seamFetch(`${origin}/api/workflow/stream?repo=${encodeURIComponent(REPO_STREAM)}`, {
				headers: { cookie, "last-event-id": "1" },
			});
			report.equals(resumedStream.status, 200, "the resumed workflow stream did not open");
			report.includes(
				await resumedStream.text(),
				"id: 2",
				"the reconnect did not resume after the last id it had seen",
			);
			const afterStream = await relayState();
			report.equals(
				JSON.stringify(afterStream.streamResumes.slice(beforeStream.streamResumes.length)),
				JSON.stringify([null, "1"]),
				"the Worker did not forward Last-Event-ID to the relay",
			);
			report.equals(
				afterStream.streamOpens - beforeStream.streamOpens,
				2,
				"the Worker did not open one relay stream per client stream",
			);
			const noRepo = await report.json<{ message?: string }>(
				await seamFetch(`${origin}/api/workflow/stream`, { headers: { cookie } }),
				400,
				"the stream guard with no repo",
			);
			report.equals(noRepo.message, "Query must carry repo.", "the stream guard used the wrong words");
			report.ok("E7.10: /api/workflow/stream is proxied as uncacheable SSE and forwards the client's resume token.");

			/* ---------------------------------------------------------------- */
			/* E7.10 client lane — a dropped connection costs the card nothing.  */
			/* ---------------------------------------------------------------- */

			/*
			 * A stalled run never moves on its own, so every event in the log
			 * below is one this suite appended at a moment it chose. That is what
			 * makes "no event was lost" a statement about the client rather than
			 * about the double's timing.
			 */
			await gatewayControl("/stub/stalled-runs");
			const seeded = await fetch(`${stack.fronts.reco.url}/api/reco/watched`, {
				method: "PUT",
				headers: { "content-type": "application/json", cookie },
				body: JSON.stringify({ selected: WATCHED, via: "onboarding" }),
			});
			report.equals(seeded.status, 200, "seeding the watched selection on the reco double");

			const client = await openClient({ origin, cookie, workflowPollMs: 150 });
			await client.controller.loadSession();
			await client.controller.loadFirstRunReco();
			report.check(
				(client.store.collections.watchedRepos.get("watched")?.selected ?? []).includes("will/flows"),
				"the client never mirrored the watched selection, so no run could be targeted",
			);

			const runCardOf = (source: Client, cardId: string): RunCard => {
				const card = source.store.collections.cards.get(cardId);
				if (card === undefined || card.kind !== "flow-run") {
					return report.fail(`${cardId} is not a run card in the store`);
				}
				return card;
			};
			const stepsOf = (source: Client, cardId: string): ReadonlyArray<string> =>
				runCardOf(source, cardId).payload.steps;
			const firstRunCardId = (source: Client): string => {
				const card = source.cards().find((entry) => entry.kind === "flow-run");
				if (card === undefined) return report.fail("no run card reached the transcript");
				return card.id;
			};

			const launched = await client.controller.commands.run("flow.run", "wave4-relay-proof will/flows");
			report.equals(launched.status, "executed", "the run command did not execute");
			await client.settle(
				"no run card reached the transcript",
				() => client.cards().some((card) => card.kind === "flow-run"),
				15_000,
			);
			const cardId = firstRunCardId(client);
			const runId = runCardOf(client, cardId).payload.runId;
			report.equals(cardId, `flow-run-${runId}`, "the run card is not keyed by its run id");

			await waitUntil(
				report,
				"the card never narrated the events the launch had already emitted",
				() => stepsOf(client, cardId).includes("Working on clarify…"),
				20_000,
			);
			report.equals(runCardOf(client, cardId).payload.lastSeq, 2, "the card's cursor did not advance to the events it showed");

			/*
			 * The outage. `tunnel-down` fails every relay call the way a suspended
			 * workspace VM does, so the events poll cannot reach the run. Three
			 * events land while it cannot, which is the only way to prove the
			 * catch-up read is complete rather than merely successful.
			 */
			const readsBeforeOutage = (await relayState()).eventReads;
			await gatewayControl("/stub/tunnel-down");
			try {
				await waitUntil(
					report,
					"the card never said it was reconnecting while the relay was unreachable",
					() => runCardOf(client, cardId).payload.phase === "reconnecting",
					20_000,
				);
				for (const [event, nodeId] of [
					["NodeStarted", "plan"],
					["NodeFinished", "plan"],
					["NodeStarted", "build"],
				] as ReadonlyArray<readonly [string, string]>) {
					const emitted = await emitEvent(runId, event, { nodeId });
					report.equals(emitted.status, 200, `appending ${event} to the run while the relay was down`);
				}
				report.check(
					(await relayState()).eventReads === readsBeforeOutage,
					"the events poll reached the relay while the tunnel was down, so the outage never happened",
				);
			} finally {
				await gatewayControl("/stub/tunnel-up");
			}

			await waitUntil(
				report,
				"the card never caught up on the events that landed while the connection was down",
				() => stepsOf(client, cardId).includes("Working on build…"),
				25_000,
			);
			const narrated = [
				`Started wave4-relay-proof on will/flows (run ${runId}).`,
				"The run started.",
				"Working on clarify…",
				"Working on plan…",
				"plan finished.",
				"Working on build…",
			];
			report.equals(
				JSON.stringify(stepsOf(client, cardId)),
				JSON.stringify(narrated),
				"the reconnect cost the card events, or told it one twice",
			);
			report.equals(runCardOf(client, cardId).payload.lastSeq, 5, "the card's cursor does not match the last event it showed");
			report.equals(
				runCardOf(client, cardId).payload.phase,
				"running",
				"the card stayed in the reconnecting state after the connection came back",
			);

			/*
			 * The same claim read off the relay's own ledger: every seq this run
			 * handed back, in the order the client asked for it. A client that
			 * forgets its cursor repeats a seq here; one that advances past an
			 * event it never read leaves a gap.
			 */
			const cursorReads = (await relayState()).eventCursorReads.filter((read) => read.runId === runId);
			report.equals(
				JSON.stringify(cursorReads.flatMap((read) => [...read.returned])),
				JSON.stringify([1, 2, 3, 4, 5]),
				"the client's cursor read an event twice or skipped one across the reconnect",
			);
			report.check(
				cursorReads.every((read, index) => index === 0 || read.afterSeq >= (cursorReads[index - 1]?.afterSeq ?? 0)),
				"the client's cursor went backwards across the reconnect",
			);
			report.ok("E7.10: a dropped relay connection loses no run event — the card's narration and the relay's cursor ledger agree exactly.");

			/* ---------------------------------------------------------------- */
			/* E7.12 — stop is stop WATCHING, and check again really re-reads.   */
			/* ---------------------------------------------------------------- */

			const stopped = await client.controller.commands.run("flow.run.stop", cardId);
			report.equals(stopped.status, "executed", "flow.run.stop did not execute");
			report.equals(runCardOf(client, cardId).payload.phase, "stopped", "the card did not settle to stopped");
			report.check(
				stepsOf(client, cardId).includes("Stopped watching this run."),
				"stop did not say on the card what it had done",
			);
			// A poll already in flight when the stop landed may still finish, so
			// sample after one settling window and measure the silence from there.
			await wait(600);
			const readsAtStop = (await relayState()).eventReads;
			await wait(1_500);
			report.equals(
				(await relayState()).eventReads,
				readsAtStop,
				"stop watching only repainted the card — the relay was still being polled",
			);

			const retried = await client.controller.commands.run("flow.run.retry", cardId);
			report.equals(retried.status, "executed", "flow.run.retry did not execute");
			report.check(
				stepsOf(client, cardId).includes("Checking the run again…"),
				"check again did not say on the card what it had done",
			);
			await waitUntil(
				report,
				"check again did not actually re-read the run",
				async () => (await relayState()).eventReads > readsAtStop,
				15_000,
			);
			report.equals(
				JSON.stringify(stepsOf(client, cardId)),
				JSON.stringify([...narrated, "Stopped watching this run.", "Checking the run again…"]),
				"the two acts did not leave the card's account of itself intact",
			);
			report.equals(
				stepsOf(client, cardId).length,
				RUN_STEPS_TAIL,
				"the run card's step tail is no longer the length this equality depends on",
			);

			/*
			 * Both acts belong to the human. A model that can stop a watch answers
			 * the human's question about their own screen for them.
			 */
			const asAgent = await client.controller.commands.runForAgent("flow.run.stop", cardId);
			report.equals(asAgent.status, "failed", "the model was allowed to stop the human's watch");
			report.includes(
				asAgent.status === "failed" ? asAgent.error : "",
				"is user-only",
				"the refusal did not say why the model may not stop a watch",
			);
			await client.controller.commands.run("flow.run.stop", cardId);
			report.ok("E7.12: flow.run.stop stops the pump and flow.run.retry resumes it, both stated on the card, neither callable by the model.");

			/* ---------------------------------------------------------------- */
			/* E7.12 — the two acts from the phase that renders their buttons.   */
			/* ---------------------------------------------------------------- */

			/*
			 * The buttons render only while `payload.phase === "quiet"`, and quiet
			 * is 10 minutes of no progress in production. This client sets the
			 * bound to 900ms and drives the same registry path the buttons
			 * dispatch through (App.tsx → runCommandArgs → commands.run).
			 */
			const quietClient = await openClient({
				origin,
				cookie,
				workflowPollMs: 150,
				workflowQuietMs: 900,
			});
			await quietClient.controller.loadSession();
			await quietClient.controller.loadFirstRunReco();
			const quietLaunch = await quietClient.controller.commands.run("flow.run", "wave4-relay-proof will/smithers");
			report.equals(quietLaunch.status, "executed", "the second run command did not execute");
			await quietClient.settle(
				"no run card reached the second transcript",
				() => quietClient.cards().some((card) => card.kind === "flow-run"),
				15_000,
			);
			const quietCardId = firstRunCardId(quietClient);
			await waitUntil(
				report,
				"a run that stopped moving never went quiet, so the card's two acts never rendered",
				() => runCardOf(quietClient, quietCardId).payload.phase === "quiet",
				20_000,
			);

			const readsAtQuiet = (await relayState()).eventReads;
			const quietRetry = await quietClient.controller.commands.run("flow.run.retry", quietCardId);
			report.equals(quietRetry.status, "executed", "check again did not execute from the quiet card");
			report.check(
				stepsOf(quietClient, quietCardId).includes("Checking the run again…"),
				"check again from the quiet card did not say what it had done",
			);
			await waitUntil(
				report,
				"check again from the quiet card did not re-read the run",
				async () => (await relayState()).eventReads > readsAtQuiet,
				15_000,
			);
			await waitUntil(
				report,
				"the resumed watch did not go quiet again on a run that still had not moved",
				() => runCardOf(quietClient, quietCardId).payload.phase === "quiet",
				20_000,
			);
			const quietStop = await quietClient.controller.commands.run("flow.run.stop", quietCardId);
			report.equals(quietStop.status, "executed", "stop watching did not execute from the quiet card");
			report.equals(
				runCardOf(quietClient, quietCardId).payload.phase,
				"stopped",
				"the quiet card did not settle to stopped",
			);
			report.check(
				stepsOf(quietClient, quietCardId).includes("Stopped watching this run."),
				"stop watching from the quiet card did not say what it had done",
			);
			report.ok("E7.12: a run that stops moving goes quiet, and both acts the quiet card offers run from that phase.");

			/* ---------------------------------------------------------------- */
			/* E7.11 — the replay rule, once the records are past the floor.     */
			/* ---------------------------------------------------------------- */

			const aged = Date.now() - provisionedAt;
			if (aged < REPROVISION_FLOOR_MS) await wait(REPROVISION_FLOOR_MS - aged);

			/*
			 * A tunnel failure can mean the engine took the write and only the
			 * answer was lost. `launchRun` is the one relayed method a repeat
			 * could duplicate, so the seam resumes the workspace and reports what
			 * happened instead of launching a second run.
			 */
			const beforeRefusal = await relayState();
			await gatewayControl("/stub/tunnel-down-once");
			const refused = await seamRpc(REPO_REFUSE, "launchRun", {
				workflow: "create-workflow",
				input: { prompt: "e2e non-replay" },
			});
			report.equals(refused.status, 502, "a non-replayable call on a slept workspace did not answer 502");
			const refusalBody = await asJson<{ status?: string; message?: string }>(refused);
			report.equals(refusalBody.status, "error", "the non-replay refusal was not reported as an error");
			report.equals(
				refusalBody.message,
				"Your workspace had gone to sleep. It is awake again — ask me once more.",
				"the non-replay refusal was not stated in its own words",
			);
			const afterRefusal = await relayState();
			report.equals(
				afterRefusal.runs.length,
				beforeRefusal.runs.length,
				"the refused launch still started a run on the workspace",
			);
			report.equals(
				afterRefusal.rpcCalls
					.slice(beforeRefusal.rpcCalls.length)
					.filter((call) => call.method === "launchRun").length,
				0,
				"launchRun reached the engine on a call the seam said it had refused",
			);
			report.check(
				afterRefusal.provisions > beforeRefusal.provisions,
				"the seam said the workspace was awake again without resuming it",
			);
			report.ok("E7.11: a tunnel failure refuses launchRun rather than replaying it, and resumes the workspace as it says.");

			/*
			 * The other side of the same rule: a read is keyed by nothing a repeat
			 * could duplicate, so it IS replayed onto the resumed gateway.
			 */
			const beforeReplay = await relayState();
			await gatewayControl("/stub/tunnel-down-once");
			const replayed = await seamRpc(REPO_REPLAY, "getRun", { runId: seamRunId });
			report.equals(replayed.status, 200, "a replayable call was not retried onto the resumed gateway");
			const afterReplay = await relayState();
			report.equals(
				afterReplay.rpcCalls.slice(beforeReplay.rpcCalls.length).filter((call) => call.method === "getRun").length,
				1,
				"the replayable call did not reach the engine exactly once after the resume",
			);
			report.check(
				afterReplay.provisions > beforeReplay.provisions,
				"the replayable call was retried without resuming the workspace first",
			);
			report.ok("E7.11: getRun IS replayed onto the resumed gateway, so the refusal above is the replay rule and not an outage.");

			/*
			 * The allowlist is the seam's whole vocabulary. Adding a second write
			 * method without deciding its replay behaviour turns this red.
			 */
			const beforeAllowlist = await relayState();
			const outsiders = ["cancelRun", "stopRun", "retryRun", "runShell", "getRunState"];
			for (const method of outsiders) {
				const refusal = await report.json<{ message?: string }>(
					await seamRpc(REPO_REFUSE, method, {}),
					400,
					`the seam's refusal of ${method}`,
				);
				report.equals(
					refusal.message,
					`The workflow seam does not relay ${method}.`,
					`${method} was refused in the wrong words`,
				);
			}
			report.equals(
				JSON.stringify(
					(await relayState()).rpcCalls
						.slice(beforeAllowlist.rpcCalls.length)
						.map((call) => call.method),
				),
				"[]",
				"a method outside the allowlist reached the gateway",
			);
			report.equals(
				JSON.stringify([...ALLOWED_GATEWAY_METHODS].sort()),
				JSON.stringify([
					"getNodeOutput",
					"getRun",
					"launchRun",
					"listApprovals",
					"listWorkflows",
					"submitApproval",
					"whatHappened",
				]),
				"the relayed-method allowlist changed",
			);
			report.equals(
				JSON.stringify([...NON_REPLAYABLE_GATEWAY_METHODS]),
				JSON.stringify(["launchRun"]),
				"the non-replayable set changed without this suite deciding what the new method does on replay",
			);
			/*
			 * Stop is stop WATCHING. Nothing this suite did relayed a cancellation,
			 * because there is no cancelRun to relay.
			 */
			report.check(
				!(await relayState()).rpcCalls.some((call) => outsiders.includes(call.method)),
				"a run-control method the seam does not relay still reached the gateway",
			);
			report.ok("E7.11: the seam relays exactly seven methods, refuses the rest by name, and never relayed a cancellation.");
		} finally {
			/*
			 * The gateway double outlives stack.reset(), so its failure switches
			 * are this suite's to put back. A restore that throws must not hide
			 * the failure that brought us here.
			 */
			try {
				await gatewayControl("/stub/tunnel-up");
				await gatewayControl("/stub/lively-runs");
			} catch {
				// The stack is coming down anyway; the suite's own verdict stands.
			}
		}
	},
});
