/*
 * E12.1, E12.2 and CN-22 — the packaged desktop app actually launches, and the
 * page inside it actually boots.
 *
 * There is no headless mode and no CDP endpoint. electrobun.config.ts sets
 * bundleCEF:false on every platform, so the window is the SYSTEM webview —
 * WKWebView here, GTKWebKit on Linux — and neither exposes a DevTools socket.
 * The bun side cannot read the DOM either: BrowserView only offers
 * executeJavascript, which is fire-and-forget with no return value.
 *
 * So the observation channel is the network. The smoke serves the built SPA
 * from a local origin, points the app at it through SMITHERS_APP_URL — the
 * exact mechanism `start:canary` uses — and watches what the window asks for:
 *
 *   GET /                     the webview loaded the document
 *   GET /assets/*.js          the webview parsed it and fetched the bundle
 *   GET /api/auth/session     the bundle EXECUTED: this is main.tsx's boot
 *                             call, reached only after createAppStore resolved
 *                             and the controller was built
 *   no POST /api/client-errors   nothing threw while the page came up
 *
 * That is a real render signal, not a double's say-so: every one of those
 * requests is made by product code running inside the shipped shell.
 *
 * Usage:
 *   bun e2e/native/native-launch.ts
 *   bun e2e/native/native-launch.ts --target https://canary.smithers.sh   (CN-22)
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const UI_DIR = fileURLToPath(new URL("../../", import.meta.url));
const DIST_DIR = join(UI_DIR, "dist");
const ELECTROBUN_BIN = join(UI_DIR, "node_modules", ".bin", "electrobun");
/** A cold cache downloads the electrobun CLI, the core tarball and a bun runtime. */
const LAUNCH_TIMEOUT_MS = 900_000;
/** How long the window gets to load the page and boot the app once it is up. */
const BOOT_TIMEOUT_MS = 90_000;

// The variable is annotated, not just the arrow: TypeScript only narrows on a
// never-returning call when the callee's declared type says never.
const fail: (message: string) => never = (message) => {
	console.error(`FAIL: native launch — ${message}`);
	process.exit(1);
};

const ok = (message: string): void => {
	console.log(`ok: ${message}`);
};

interface Options {
	readonly target: string | undefined;
}

const parseArgv = (argv: ReadonlyArray<string>): Options => {
	let target: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--target") {
			target = argv[(index += 1)];
		} else {
			fail(`unknown flag ${argv[index]}`);
		}
	}
	return { target: target ?? process.env.SMITHERS_APP_URL };
};

interface RecordedRequest {
	readonly method: string;
	readonly path: string;
}

const serveBuiltApp = (recorded: Array<RecordedRequest>) =>
	Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request: Request): Promise<Response> => {
			const path = new URL(request.url).pathname;
			recorded.push({ method: request.method, path });
			if (path === "/api/auth/session") {
				return Response.json({ status: "signed-out" });
			}
			if (path === "/api/client-errors") {
				return new Response(null, { status: 202 });
			}
			if (path.startsWith("/api/")) {
				// The honest 501 the product Worker gives for an unconfigured
				// seam. This smoke proves the shell boots, not the backend.
				return Response.json({ error: "This Smithers seam is not configured." }, { status: 501 });
			}
			const file = Bun.file(join(DIST_DIR, path === "/" ? "index.html" : path.slice(1)));
			if (await file.exists()) return new Response(file);
			// SPA fallback, the same as the product Worker's.
			return new Response(Bun.file(join(DIST_DIR, "index.html")));
		},
	});

/** Reads the app's stdout, echoes it, and resolves as each expected line arrives. */
const readLines = (
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
): Promise<void> =>
	(async () => {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				console.log(`  [app] ${line}`);
				onLine(line);
			}
			if (done) break;
		}
		if (buffer !== "") onLine(buffer);
	})();

const waitFor = async (
	description: string,
	predicate: () => boolean,
	timeoutMs: number,
): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	fail(`timed out after ${timeoutMs}ms waiting for ${description}.`);
};

const main = async (): Promise<void> => {
	if (process.platform !== "darwin") {
		console.log(
			"SKIP: the Electrobun launch smoke runs on macOS only — the app uses the system webview " +
				"(bundleCEF:false), which is WKWebView here and GTKWebKit on Linux, and neither exposes a " +
				"DevTools endpoint or a headless mode. Nothing on ubuntu-latest can drive this window.",
		);
		process.exit(0);
	}
	const options = parseArgv(process.argv.slice(2));

	if (!existsSync(join(DIST_DIR, "index.html"))) {
		fail("apps/ui/dist/index.html is missing. Run `bun run build` first.");
	}
	if (!existsSync(ELECTROBUN_BIN)) {
		fail(`${ELECTROBUN_BIN} is missing. Run the workspace install first.`);
	}
	ok("the built SPA is on disk and the electrobun CLI is installed.");

	const recorded: Array<RecordedRequest> = [];
	const server = options.target === undefined ? serveBuiltApp(recorded) : undefined;
	const appUrl = options.target ?? `http://127.0.0.1:${server?.port}/`;

	if (options.target !== undefined) {
		// CN-22: the deployed origin has to be serving the app before it is
		// worth launching a window at it.
		const response = await fetch(options.target).catch(() => undefined);
		if (response === undefined || !response.ok) {
			fail(`${options.target} did not serve a document (${response?.status ?? "no response"}).`);
		}
		const html = await response.text();
		if (!html.includes("<div id=\"root\">")) {
			fail(`${options.target} served a document with no Smithers root element.`);
		}
		ok(`the deployed origin ${options.target} serves the app document.`);
	}

	const lines: Array<string> = [];
	const child = Bun.spawn([ELECTROBUN_BIN, "dev"], {
		cwd: UI_DIR,
		env: { ...process.env, SMITHERS_APP_URL: appUrl },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdoutDone = readLines(child.stdout, (line) => lines.push(line));
	const stderrDone = readLines(child.stderr, (line) => lines.push(line));

	try {
		await waitFor(
			"the native app to report that it started",
			() => lines.includes("Smithers app started!"),
			LAUNCH_TIMEOUT_MS,
		);
		ok("the app built and the native process started.");

		// E12.2: the override branch is what start:canary and CN-22 both use.
		const expectedLog = `Loading the app from SMITHERS_APP_URL: ${appUrl}`;
		if (!lines.includes(expectedLog)) {
			fail(`the app never logged "${expectedLog}". SMITHERS_APP_URL did not reach the window.`);
		}
		ok(`the window resolved its URL from SMITHERS_APP_URL (${appUrl}).`);

		if (options.target === undefined) {
			const seen = (method: string, predicate: (path: string) => boolean): boolean =>
				recorded.some((request) => request.method === method && predicate(request.path));

			await waitFor(
				"the webview to request the app document",
				() => seen("GET", (path) => path === "/" || path === "/index.html"),
				BOOT_TIMEOUT_MS,
			);
			ok("the system webview loaded the app document.");

			await waitFor(
				"the webview to request the built javascript bundle",
				() => seen("GET", (path) => path.startsWith("/assets/") && path.endsWith(".js")),
				BOOT_TIMEOUT_MS,
			);
			ok("the system webview parsed the document and fetched the built bundle.");

			// main.tsx reaches loadSession only after createAppStore resolved and
			// the controller was constructed, so this request is proof the bundle
			// executed inside the shipped shell.
			await waitFor(
				"the app to make its boot session call",
				() => seen("GET", (path) => path === "/api/auth/session"),
				BOOT_TIMEOUT_MS,
			);
			ok("the app booted inside the window and called its identity seam.");

			// The runtime error ingest in main.tsx posts here on any uncaught
			// error or unhandled rejection while the page comes up.
			const crashes = recorded.filter((request) => request.path === "/api/client-errors");
			if (crashes.length > 0) {
				fail(`the page reported ${crashes.length} client error(s) while booting.`);
			}
			ok("nothing threw in the page while it came up.");
		} else {
			console.log(
				"note: with --target the page is served by the deployed origin, so its traffic is not " +
					"observable from here. Only the launch and the SMITHERS_APP_URL resolution are asserted.",
			);
		}

		// E12.6, dev half: the bundle the launcher runs really carries the SPA.
		const arch = process.arch === "arm64" ? "arm64" : "x64";
		const resources = join(UI_DIR, "build", `dev-macos-${arch}`, "Smithers-dev.app", "Contents", "Resources");
		if (!existsSync(join(resources, "app", "views", "mainview", "index.html"))) {
			fail("the dev app bundle does not contain views/mainview/index.html — the SPA never shipped.");
		}
		ok("the dev app bundle carries the built SPA at views/mainview/index.html.");

		const version = (await Bun.file(join(resources, "version.json")).json()) as {
			channel?: unknown;
			name?: unknown;
			identifier?: unknown;
		};
		if (version.channel !== "dev" || version.name !== "Smithers-dev" || version.identifier !== "sh.smithers.app") {
			fail(`version.json is ${JSON.stringify(version)}, not the dev channel for sh.smithers.app.`);
		}
		ok("the bundle stamps channel dev, name Smithers-dev and identifier sh.smithers.app.");
	} finally {
		try {
			process.kill(-(child.pid as number), "SIGKILL");
		} catch {
			// The CLI only becomes a group leader when it can open /dev/tty.
		}
		child.kill("SIGKILL");
		Bun.spawnSync(["pkill", "-f", "Smithers-dev.app/Contents/MacOS"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await Promise.race([
			Promise.all([stdoutDone, stderrDone]),
			new Promise((resolve) => setTimeout(resolve, 2_000)),
		]);
		server?.stop(true);
	}

	// The two modes prove different amounts, and the summary says which.
	console.log(
		options.target === undefined
			? "PASS: native launch — the desktop app built, launched, resolved its main-view URL from " +
					"SMITHERS_APP_URL, loaded the page in the system webview, and the SPA executed and " +
					"reached its identity seam without throwing."
			: `PASS: native launch (CN-22, --target ${options.target}) — the deployed origin serves the ` +
					"app document and the desktop app built, launched and pointed its window at that " +
					"origin. What the page did after loading is served remotely and is NOT asserted here; " +
					"run without --target for the render evidence.",
	);
	process.exit(0);
};

await main();
