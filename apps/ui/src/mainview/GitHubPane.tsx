/*
 * The GitHub pane (will, 2026-08-19): "we should see a list of repos available
 * and if we click on it we see the repo view which will include tabs for
 * issues, prs, flows. Issues looks like issues tab etc. Everything is pretty
 * close to a github clone."
 *
 * Two frames, one surface. With no repository chosen it is the LIST — the
 * account's repositories, in the three columns the onboarding chooser already
 * shows (full name, freshness, open-issue count) and in the chooser's own row
 * styles. Choose one and it is the REPO VIEW: Files, Issues, Pull Requests,
 * Flows, each rendered by the card body that already renders that read
 * elsewhere. Per THE EMBED LAW it embeds in the transcript flow like every
 * other surface, with the same close affordance.
 */
import { Button } from "@smthrs/ui";
import { ChevronLeft, FolderGit2 } from "lucide-react";
import { RepoFilesBrowser } from "./RepoFilesBrowser";
import { freshnessLabel, WorkflowListCardBody } from "./ChatCards";
import { IssueListCardBody } from "./cards/IssueCards";
import { LandingListCardBody } from "./cards/LandingCards";
import { SurfaceHeader } from "./SurfaceChrome";
import type { AppController } from "./state/AppController";
import type { Card, RepoCatalogEntry, Session } from "./state/AppState";

const tabs = [
	["files", "Files"],
	["issues", "Issues"],
	["pulls", "Pull Requests"],
	["flows", "Flows"],
] as const;

/** One row of the repository list: what the catalog knows, never more. */
interface RepoRow {
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
	...available.map((entry) => ({ fullName: entry.fullName, pushedAt: entry.pushedAt, openIssues: entry.openIssues })),
	...watched
		.filter((name) => !available.some((entry) => entry.fullName === name))
		.map((name) => ({ fullName: name })),
];

export function GitHubPane({ controller, session, available, watched, cards }: {
	readonly controller: AppController;
	/* The shell projects the session without the draft, so the pane takes what it reads. */
	readonly session: Pick<Session, "selectedRepository" | "repositoryTab">;
	readonly available: ReadonlyArray<RepoCatalogEntry>;
	readonly watched: ReadonlyArray<string>;
	readonly cards: ReadonlyArray<Card>;
}) {
	/* The registry is the one run path; the panes below take a command, not a controller. */
	const run = (name: string, commandArgs?: string): void => {
		if (commandArgs === undefined) controller.runCommand(name);
		else controller.runCommandArgs(name, commandArgs);
	};
	const repo = session.selectedRepository;
	const rows = repositoryRows(available, watched);
	const latest = <K extends Card["kind"]>(kind: K): Extract<Card, { kind: K }> | undefined =>
		[...cards]
			.filter((card): card is Extract<Card, { kind: K }> => card.kind === kind)
			.filter((card) => (card.payload as { repo?: unknown }).repo === repo)
			.sort((left, right) => right.createdAt - left.createdAt)[0];
	const issueCard = latest("issue-list");
	const pullCard = latest("pr-list");
	const flowCard = latest("workflow-list");
	return <section className="github-pane embedded-pane" aria-label="GitHub repositories">
		<SurfaceHeader icon={<FolderGit2 size={17} aria-hidden="true" />} title="GitHub" subtitle={repo ?? "Repositories"} closeCommand="chat" onClose={() => controller.runCommand("chat")} />
		{repo === null ? <ul className="repo-chooser-list" aria-label="Your repositories">
			{rows.map((row) => <li key={row.fullName}>
				<button type="button" className="repo-chooser-row" data-flow="repo.open" onClick={() => controller.runCommandArgs("repo.open", row.fullName)}>
					<span className="repo-chooser-name">{row.fullName}</span>
					{row.pushedAt === undefined ? null : <span className="repo-chooser-freshness">{freshnessLabel(row.pushedAt)}</span>}
					{row.openIssues === undefined ? null : <span className="repo-chooser-issues">{row.openIssues} open issue{row.openIssues === 1 ? "" : "s"}</span>}
				</button>
			</li>)}
			{rows.length === 0 ? <li className="repo-chooser-empty">No repositories to browse yet.</li> : null}
		</ul> : <div className="world-workspace">
			<main className="world-document">
				<div className="world-card-row">
					<Button variant="ghost" size="sm" data-flow="github" onClick={() => controller.runCommand("github")}>
						<ChevronLeft size={14} aria-hidden="true" /> All repositories
					</Button>
				</div>
				<div className="world-card-row" role="tablist" aria-label="Repository sections">
					{tabs.map(([id, label]) => <Button key={id} variant="ghost" size="sm" data-flow="repo.tab" role="tab" aria-selected={session.repositoryTab === id} onClick={() => controller.runCommandArgs("repo.tab", id)}>{label}</Button>)}
				</div>
				{session.repositoryTab === "files" ? <RepoFilesBrowser repo={repo} cards={cards} onRunCommand={run} /> : null}
				{session.repositoryTab === "issues" ? issueCard ? <IssueListCardBody card={issueCard} onRunCommand={run} /> : <p className="world-card-empty">No issues have been read for this repository.</p> : null}
				{session.repositoryTab === "pulls" ? pullCard ? <LandingListCardBody card={pullCard} onRunCommand={run} /> : <p className="world-card-empty">No pull requests have been read for this repository.</p> : null}
				{session.repositoryTab === "flows" ? flowCard ? <WorkflowListCardBody card={flowCard} onRunWorkflow={(name) => run("flow.run", name)} /> : <p className="world-card-empty">No flows have been read for this repository.</p> : null}
			</main>
		</div>}
	</section>;
}
