/*
 * The repository list (will, 2026-08-19): "we should see a list of repos
 * available and if we click on it we see the repo view".
 *
 * One component, three mounts: the GitHub frame's list, the Files frame when
 * no repository is the target yet, and the recommendation-less landing — a
 * digest with nothing to recommend shows the repositories instead of saying
 * nothing needs you. The three columns are the chooser row's three columns,
 * in the chooser row's own styles; a row states what the catalog knows and
 * never more.
 */
import type { RepoCatalogEntry } from "./state/AppState";

/** One row of the repository list: what the catalog knows, never more. */
export interface RepoRow {
	readonly fullName: string;
	readonly pushedAt?: string | null;
	readonly openIssues?: number;
}

/*
 * The account's repositories, then the watched ones the catalog has not
 * answered for yet. A watched name with no catalog row still gets a row — it is
 * a repository the user really has — but only its name, because freshness and
 * an issue count nobody read would be invented.
 */
export const repositoryRows = (
	available: ReadonlyArray<RepoCatalogEntry>,
	watched: ReadonlyArray<string>,
): ReadonlyArray<RepoRow> => [
	...available.map((entry) => ({
		fullName: entry.fullName,
		pushedAt: entry.pushedAt,
		openIssues: entry.openIssues,
	})),
	...watched
		.filter((name) => !available.some((entry) => entry.fullName === name))
		.map((name) => ({ fullName: name })),
];

/** How long ago a repository was pushed to, in the chooser row's own words. */
export const freshnessLabel = (pushedAt: string | null): string => {
	if (pushedAt === null) return "never pushed";
	const days = Math.max(0, Math.floor((Date.now() - Date.parse(pushedAt)) / 86_400_000));
	if (Number.isNaN(days)) return "";
	if (days === 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
};

export function RepositoryList({
	rows,
	flow,
	label,
	emptyLabel = "No repositories to browse yet.",
	onOpen,
}: {
	readonly rows: ReadonlyArray<RepoRow>;
	/** The registered command each row runs; stamped as data-flow for the registry gate. */
	readonly flow: string;
	readonly label: string;
	readonly emptyLabel?: string;
	readonly onOpen: (fullName: string) => void;
}) {
	return (
		<ul className="repo-chooser-list" aria-label={label}>
			{rows.map((row) => (
				<li key={row.fullName}>
					<button
						type="button"
						className="repo-chooser-row"
						data-flow={flow}
						onClick={() => onOpen(row.fullName)}
					>
						<span className="repo-chooser-name">{row.fullName}</span>
						{row.pushedAt === undefined ? null : (
							<span className="repo-chooser-freshness">{freshnessLabel(row.pushedAt)}</span>
						)}
						{row.openIssues === undefined ? null : (
							<span className="repo-chooser-issues">
								{row.openIssues} open issue{row.openIssues === 1 ? "" : "s"}
							</span>
						)}
					</button>
				</li>
			))}
			{rows.length === 0 ? <li className="repo-chooser-empty">{emptyLabel}</li> : null}
		</ul>
	);
}
