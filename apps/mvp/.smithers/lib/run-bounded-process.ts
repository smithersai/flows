import { spawn } from "node:child_process";

export interface BoundedProcessResult {
	rendered: string;
	passed: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	summary: string;
	timedOut: boolean;
	overflowed: boolean;
}

export interface BoundedProcessOptions {
	timeoutMs: number;
	maxCaptureBytes?: number;
	terminationGraceMs?: number;
}

/**
 * Runs one deterministic command in its own process group.
 *
 * The group boundary is important: package managers and bundlers spawn their
 * own workers. Killing only the direct child reports a timeout while leaving
 * those workers alive to starve later workflow nodes.
 */
export const runBoundedProcess = (
	command: string,
	args: readonly string[],
	cwd: string,
	options: BoundedProcessOptions,
): Promise<BoundedProcessResult> => new Promise((resolve) => {
	const rendered = [command, ...args].join(" ");
	const maxCaptureBytes = options.maxCaptureBytes ?? 32 * 1024 * 1024;
	const terminationGraceMs = options.terminationGraceMs ?? 5_000;
	const grouped = process.platform !== "win32";
	const child = spawn(command, [...args], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		detached: grouped,
	});

	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let overflowed = false;
	let settled = false;
	let closedExitCode: number | null = null;
	let forceKill: ReturnType<typeof setTimeout> | undefined;

	const signalProcessGroup = (signal: NodeJS.Signals) => {
		if (child.pid === undefined) return;
		try {
			if (grouped) process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch {
			try { child.kill(signal); } catch { /* process already exited */ }
		}
	};
	const processGroupAlive = () => {
		if (!grouped || child.pid === undefined) return child.exitCode === null;
		try {
			process.kill(-child.pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const finish = (exitCode: number | null, launchError?: Error) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		if (forceKill !== undefined) clearTimeout(forceKill);
		const passed = exitCode === 0 && launchError === undefined && !timedOut && !overflowed;
		const failureDetail = launchError?.message || stderr || stdout || "unknown failure";
		resolve({
			rendered,
			passed,
			exitCode,
			stdout,
			stderr,
			timedOut,
			overflowed,
			summary: passed
				? `${rendered} completed successfully.`
				: timedOut
					? `${rendered} exceeded its ${options.timeoutMs}ms deterministic command budget.`
					: overflowed
						? `${rendered} exceeded the ${maxCaptureBytes}-byte output capture budget.`
						: `${rendered} failed: ${failureDetail.trim().slice(0, 2_000)}`,
		});
	};
	const beginTermination = () => {
		if (forceKill !== undefined) return;
		signalProcessGroup("SIGTERM");
		forceKill = setTimeout(() => {
			signalProcessGroup("SIGKILL");
			finish(closedExitCode);
		}, terminationGraceMs);
	};
	const append = (current: string, chunk: Buffer) => {
		const next = current + chunk.toString("utf8");
		if (Buffer.byteLength(next) > maxCaptureBytes) {
			overflowed = true;
			beginTermination();
			return next.slice(0, maxCaptureBytes);
		}
		return next;
	};

	child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
	child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
	const timeout = setTimeout(() => {
		timedOut = true;
		beginTermination();
	}, options.timeoutMs);
	child.once("error", (error) => finish(null, error));
	child.once("close", (exitCode) => {
		closedExitCode = exitCode;
		if ((timedOut || overflowed) && processGroupAlive()) return;
		finish(exitCode);
	});
});
