/*
 * The repo-import card: one upserted job card, phase starting → running →
 * done | failed. The frame's StatusPill wears the coarse state; the body
 * names the exact phase and the live stage detail. Repository preparation is
 * retried automatically when the repository is opened again.
 */
import { Badge } from "@smthrs/ui";
import { CloudDownload } from "lucide-react";
import type { Card } from "../state/AppState";

const PHASE_VARIANT = {
	starting: "outline",
	running: "outline",
	done: "success",
	failed: "destructive",
} as const;

export const RepoImportCardBody = ({
	card,
}: {
	readonly card: Extract<Card, { kind: "repo-import" }>;
}) => {
	const { repo, phase, detail } = card.payload;
	return (
		<div className="world-card-list">
			<div className="world-card-row">
				<span className="connect-store-icon">
					<CloudDownload size={14} />
				</span>
				<span className="world-card-title">{repo}</span>
				<Badge variant={PHASE_VARIANT[phase]}>{phase}</Badge>
			</div>
			{detail !== null ? <p className="world-card-path">{detail}</p> : null}
		</div>
	);
};
