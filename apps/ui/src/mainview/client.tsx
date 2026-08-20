import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";
import { startStartupWatchdog } from "./StartupWatchdog";

startStartupWatchdog({ timeoutMs: 15_000 });
hydrateRoot(
	document,
	<StrictMode>
		<StartClient />
	</StrictMode>,
);
