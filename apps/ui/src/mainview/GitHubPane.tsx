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
 * elsewhere.
 *
 * THE EMBED LAW: this is a transcript entry, not a second column. App.tsx
 * mounts it as the last child of the ChatTranscript, so it renders in the
 * message flow at conversation width with the composer still below it, and the
 * close affordance returns the conversation to itself.
 */
import { Button } from "@smthrs/ui";
import { ChevronLeft, FolderGit2 } from "lucide-react";
import { RepoFilesBrowser } from "./RepoFilesBrowser";
import { RepositoryList, repositoryRows } from "./RepositoryList";
import { WorkflowListCardBody } from "./ChatCards";
import { IssueListCardBody } from "./cards/IssueCards";
import { LandingListCardBody } from "./cards/LandingCards";
import { SurfaceHeader } from "./SurfaceChrome";
import type { AppController } from "./state/AppController";
import type { Card, RepoCatalogEntry, Session } from "./state/AppState";

export { repositoryRows } from "./RepositoryList";

const tabs = [
	["files", "Files"],
	["issues", "Issues"],
	["pulls", "Pull Requests"],
	["flows", "Flows"],
] as const;

/** The one class the transcript-embedded frames wear; see styles/chat.css. */
export const TRANSCRIPT_PANE_CLASS = "github-pane transcript-pane";

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
	return <section className={TRANSCRIPT_PANE_CLASS} aria-label="GitHub repositories">
		<SurfaceHeader icon={<FolderGit2 size={17} aria-hidden="true" />} title="GitHub" subtitle={repo ?? "Repositories"} closeCommand="chat" onClose={() => controller.runCommand("chat")} />
		{repo === null ? (
			<RepositoryList
				rows={rows}
				flow="repo.open"
				label="Your repositories"
				onOpen={(fullName) => controller.runCommandArgs("repo.open", fullName)}
			/>
		) : <div className="world-workspace">
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

/*
 * The Files frame (will, 2026-08-19): "clicking world is cool. we should be
 * able to also click files and view the repo". It is the SAME
 * RepoFilesBrowser the repository view's Files tab renders — one component,
 * two mounts — and it embeds in the transcript on the same terms.
 *
 * With no repository resolved (nothing watched, or several and no explicit
 * target) it shows the repository list rather than guessing one: choosing is
 * the user's act, and `files <owner/repo>` is the command each row runs.
 */
export function RepoFilesPane({ controller, session, available, watched, cards }: {
	readonly controller: AppController;
	readonly session: Pick<Session, "selectedRepository">;
	readonly available: ReadonlyArray<RepoCatalogEntry>;
	readonly watched: ReadonlyArray<string>;
	readonly cards: ReadonlyArray<Card>;
}) {
	const repo = session.selectedRepository;
	return (
		<section className={TRANSCRIPT_PANE_CLASS} aria-label="Repository files">
			<SurfaceHeader
				icon={<FolderGit2 size={17} aria-hidden="true" />}
				title="Files"
				subtitle={repo ?? "Choose a repository"}
				closeCommand="chat"
				onClose={() => controller.runCommand("chat")}
			/>
			{repo === null ? (
				<RepositoryList
					rows={repositoryRows(available, watched)}
					flow="files"
					label="Your repositories"
					onOpen={(fullName) => controller.runCommandArgs("files", fullName)}
				/>
			) : (
				<RepoFilesBrowser
					repo={repo}
					cards={cards}
					onRunCommand={(name, commandArgs) =>
						commandArgs === undefined
							? controller.runCommand(name)
							: controller.runCommandArgs(name, commandArgs)
					}
				/>
			)}
		</section>
	);
}
