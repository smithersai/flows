import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";
import { browserStartupWatchdog } from "./StartupWatchdog";

browserStartupWatchdog();
hydrateRoot(
	document,
	<StrictMode>
		<StartClient />
	</StrictMode>,
);
