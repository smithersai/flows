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

	let timedOut = false;
	let overflowed = false;
	let settled = false;
	let closedExitCode: number | null = null;
	let forceKill: ReturnType<typeof setTimeout> | undefined;

	/*
	 * Output capture is chunk-bounded, never string-accumulated: repeated
	 * `current + chunk` concatenation is quadratic in the capture size, and
	 * slicing a JS string cuts UTF-16 code units — a cap compared against
	 * Buffer.byteLength could then keep up to 3x the byte budget and split a
	 * surrogate pair. Chunks are appended until the byte budget is spent, the
	 * final chunk is cut on the budget, and decoding happens once at finish,
	 * where the TextDecoder turns a mid-sequence cut into a clean U+FFFD
	 * instead of invalid text.
	 */
	const createCapture = () => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		return {
			push: (chunk: Buffer): void => {
				if (bytes >= maxCaptureBytes) {
					// The budget is spent and the child is still writing: that IS the overflow.
					overflowed = true;
					beginTermination();
					return;
				}
				if (bytes + chunk.length <= maxCaptureBytes) {
					chunks.push(chunk);
					bytes += chunk.length;
					return;
				}
				const room = maxCaptureBytes - bytes;
				if (room > 0) {
					chunks.push(chunk.subarray(0, room));
					bytes = maxCaptureBytes;
				}
				overflowed = true;
				beginTermination();
			},
			text: (): string => new TextDecoder("utf8").decode(Buffer.concat(chunks, bytes)),
		};
	};
	const stdoutCapture = createCapture();
	const stderrCapture = createCapture();

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
		const stdout = stdoutCapture.text();
		const stderr = stderrCapture.text();
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
	child.stdout.on("data", (chunk: Buffer) => { stdoutCapture.push(chunk); });
	child.stderr.on("data", (chunk: Buffer) => { stderrCapture.push(chunk); });
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
