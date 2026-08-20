/*
 * The native main process — apps/ui/src/bun/index.ts — asserted for real.
 *
 * This is the shipped alpha artifact's privileged half and it had no coverage
 * of any kind. It cannot be imported here: it is a top-level-await module that
 * builds the window as an import side effect, and `electrobun/bun` dlopens a
 * native wrapper. So each scenario runs the REAL entrypoint in a subprocess
 * against a recording host fake (e2e/native/MainProcess.ts) and reports what
 * the entrypoint did.
 *
 * Nothing the product decides is faked. The fake supplies only what a headless
 * machine lacks — the window, the directory dialog, the updater and the system
 * browser — so every expectation below fails when the entrypoint changes
 * behaviour, and none of them can pass on a double's say-so.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROBE_MARKER } from "../../e2e/native/Probe.ts";
import type { NativeProbeReport, ProbeScenario } from "../../e2e/native/Probe.ts";

const UI_DIR = fileURLToPath(new URL("../../", import.meta.url));
const DRIVER = join(UI_DIR, "e2e", "native", "MainProcess.ts");

/** The bundled view copied into Resources/app/views/mainview at build time. */
const BUNDLED_VIEW = "views://mainview/index.html";
/*
 * §27.1: a channel build is a build FOR a deployment. Loading the bundled view
 * gave the app no backend at all — every relative `/api/*` fetch resolved
 * against the `views://` scheme and failed on startup.
 */
const CANARY_ORIGIN = "https://canary.smithers.sh";
const DEV_SERVER_URL = "http://localhost:5173";

interface ProbeOptions {
	/** Raw $SMITHERS_APP_URL. Absent leaves the variable unset. */
	readonly appUrl?: string;
	readonly scenario?: ProbeScenario;
}

const cache = new Map<string, Promise<NativeProbeReport>>();

const spawnProbe = async (options: ProbeOptions): Promise<NativeProbeReport> => {
	const child = Bun.spawn([process.execPath, DRIVER], {
		cwd: UI_DIR,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			SMITHERS_NATIVE_PROBE: JSON.stringify(options.scenario ?? {}),
			SMITHERS_CHAT_URL: "https://chat.test/chat",
			SMITHERS_CHAT_ORIGIN: "https://app.test",
			...(options.appUrl === undefined ? {} : { SMITHERS_APP_URL: options.appUrl }),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	const line = stdout.split("\n").find((candidate) => candidate.startsWith(PROBE_MARKER));
	if (line === undefined) {
		throw new Error(
			`the native main process printed no report (exit ${exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
		);
	}
	return JSON.parse(line.slice(PROBE_MARKER.length)) as NativeProbeReport;
};

/** Scenarios are pure, so identical ones share one subprocess. */
const probe = (options: ProbeOptions): Promise<NativeProbeReport> => {
	const key = JSON.stringify(options);
	const existing = cache.get(key);
	if (existing !== undefined) return existing;
	const started = spawnProbe(options);
	cache.set(key, started);
	return started;
};

const temporaryDirectories: Array<string> = [];

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<void> => {
	const child = Bun.spawn(["git", "-C", cwd, ...args], {
		env: {
			...(Bun.env as Record<string, string | undefined>),
			GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
};

/** A throwaway repository, never the working copy this test runs inside. */
const makeRepository = async (): Promise<string> => {
	const directory = await mkdtemp(join(tmpdir(), "smithers-main-"));
	temporaryDirectories.push(directory);
	await git(directory, ["init", "-b", "main"]);
	await git(directory, [
		"-c",
		"user.email=e2e@smithers.test",
		"-c",
		"user.name=E2E",
		"commit",
		"--allow-empty",
		"-m",
		"root",
	]);
	return directory;
};

afterAll(async () => {
	for (const directory of temporaryDirectories) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("the native main process resolves its main-view URL", () => {
	/*
	 * E12.2. `start:canary` is SMITHERS_APP_URL=https://canary.smithers.sh
	 * electrobun dev. If this branch stops winning, or stops trimming, the
	 * native window silently loads the local bundle instead of the deployed
	 * origin and the signed-in dev loop cannot complete OAuth at all.
	 */
	test("an explicit SMITHERS_APP_URL wins, trimmed, without consulting the channel", async () => {
		const report = await probe({
			appUrl: "  https://canary.smithers.test  ",
			scenario: { channel: "dev", devServer: "up" },
		});
		expect(report.windows).toHaveLength(1);
		expect(report.windows[0]?.url).toBe("https://canary.smithers.test");
		expect(report.channelCalls).toBe(0);
		expect(report.devProbeCalls).toBe(0);
		expect(report.logs).toContain(
			"Loading the app from SMITHERS_APP_URL: https://canary.smithers.test",
		);
	});

	test("a blank SMITHERS_APP_URL is not an override — the channel decides", async () => {
		for (const appUrl of ["", "   "]) {
			const report = await probe({ appUrl, scenario: { channel: "canary" } });
			expect(report.windows[0]?.url).toBe(CANARY_ORIGIN);
			expect(report.channelCalls).toBe(1);
		}
	});

	/* E12.5: the dev channel is the only channel that may prefer a live server. */
	test("the dev channel loads the vite dev server when one answers", async () => {
		const report = await probe({ scenario: { channel: "dev", devServer: "up" } });
		expect(report.windows[0]?.url).toBe(DEV_SERVER_URL);
		expect(report.devProbeCalls).toBe(1);
		expect(report.logs).toContain(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
	});

	test("the dev channel falls back to the bundled view when no dev server answers", async () => {
		const report = await probe({ scenario: { channel: "dev", devServer: "down" } });
		expect(report.windows[0]?.url).toBe(BUNDLED_VIEW);
		expect(report.devProbeCalls).toBe(1);
		expect(report.logs).toContain(
			"Vite dev server not running. Run 'bun run dev:hmr' for HMR support.",
		);
	});

	/*
	 * A shipped canary or stable build must never reach for a developer's
	 * machine-local dev server; that probe is a stall on every launch and a
	 * blank window if anything ever answers on 5173.
	 */
	test("a non-dev channel never probes for a dev server", async () => {
		for (const channel of ["canary", "stable"]) {
			const report = await probe({ scenario: { channel, devServer: "up" } });
			expect(report.devProbeCalls).toBe(0);
		}
	});

	/*
	 * §27.1: the canary build loads the canary deployment, because the bundled
	 * view has no origin to resolve `/api/*` against and the app cannot even
	 * read a session from it.
	 */
	test("the canary channel loads the canary deployment", async () => {
		const report = await probe({ scenario: { channel: "canary", devServer: "up" } });
		expect(report.windows[0]?.url).toBe(CANARY_ORIGIN);
		expect(report.logs).toContain(`Loading the canary channel from ${CANARY_ORIGIN}`);
	});

	/*
	 * No production origin is declared anywhere in this repo, and guessing one
	 * would ship an app pointed at a host that may not be ours.
	 */
	test("a channel with no declared origin keeps the bundled view", async () => {
		const report = await probe({ scenario: { channel: "stable", devServer: "up" } });
		expect(report.windows[0]?.url).toBe(BUNDLED_VIEW);
		expect(report.logs).toEqual(["Smithers app started!"]);
	});

	/*
	 * Updater.getLocalInfo() answers channel "" rather than throwing when the
	 * bundle has no readable version.json, so "" must land on the bundled view.
	 */
	test("an unreadable version.json reports an empty channel and loads the bundled view", async () => {
		const report = await probe({ scenario: { channel: "", devServer: "up" } });
		expect(report.windows[0]?.url).toBe(BUNDLED_VIEW);
		expect(report.devProbeCalls).toBe(0);
	});
});

describe("the native main process builds the window", () => {
	test("one window carries the shipped title, frame and the rpc object it defined", async () => {
		const report = await probe({ scenario: { channel: "canary" } });
		expect(report.windows).toHaveLength(1);
		expect(report.windows[0]?.title).toBe("Smithers");
		expect(report.windows[0]?.frame).toEqual({ width: 1180, height: 800, x: 100, y: 60 });
		// E12.3: the seams bind to the window. An unbound rpc is a window whose
		// repository picker, sign-in door and agent stream are all dead.
		expect(report.windows[0]?.rpcBound).toBe(true);
		expect(report.logs).toContain("Smithers app started!");
	});
});

describe("the native RPC surface", () => {
	/*
	 * E12.3. SmithersNativeRPC declares four bun-side requests. A handler
	 * dropped in a refactor is invisible everywhere else: the renderer's call
	 * rejects at runtime inside the packaged app and nothing in CI notices.
	 */
	test("every request the schema declares has a handler bound to the window", async () => {
		const report = await probe({ scenario: { channel: "canary" } });
		expect([...report.requestNames].sort()).toEqual([
			"cancelAgentTurn",
			"openExternal",
			"pickLocalRepository",
			"startAgentTurn",
		]);
		expect(report.messageNames).toEqual([]);
	});

	/* E12.4: the dialog must offer folders, never files. */
	test("the repository picker asks the host for a directory, not a file", async () => {
		const report = await probe({
			scenario: {
				channel: "canary",
				dialogPaths: ["/nonexistent-smithers-probe"],
				exercises: [
					{ label: "pick", request: "pickLocalRepository", params: { access: "read" } },
				],
			},
		});
		expect(report.dialogOptions).toEqual([
			{ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false },
		]);
	});

	test("a dismissed directory dialog answers cancelled", async () => {
		for (const dialogPaths of [[], [""], ["   "]]) {
			const report = await probe({
				scenario: {
					channel: "canary",
					dialogPaths,
					exercises: [
						{ label: "pick", request: "pickLocalRepository", params: { access: "read" } },
					],
				},
			});
			expect(report.results.pick).toEqual({ status: "cancelled" });
			// A cancel must not be reported as an error, and must not inspect.
			expect(report.dialogOptions).toHaveLength(1);
		}
	});

	/*
	 * E12.4. The picker is the only path by which the desktop app learns about
	 * a repository, and it runs real git against a real directory.
	 */
	test("a chosen directory is inspected for real and reports its head and branch", async () => {
		const repository = await makeRepository();
		const report = await probe({
			scenario: {
				channel: "canary",
				dialogPaths: [repository],
				exercises: [
					{ label: "pick", request: "pickLocalRepository", params: { access: "read-write" } },
				],
			},
		});
		const root = await realpath(repository);
		expect(report.results.pick).toMatchObject({
			status: "connected",
			repository: { root, name: basename(root), branch: "main", remoteUrl: null },
		});
		const picked = report.results.pick as { repository: { head: string } };
		expect(picked.repository.head).toMatch(/^[0-9a-f]{40}$/);
	});

	/*
	 * The privileged side must not be a launcher for arbitrary local schemes:
	 * the renderer loads a REMOTE origin under SMITHERS_APP_URL, so a page that
	 * turns hostile could otherwise ask the host to open file:// or a custom
	 * protocol handler.
	 */
	test("openExternal refuses every scheme but http and https", async () => {
		const refused = ["file:///etc/passwd", "smithers://x", "javascript:alert(1)", "not a url", ""];
		const report = await probe({
			scenario: {
				channel: "canary",
				exercises: refused.map((url, index) => ({
					label: `refuse-${index}`,
					request: "openExternal",
					params: { url },
				})),
			},
		});
		for (let index = 0; index < refused.length; index += 1) {
			expect(report.results[`refuse-${index}`]).toEqual({ opened: false });
		}
		expect(report.openedExternally).toEqual([]);
	});

	test("openExternal hands a web URL to the host browser and reports what it answered", async () => {
		const report = await probe({
			scenario: {
				channel: "canary",
				openExternalAnswer: true,
				exercises: [
					{
						label: "https",
						request: "openExternal",
						params: { url: "https://smithers.sh/sign-in?next=%2Fapp" },
					},
					{ label: "http", request: "openExternal", params: { url: "http://localhost:5173/" } },
				],
			},
		});
		expect(report.results.https).toEqual({ opened: true });
		expect(report.results.http).toEqual({ opened: true });
		expect(report.openedExternally).toEqual([
			"https://smithers.sh/sign-in?next=%2Fapp",
			"http://localhost:5173/",
		]);
	});

	test("openExternal reports a refusal by the host as not opened", async () => {
		const report = await probe({
			scenario: {
				channel: "canary",
				openExternalAnswer: false,
				exercises: [
					{ label: "denied", request: "openExternal", params: { url: "https://smithers.sh/" } },
				],
			},
		});
		expect(report.results.denied).toEqual({ opened: false });
	});
});

describe("the native agent seam reaches the window", () => {
	/*
	 * E12.3. `publishAgentFrame = rpc.proxy.send.agentFrame` is one line with no
	 * other witness: drop it, or construct the agent after the window, and every
	 * native chat turn streams into a no-op. The packaged app then shows an
	 * empty reply for every message while every unit test stays green.
	 */
	test("agent frames reach the webview through rpc.proxy.send.agentFrame", async () => {
		const report = await probe({
			scenario: {
				channel: "canary",
				agentStream: [
					{ type: "delta", kind: "reasoning", text: "hmm" },
					{ type: "delta", kind: "text", text: "hi" },
					{ type: "done" },
				],
				settleMs: 200,
				exercises: [
					{
						label: "start",
						request: "startAgentTurn",
						params: {
							runId: "run-1",
							messages: [{ role: "user", content: "hi" }],
							instructions: "Be brief.",
						},
					},
				],
			},
		});
		expect(report.results.start).toEqual({ status: "started" });
		expect(report.frames).toEqual([
			{ runId: "run-1", type: "delta", kind: "reasoning", text: "hmm" },
			{ runId: "run-1", type: "delta", kind: "text", text: "hi" },
			{ runId: "run-1", type: "done" },
		]);
	});

	/*
	 * The entrypoint is the only place SMITHERS_CHAT_URL and SMITHERS_CHAT_ORIGIN
	 * are read. A turn sent to the default upstream from a canary build reaches
	 * the wrong worker, and the run id header is what the worker traces on.
	 */
	test("a turn is sent to the configured chat upstream carrying its run id", async () => {
		const report = await probe({
			scenario: {
				channel: "canary",
				agentStream: [{ type: "done" }],
				settleMs: 200,
				exercises: [
					{
						label: "start",
						request: "startAgentTurn",
						params: {
							runId: "run-7",
							messages: [{ role: "user", content: "hi" }],
							instructions: "Be brief.",
						},
					},
				],
			},
		});
		expect(report.chatRequests).toEqual([{ url: "https://chat.test/chat", runId: "run-7" }]);
	});

	test("cancelAgentTurn reports not-found for a run that is not streaming", async () => {
		const report = await probe({
			scenario: {
				channel: "canary",
				exercises: [
					{ label: "cancel", request: "cancelAgentTurn", params: { runId: "nope" } },
				],
			},
		});
		expect(report.results.cancel).toEqual({ status: "not-found" });
	});

	test("cancelAgentTurn stops a streaming turn", async () => {
		const report = await probe({
			scenario: {
				channel: "canary",
				agentStream: [{ type: "delta", kind: "text", text: "hi" }],
				settleMs: 200,
				exercises: [
					{
						label: "start",
						request: "startAgentTurn",
						params: {
							runId: "run-9",
							messages: [{ role: "user", content: "hi" }],
							instructions: "Be brief.",
						},
					},
					{ label: "cancel", request: "cancelAgentTurn", params: { runId: "run-9" } },
				],
			},
		});
		expect(report.results.start).toEqual({ status: "started" });
		expect(report.results.cancel).toEqual({ status: "cancelled" });
	});
});
