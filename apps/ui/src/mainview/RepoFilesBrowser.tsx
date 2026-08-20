/*
 * One repository file frame, projected in both the Files surface and the
 * GitHub repository pane. Navigation is command-bound; the latest seam card
 * is the persisted authority for the directory/file currently being shown.
 */
import { Button } from "@smthrs/ui";
import type { Card } from "./state/AppState";
import { FileCardBody, FileListCardBody } from "./cards/FileCards";

/*
 * The directory one level up, as `files.list` argument text. That grammar
 * parses the FIRST token as the path and the second as the repository, so the
 * root cannot be sent as the empty string: `" owner/repo"` collapses to a
 * single token and `owner/repo` is then read as a PATH. The root is sent as
 * "/", which FilesSeam.normalizePath resolves back to the repository root.
 */
const parentPath = (path: string): string => path.split("/").slice(0, -1).join("/");

export const upOneLevel = (path: string, repo: string): string => `${parentPath(path) || "/"} ${repo}`;

export function RepoFilesBrowser({
	repo,
	cards,
	onRunCommand,
}: {
	readonly repo: string | null;
	readonly cards: ReadonlyArray<Card>;
	readonly onRunCommand: (name: string, args?: string) => void;
}) {
	if (repo === null) return <p className="world-card-empty">Choose a repository to browse its files.</p>;
	const current = [...cards]
		.filter(
			(card): card is Extract<Card, { kind: "file-list" | "file" }> =>
				(card.kind === "file-list" || card.kind === "file") && card.payload.repo === repo,
		)
		.sort((left, right) => right.createdAt - left.createdAt)[0];
	const path = current?.payload.path ?? "";
	return (
		<div className="repo-files-browser" data-repo-files-browser="shared">
			<div className="world-card-row">
				<Button variant="ghost" size="sm" data-flow="files.list" onClick={() => onRunCommand("files.list", upOneLevel(path, repo))}>
					{repo} · {path || "/"}
				</Button>
			</div>
			{current?.kind === "file-list" ? <FileListCardBody card={current} onRunCommand={onRunCommand} /> : null}
			{current?.kind === "file" ? <FileCardBody card={current} onRunCommand={onRunCommand} /> : null}
			{current === undefined ? <p className="world-card-empty">Files have not been read yet.</p> : null}
		</div>
	);
}
