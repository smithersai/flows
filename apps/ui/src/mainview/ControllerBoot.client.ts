import { Effect } from "effect";
import type { BootSession } from "./BootSession";
import { createAgentSeat, createChainRuntime } from "./chain/ChainRuntime";
import { nativeAgent, nativeOpenExternal, nativeRepositories } from "./native/NativeBridge";
import { createAppController } from "./state/AppController";
import type { AppController } from "./state/AppController";
import { createAppStore } from "./state/AppStore";

const promiseEffect = <A>(label: string, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) => new Error(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`),
	});

const seedSession = (controller: AppController, session: BootSession): void => {
	controller.store.dispatch({
		type: "identity.session.loaded",
		actor: "system",
		state: session.state,
		login: session.login,
		allowlisted: session.allowlisted,
		admin: session.admin,
		scopesPlain: null,
	});
};

/** Browser-only boot. Promise-shaped factories enter the Effect program at this boundary. */
const bootProgram = (session: BootSession | undefined) =>
	Effect.gen(function* () {
		const store = yield* promiseEffect("create app store", () => createAppStore());
		const agent = yield* Effect.sync(() => createAgentSeat(nativeAgent));
		const controller = yield* Effect.sync(() =>
			createAppController(store, nativeRepositories, agent, {
				...(nativeOpenExternal === undefined ? {} : { openExternal: nativeOpenExternal }),
			}),
		);
		yield* Effect.sync(() => {
			agent.bindChain(
				createChainRuntime({ store, commands: controller.commands, fetchImpl: controller.tappedFetch }),
			);
		});

		if (session === undefined) {
			// Electrobun has no server renderer; it retains the existing client-side session path.
			yield* promiseEffect("load identity session", () => controller.loadSession());
			if (controller.handleAuthReturn(window.location.search)) {
				window.history.replaceState(null, "", window.location.pathname);
			}
			return controller;
		}

		yield* Effect.sync(() => seedSession(controller, session));
		if (session.authFailed) {
			yield* Effect.sync(() => {
				controller.handleAuthReturn("?auth=failed");
			});
		}
		if (session.state === "signed-in") {
			yield* promiseEffect("refresh billing", () => controller.refreshBalance());
			if (session.allowlisted) {
				yield* promiseEffect("load first-run recommendations", () => controller.loadFirstRunReco());
				yield* Effect.sync(() => controller.resumeWorkflowRuns());
			}
			yield* Effect.sync(() => controller.resumeDeferredCommand());
		}
		return controller;
	});

export const runControllerBoot = (session?: BootSession): Promise<AppController> =>
	Effect.runPromise(bootProgram(session));
