import { ClientOnly, HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import type { ReactNode } from "react";
import App from "../App";
import { ControllerProvider, controllerBootPromise } from "../ControllerProvider";
import { SessionShell } from "../SessionShell";
import { MountedSignal, StartupErrorBoundary } from "../StartupBoundary";
import { browserStartupWatchdog } from "../StartupWatchdog";
import { resolveBootSession } from "../Session.functions";
import appCss from "../index.css?url";

declare const __SMITHERS_BUILD_SHA__: string;

export const Route = createRootRoute({
	loader: () => resolveBootSession(),
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1.0" },
			{ name: "smithers-build-sha", content: __SMITHERS_BUILD_SHA__ },
			{ title: "Smithers" },
		],
		links: [
			{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
			{ rel: "stylesheet", href: appCss },
		],
	}),
	component: RootComponent,
});

const appearanceScript = `(function(window,document){try{var storage=window.localStorage;var theme=storage&&storage.getItem("smithers-mvp.theme");var palette=storage&&storage.getItem("smithers-mvp.palette");if(theme!=="light"&&theme!=="dark"){theme=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.setAttribute("data-theme",theme);if(typeof palette==="string"&&/^[a-z][a-z-]*$/.test(palette)){document.documentElement.setAttribute("data-palette",palette);}}catch(error){document.documentElement.setAttribute("data-theme","light");}})(window,document);`;

function RootComponent() {
	const session = Route.useLoaderData();
	const shell = <SessionShell session={session} />;
	return (
		<html lang="en">
			<head>
				<HeadContent />
				<script dangerouslySetInnerHTML={{ __html: appearanceScript }} />
			</head>
			<body>
				<div id="root">
					<ClientOnly fallback={shell}>
						<BrowserApplication session={session} fallback={shell} />
					</ClientOnly>
				</div>
				<Scripts />
			</body>
		</html>
	);
}

function BrowserApplication({
	session,
	fallback,
}: {
	readonly session: ReturnType<typeof Route.useLoaderData>;
	readonly fallback: ReactNode;
}) {
	const watchdog = browserStartupWatchdog();
	return (
		<StartupErrorBoundary onError={watchdog.handleRenderFailure}>
			<Suspense fallback={fallback}>
				<ControllerProvider boot={controllerBootPromise(session)}>
					<MountedSignal onMounted={watchdog.markMounted} />
					<App />
				</ControllerProvider>
			</Suspense>
		</StartupErrorBoundary>
	);
}
