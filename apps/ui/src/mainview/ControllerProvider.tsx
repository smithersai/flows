import { use } from "react";
import type { ReactNode } from "react";
import type { AppController } from "./state/AppController";
import { ControllerContext } from "./ControllerContext";
import { runControllerBoot } from "./ControllerBoot.client";
import { createControllerBoot } from "./ControllerBootMemo";

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
