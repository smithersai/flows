/*
 * The repo-import seam: POST /api/github/import {owner, repo} starts the job;
 * GET /api/github/import/{jobId} polls it. Progress lives on one upserted
 * "repo-import" card (phase starting → running → done | failed). Reference:
 * multi src/smithersCloud/githubImport.ts (startImport/pollImport) against
 * plue internal/routes/github_import.go.
 */
import type { Card, RepoImportState } from "../AppState";
import { resolveTargetRepo } from "../RepoContext";
import type { SeamContext } from "./SeamContext";
import { readErrorMessage } from "./SeamContext";

export interface RepoImportSeam {
	readonly importRepository: (repo?: string, options?: RepoImportOptions) => Promise<string | void>;
	/**
	 * Resolves when the repository's mirror stops being in flight: true the
	 * moment the import reaches `done`, false when it fails or stops being
	 * trackable.
	 *
	 * A silent import renders nothing (directive 5), so the frame that started
	 * one has no other way to learn the mirror landed. It holds this and re-runs
	 * the read that degraded on readiness. With no import recorded for the
	 * repository the promise simply never settles — the caller is an
	 * already-detached retry, and inventing a verdict it has no evidence for
	 * would be worse than waiting.
	 */
	readonly importSettled: (repo: string) => Promise<boolean>;
}

/**
 * How an import presents itself.
 *
 * will, 2026-08-19 (directive 5): "importing to smithers cloud just happens in
 * background — it's an implementation detail. the user feels like they are on
 * github". Opening a repository imports it SILENTLY: the same requests, the
 * same job tracking, the same honest degradation in the reads that depend on
 * it — but the progress lands in the `repoImports` collection, which nothing
 * renders, instead of on a transcript card the user never asked for.
 *
 * The explicit capability (the hidden `repos.import` flow) still gets its card:
 * someone who ASKS for an import is owed the answer.
 */
export interface RepoImportOptions {
	readonly silent?: boolean;
}

/**
 * Poll cadence knobs, module-level so tests can shorten the wait: one status
 * check every `delayMs`, at most `maxAttempts` checks, and `networkRetries`
 * consecutive failed polls tolerated before the loop stops tracking.
 */
export const repoImportPolling = {
	delayMs: 2_000,
	maxAttempts: 60,
	networkRetries: 2,
};

/** The honest sign-off when polling can no longer see the job. */
export const REPO_IMPORT_LOST_STREAM_DETAIL =
	"lost the import stream — it will retry when the repository is opened again";

type ImportPhase = "starting" | "running" | "done" | "failed";

/** Plue's import job answer, reduced to what the card tracks. The wire shape
 *  is the reference's ImportJob: {importJobId, status, stage?, error?, …}. */
interface ImportJobAnswer {
	readonly jobId: string;
	readonly status: "cloning" | "ready" | "failed";
	readonly stage: string | null;
	readonly error: string | null;
}

const parseImportJob = (body: unknown): ImportJobAnswer | null => {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
	const job = body as Record<string, unknown>;
	const jobId = job.importJobId;
	const status = job.status;
	if (typeof jobId !== "string" || jobId === "") return null;
	if (status !== "cloning" && status !== "ready" && status !== "failed") return null;
	return {
		jobId,
		status,
		stage: typeof job.stage === "string" && job.stage !== "" ? job.stage : null,
		error: typeof job.error === "string" && job.error !== "" ? job.error : null,
	};
};

/** Human detail per in-flight stage — the reference's importStageDetail map. */
const STAGE_DETAIL: Readonly<Record<string, string>> = {
	resolving: "Contacting GitHub…",
	creating_repo: "Creating mirror…",
	cloning_github: "Downloading from GitHub…",
	pushing_mirror: "Uploading to Smithers Cloud…",
	importing_refs: "Importing branches…",
	creating_bookmark: "Preparing default branch…",
	provisioning_workspace: "Provisioning workspace…",
};

const stageDetail = (job: ImportJobAnswer): string | null =>
	job.status === "cloning" && job.stage !== null ? (STAGE_DETAIL[job.stage] ?? null) : null;

const cardStatus = (phase: ImportPhase): "active" | "acted" | "error" =>
	phase === "done" ? "acted" : phase === "failed" ? "error" : "active";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createRepoImportSeam = (ctx: SeamContext): RepoImportSeam => {
	/*
	 * One tracking loop per repo: a re-run (the card's "Try again", or the
	 * command again) bumps the epoch so a superseded loop stops upserting a
	 * card the new run now owns.
	 */
	const epochs = new Map<string, number>();

	/*
	 * Readiness waiters, and the terminal verdict each repository's last import
	 * reached. Both are settled by the one `upsert` below, so the card path and
	 * the silent collection path answer a waiter identically, and a verdict
	 * already reached is answered without waiting for an import that is over.
	 */
	const waiters = new Map<string, Array<(ready: boolean) => void>>();
	const verdicts = new Map<string, boolean>();

	const settle = (repo: string, ready: boolean): void => {
		verdicts.set(repo, ready);
		const pending = waiters.get(repo);
		if (pending === undefined) return;
		waiters.delete(repo);
		for (const resolve of pending) resolve(ready);
	};

	const importSettled = (repo: string): Promise<boolean> => {
		const verdict = verdicts.get(repo);
		if (verdict !== undefined) return Promise.resolve(verdict);
		const background = ctx.store.collections.repoImports.get(repo);
		const card = ctx.store.collections.cards.get(`repo-import-${repo}`);
		const phase = background?.phase ?? (card?.kind === "repo-import" ? card.payload.phase : undefined);
		if (phase === "done") return Promise.resolve(true);
		if (phase === "failed") return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			const pending = waiters.get(repo);
			if (pending === undefined) waiters.set(repo, [resolve]);
			else pending.push(resolve);
		});
	};

	/*
	 * One progress writer, two destinations. A silent import writes readiness to
	 * the `repoImports` collection — real state, in the store, rendered by
	 * nothing. An explicit import writes the card it always wrote.
	 */
	const upsert = (
		repo: string,
		ordinal: number,
		createdAt: number,
		jobId: string | null,
		phase: ImportPhase,
		detail: string | null,
		silent: boolean,
	): void => {
		/*
		 * Readiness is a fact about the mirror, not about how the import is
		 * presented, so both destinations settle the waiters the same way. A
		 * lost stream is a `running` phase nothing will follow up — the waiter
		 * is told the read cannot be retried rather than left hanging.
		 */
		if (phase === "done") settle(repo, true);
		else if (phase === "failed" || detail === REPO_IMPORT_LOST_STREAM_DETAIL) settle(repo, false);
		if (silent) {
			const state: RepoImportState = { id: repo, jobId, phase, detail, updatedAt: Date.now() };
			ctx.dispatch({ type: "repo.import.progress", actor: ctx.actor(), state });
			return;
		}
		const card: Card = {
			id: `repo-import-${repo}`,
			kind: "repo-import",
			title: `Import · ${repo}`,
			status: cardStatus(phase),
			createdAt,
			// The creation-time ordinal, passed unchanged on every upsert so the
			// card never jumps around the transcript while the job progresses.
			ordinal,
			payload: { repo, jobId, phase, detail },
		};
		ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card });
	};

	const track = async (
		repo: string,
		jobId: string,
		ordinal: number,
		createdAt: number,
		epoch: number,
		silent: boolean,
	): Promise<void> => {
		let failures = 0;
		for (let attempt = 0; attempt < repoImportPolling.maxAttempts; attempt += 1) {
			await sleep(repoImportPolling.delayMs);
			if (epochs.get(repo) !== epoch) return;
			let job: ImportJobAnswer | null = null;
			try {
				const response = await ctx.http(
					`${ctx.baseUrl}/api/github/import/${encodeURIComponent(jobId)}`,
				);
				if (response.ok) job = parseImportJob(await response.json().catch(() => undefined));
			} catch {
				// A dropped poll is retried below; the job keeps running upstream.
			}
			if (epochs.get(repo) !== epoch) return;
			if (job === null) {
				failures += 1;
				if (failures <= repoImportPolling.networkRetries) continue;
				upsert(repo, ordinal, createdAt, jobId, "running", REPO_IMPORT_LOST_STREAM_DETAIL, silent);
				return;
			}
			failures = 0;
			if (job.status === "ready") {
				upsert(repo, ordinal, createdAt, jobId, "done", null, silent);
				return;
			}
			if (job.status === "failed") {
				upsert(repo, ordinal, createdAt, jobId, "failed", job.error ?? "The import failed upstream.", silent);
				return;
			}
			upsert(repo, ordinal, createdAt, jobId, "running", stageDetail(job) ?? job.error, silent);
		}
		// Attempts exhausted without a terminal status: same honest hand-off as a
		// lost stream — the command re-checks the job when run again.
		upsert(repo, ordinal, createdAt, jobId, "running", REPO_IMPORT_LOST_STREAM_DETAIL, silent);
	};

	const importRepository = async (
		explicit?: string,
		options?: RepoImportOptions,
	): Promise<string | void> => {
		const silent = options?.silent === true;
		const resolved = resolveTargetRepo(ctx.store, explicit);
		if ("error" in resolved) return resolved.error;
		const repo = resolved.repo;
		/*
		 * An import already under way (or already finished) is not started
		 * again, whichever half recorded it — so opening a repository twice
		 * makes one request, and asking for an explicit import after a silent
		 * one does not re-clone what is already there.
		 */
		const card = ctx.store.collections.cards.get(`repo-import-${repo}`);
		const background = ctx.store.collections.repoImports.get(repo);
		const settled = (phase: ImportPhase | undefined): boolean =>
			phase === "starting" || phase === "running" || phase === "done";
		if (card?.kind === "repo-import" && settled(card.payload.phase)) return undefined;
		if (settled(background?.phase)) return undefined;
		const [owner, name] = repo.split("/") as [string, string];

		const ordinal = ctx.nextOrdinal();
		const createdAt = Date.now();
		const epoch = (epochs.get(repo) ?? 0) + 1;
		epochs.set(repo, epoch);
		// A fresh run replaces the last run's verdict: this one is in flight again.
		verdicts.delete(repo);
		upsert(repo, ordinal, createdAt, null, "starting", null, silent);

		let response: Response;
		try {
			response = await ctx.http(`${ctx.baseUrl}/api/github/import`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ owner, repo: name }),
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const message = `The import couldn't start — ${reason}`;
			upsert(repo, ordinal, createdAt, null, "failed", message, silent);
			return message;
		}
		if (response.status === 409) {
			// Plue's conflict verdicts ("repository already exists",
			// "github_import_already_active") both mean the mirror is already
			// there or already on its way — stated honestly, not failed.
			upsert(repo, ordinal, createdAt, null, "done", "already imported", silent);
			return undefined;
		}
		if (!response.ok) {
			const message = await readErrorMessage(
				response,
				`The import couldn't start (HTTP ${response.status})`,
			);
			upsert(repo, ordinal, createdAt, null, "failed", message, silent);
			return message;
		}
		const job = parseImportJob(await response.json().catch(() => undefined));
		if (job === null) {
			const message = "The import answer was malformed — the job id never arrived.";
			upsert(repo, ordinal, createdAt, null, "failed", message, silent);
			return message;
		}
		if (job.status === "ready") {
			upsert(repo, ordinal, createdAt, job.jobId, "done", "already imported", silent);
			return undefined;
		}
		if (job.status === "failed") {
			const message = job.error ?? "The import failed upstream.";
			upsert(repo, ordinal, createdAt, job.jobId, "failed", message, silent);
			return message;
		}
		upsert(repo, ordinal, createdAt, job.jobId, "running", stageDetail(job), silent);
		// Fire-and-forget: the job started and the card tracks it — success now.
		void track(repo, job.jobId, ordinal, createdAt, epoch, silent);
		return undefined;
	};

	return { importRepository, importSettled };
};
