import { use } from "react";
import type { ReactNode } from "react";
import type { AppController } from "./state/AppController";
import type { BootSession } from "./BootSession";
import { ControllerContext } from "./ControllerContext";
import { runControllerBoot } from "./ControllerBoot.client";

/**
 * A session-scoped boot memo: the controller and its boot session share a
 * lifetime, so a NEW session (sign-in, sign-out, a second account) must boot
 * a new controller rather than pinning the first session's forever. Keyed on
 * the session's reference — the route loader caches its result, so a stable
 * session keeps the stable boot.
 */
export const createControllerBoot = (
	load: (session?: BootSession) => Promise<AppController>,
): ((session?: BootSession) => Promise<AppController>) => {
	let current: { readonly session: BootSession | undefined; readonly boot: Promise<AppController> } | undefined;
	return (session?: BootSession): Promise<AppController> => {
		if (current === undefined || current.session !== session) {
			current = { session, boot: load(session) };
		}
		return current.boot;
	};
};

export const controllerBootPromise = createControllerBoot(runControllerBoot);

export function ControllerProvider({
	boot,
	children,
}: {
	readonly boot: Promise<AppController>;
	readonly children: ReactNode;
}) {
	const controller = use(boot);
	return <ControllerContext value={controller}>{children}</ControllerContext>;
}
