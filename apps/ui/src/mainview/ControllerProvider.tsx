import { use } from "react";
import type { ReactNode } from "react";
import type { AppController } from "./state/AppController";
import type { BootSession } from "./BootSession";
import { ControllerContext } from "./ControllerContext";

let browserBoot: Promise<AppController> | undefined;

export const controllerBootPromise = (session?: BootSession): Promise<AppController> => {
	if (browserBoot === undefined) {
		browserBoot = import("./ControllerBoot.client").then(({ runControllerBoot }) => runControllerBoot(session));
	}
	return browserBoot;
};

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
