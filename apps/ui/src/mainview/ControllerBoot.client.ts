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
		const bindChain = () => {
			agent.bindChain(
				createChainRuntime({ store, commands: controller.commands, fetchImpl: controller.tappedFetch }),
			);
		};

		if (session === undefined) {
			// Electrobun has no server renderer; it retains the existing client-side session path.
			yield* promiseEffect("load identity session", () => controller.loadSession());
			yield* Effect.sync(bindChain);
			if (controller.handleAuthReturn(window.location.search)) {
				window.history.replaceState(null, "", window.location.pathname);
			}
			return controller;
		}

		yield* promiseEffect("adopt identity session", () => controller.adoptSession(session));
		yield* Effect.sync(bindChain);
		if (session.authFailed) {
			yield* Effect.sync(() => {
				controller.handleAuthReturn("?auth=failed");
			});
		}
		return controller;
	});

export const runControllerBoot = (session?: BootSession): Promise<AppController> =>
	Effect.runPromise(bootProgram(session));
