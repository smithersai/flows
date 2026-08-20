import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ControllerProvider, controllerBootPromise } from "./ControllerProvider";
import { SessionShell } from "./SessionShell";
import { startStartupWatchdog } from "./StartupWatchdog";
import { unavailableBootSession } from "./BootSession";
import "./index.css";

const session = unavailableBootSession();
const watchdog = startStartupWatchdog({ timeoutMs: 15_000 });
const boot = controllerBootPromise();
void boot.catch(watchdog.reportFailure);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Suspense fallback={<SessionShell session={session} />}>
			<ControllerProvider boot={boot}>
				<App />
			</ControllerProvider>
		</Suspense>
	</StrictMode>,
);
