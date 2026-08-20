import { Button } from "@smthrs/ui";
import { FolderGit2 } from "lucide-react";
import { RepoFilesBrowser } from "./RepoFilesBrowser";
import { IssueListCardBody } from "./cards/IssueCards";
import { LandingListCardBody } from "./cards/LandingCards";
import { SurfaceHeader } from "./SurfaceChrome";
import type { AppController } from "./state/AppController";
import type { Card, Session } from "./state/AppState";

const tabs = [
	["files", "Files"],
	["issues", "Issues"],
	["pulls", "Pull Requests"],
	["flows", "Flows"],
] as const;

export function GitHubPane({ controller, session, watched, cards }: {
	readonly controller: AppController;
	/* The shell projects the session without the draft, so the pane takes what it reads. */
	readonly session: Pick<Session, "selectedRepository" | "repositoryTab">;
	readonly watched: ReadonlyArray<string>;
	readonly cards: ReadonlyArray<Card>;
}) {
	/* The registry is the one run path; the panes below take a command, not a controller. */
	const run = (name: string, commandArgs?: string): void => {
		if (commandArgs === undefined) controller.runCommand(name);
		else controller.runCommandArgs(name, commandArgs);
	};
	const repo = session.selectedRepository;
	const issueCard = [...cards].filter((card): card is Extract<Card, { kind: "issue-list" }> => card.kind === "issue-list" && card.payload.repo === repo).sort((a, b) => b.createdAt - a.createdAt)[0];
	const pullCard = [...cards].filter((card): card is Extract<Card, { kind: "pr-list" }> => card.kind === "pr-list" && card.payload.repo === repo).sort((a, b) => b.createdAt - a.createdAt)[0];
	const flowCard = [...cards].find((card) => card.kind === "workflow-list");
	return <section className="github-pane embedded-pane" aria-label="GitHub repositories">
		<SurfaceHeader icon={<FolderGit2 size={17} aria-hidden="true" />} title="GitHub" subtitle="Repositories" closeCommand="chat" onClose={() => controller.runCommand("chat")} />
		<div className="world-workspace">
			<aside className="world-sidebar" aria-label="Repositories">
				{watched.map((name) => <Button key={name} variant="ghost" size="sm" data-flow="repo.open" onClick={() => controller.runCommandArgs("repo.open", name)}>{name}</Button>)}
				{watched.length === 0 ? <p className="world-card-empty">No repositories are watched yet.</p> : null}
			</aside>
			<main className="world-document">
				{repo === null ? <p className="world-card-empty">Choose a repository.</p> : <>
					<div className="world-card-row" role="tablist" aria-label="Repository sections">
						{tabs.map(([id, label]) => <Button key={id} variant="ghost" size="sm" data-flow="repo.tab" role="tab" aria-selected={session.repositoryTab === id} onClick={() => controller.runCommandArgs("repo.tab", id)}>{label}</Button>)}
					</div>
					{session.repositoryTab === "files" ? <RepoFilesBrowser repo={repo} cards={cards} onRunCommand={run} /> : null}
					{session.repositoryTab === "issues" ? issueCard ? <IssueListCardBody card={issueCard} onRunCommand={run} /> : <p className="world-card-empty">No issues have been read for this repository.</p> : null}
					{session.repositoryTab === "pulls" ? pullCard ? <LandingListCardBody card={pullCard} onRunCommand={run} /> : <p className="world-card-empty">No pull requests have been read for this repository.</p> : null}
					{session.repositoryTab === "flows" ? flowCard ? <p className="world-card-empty">Workflow definitions are available in the transcript.</p> : <p className="world-card-empty">No per-repository flow data exists yet.</p> : null}
				</>}
			</main>
		</div>
	</section>;
}
