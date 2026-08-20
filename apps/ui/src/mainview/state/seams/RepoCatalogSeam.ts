/*
 * The repository-catalog seam: the reco service's two answers to "which
 * repositories does this account have, and which does it watch" —
 * GET /api/reco/repos, GET /api/reco/watched, PUT /api/reco/watched.
 *
 * One seam, two consumers: the onboarding chooser asks the user to pick from
 * this list, and the GitHub pane lets them browse it. Network ownership lives
 * here rather than in the controller (AGENTS.md: no fetch outside a seam), and
 * `undefined` is kept distinct from `[]` throughout — "the service did not
 * answer" is not "the account has no repositories".
 */
import type { SeamContext } from "./SeamContext";

/** One candidate row as the reco service reports it. */
export interface RepoCandidate {
	readonly fullName: string;
	readonly private: boolean;
	readonly pushedAt: string | null;
	readonly openIssues: number;
}

/** The reco seam's candidate rows, validated; anything off-shape is dropped. */
export const parseRepoCandidates = (wire: unknown): RepoCandidate[] =>
	(Array.isArray(wire) ? wire : [])
		.filter(
			(candidate) =>
				typeof candidate === "object" &&
				candidate !== null &&
				typeof (candidate as { fullName?: unknown }).fullName === "string",
		)
		.map((candidate) => {
			const row = candidate as {
				fullName: string;
				private?: unknown;
				pushedAt?: unknown;
				openIssues?: unknown;
			};
			return {
				fullName: row.fullName,
				private: row.private === true,
				pushedAt: typeof row.pushedAt === "string" ? row.pushedAt : null,
				openIssues: typeof row.openIssues === "number" ? row.openIssues : 0,
			};
		});

/** The echo a saved selection answers with, reduced to what the store keeps. */
export interface SavedSelection {
	readonly selected: ReadonlyArray<string>;
	readonly selectedAt: string | null;
	/** The service's own echo of who chose; the caller keeps its own on null. */
	readonly via: string | null;
}

export interface RepoCatalogSeam {
	/** The account's repositories, or `undefined` when the service didn't answer. */
	readonly readCandidates: () => Promise<RepoCandidate[] | undefined>;
	/** The watched selection, or `undefined` when the service didn't answer. */
	readonly readWatchedSelection: () => Promise<string[] | undefined>;
	/**
	 * Fill the catalog the repository list projects. Background work behind an
	 * already-open surface: a read that cannot answer leaves the list as it was
	 * and the surface states its own honest empty state, never an error the
	 * user did not ask for.
	 */
	readonly loadCatalog: () => Promise<void>;
	/** Save the chooser's selection; the error string is the honest failure. */
	readonly saveWatchedSelection: (
		selected: ReadonlyArray<string>,
		via: string | null,
	) => Promise<SavedSelection | { readonly error: string }>;
}

/*
 * The controller's own failure wording, kept verbatim as the read moved in
 * here: a JSON `message` speaks for itself, anything else is the fallback with
 * the bounded body in parentheses.
 */
const SAVE_FALLBACK = "The selection didn't save. Try again.";

const failureMessage = async (response: Response): Promise<string> => {
	const body = (await response.text().catch(() => "")).trim();
	try {
		const parsed: unknown = JSON.parse(body);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"message" in parsed &&
			typeof parsed.message === "string"
		) {
			return parsed.message;
		}
	} catch {
		// A non-JSON error body carries no better message than the fallback.
	}
	return body === "" ? SAVE_FALLBACK : `${SAVE_FALLBACK} (${body.slice(0, 200)})`;
};

export const createRepoCatalogSeam = (
	ctx: SeamContext,
	paths: { readonly repos: string; readonly watched: string },
): RepoCatalogSeam => {
	const readCandidates = async (): Promise<RepoCandidate[] | undefined> => {
		const response = await ctx.http(`${ctx.baseUrl}${paths.repos}`);
		if (!response.ok) {
			await response.body?.cancel();
			return undefined;
		}
		const body = (await response.json().catch(() => undefined)) as { candidates?: unknown } | undefined;
		return parseRepoCandidates(body?.candidates);
	};

	const readWatchedSelection = async (): Promise<string[] | undefined> => {
		const response = await ctx.http(`${ctx.baseUrl}${paths.watched}`);
		if (!response.ok) {
			await response.body?.cancel();
			return undefined;
		}
		const body = (await response.json().catch(() => undefined)) as { selected?: unknown } | undefined;
		if (!Array.isArray(body?.selected)) return undefined;
		return body.selected.filter((name): name is string => typeof name === "string");
	};

	const loadCatalog = async (): Promise<void> => {
		if (ctx.store.collections.identitySessions.get("identity")?.state !== "signed-in") return;
		let available: RepoCandidate[] | undefined;
		try {
			available = await readCandidates();
		} catch {
			return;
		}
		if (available === undefined) return;
		ctx.dispatch({
			type: "repos.catalog.loaded",
			actor: ctx.actor(),
			available: available.map((candidate) => ({
				fullName: candidate.fullName,
				pushedAt: candidate.pushedAt,
				openIssues: candidate.openIssues,
			})),
		});
	};

	const saveWatchedSelection = async (
		selected: ReadonlyArray<string>,
		via: string | null,
	): Promise<SavedSelection | { readonly error: string }> => {
		let response: Response;
		try {
			response = await ctx.http(`${ctx.baseUrl}${paths.watched}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ selected, via }),
			});
		} catch {
			return { error: "The selection didn't save — the recommendations service is unreachable." };
		}
		if (!response.ok) return { error: await failureMessage(response) };
		const echoed = (await response.json().catch(() => undefined)) as
			| { selected?: unknown; selectedAt?: unknown; via?: unknown }
			| undefined;
		return {
			selected: Array.isArray(echoed?.selected)
				? echoed.selected.filter((name): name is string => typeof name === "string")
				: selected,
			selectedAt: typeof echoed?.selectedAt === "string" ? echoed.selectedAt : null,
			via: typeof echoed?.via === "string" ? echoed.via : null,
		};
	};

	return { readCandidates, readWatchedSelection, loadCatalog, saveWatchedSelection };
};
