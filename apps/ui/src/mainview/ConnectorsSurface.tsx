import {
	Alert,
	AlertDescription,
	AlertTitle,
	Badge,
	Button,
	Separator,
} from "@smthrs/ui";
import { useLiveQuery } from "@tanstack/react-db";
import {
	FolderGit2,
	GitPullRequest,
	HardDrive,
	Plug,
	Server,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import type { KeyboardEvent } from "react";
import { ConfirmDialog, SurfaceHeader } from "./SurfaceChrome";
import type { AppController } from "./state/AppController";

const shortHead = (head: string | null): string => head?.slice(0, 8) ?? "No commits yet";

/*
 * The connect surface (Wave 10, §2e): extension-store grammar — a compact
 * list of connector rows: icon, name, ONE line of description, one action
 * (Connect / Connected ✓ / Coming soon). No paragraphs, no prose blocks.
 * Keyboard-complete: arrows move between rows, Enter is the row's action.
 * Sign-in IS the GitHub connector (§2a′): a valid session reads Connected.
 */
export function ConnectorsSurface({ controller }: { readonly controller: AppController }) {
	const { collections } = controller.store;
	const { data: connectorRows } = useLiveQuery(collections.connectors);
	const { data: operationRows } = useLiveQuery(collections.connectorOperations);
	const { data: identityRows } = useLiveQuery(collections.identitySessions);
	const connectors = [...connectorRows].sort((left, right) => left.name.localeCompare(right.name));
	const operation =
		operationRows.find((candidate) => candidate.id === "connector-operation") ??
		collections.connectorOperations.get("connector-operation");
	const selecting = operation?.phase === "selecting-local-repository";
	const identity = identityRows[0];
	const signedIn = identity?.state === "signed-in";
	const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
	const pendingRemoval = connectors.find((candidate) => candidate.id === pendingRemovalId);

	interface StoreRow {
		readonly key: string;
		readonly icon: "github" | "local" | "cloud";
		readonly name: string;
		readonly description: string;
		readonly action:
			| { readonly kind: "button"; readonly label: string; readonly flow: string; readonly args?: string; readonly disabled?: boolean }
			| { readonly kind: "badge"; readonly label: string; readonly variant: "success" | "outline" };
	}

	const rows: ReadonlyArray<StoreRow> = [
		{
			key: "github",
			icon: "github",
			name: "GitHub",
			description: "Issues, pull requests, and reviews from the repositories you choose.",
			action: signedIn
				? { kind: "badge", label: `Connected ✓ as ${identity?.login ?? "you"}`, variant: "success" }
				: { kind: "button", label: "Connect", flow: "auth.sign-in" },
		},
		...(controller.nativeRepositoriesAvailable
			? [
					{
						key: "local",
						icon: "local",
						name: "Local repository",
						description: "A repository on this machine, read directly.",
						action: {
							kind: "button",
							label: "Connect",
							flow: "connector.add",
							args: "read",
							disabled: selecting,
						},
					} satisfies StoreRow,
				]
			: []),
		{
			/*
			 * No longer "coming soon": repos.import mirrors a GitHub repository
			 * into Smithers Cloud (the platform proxy's import job), tracked by
			 * the repo-import card.
			 */
			key: "cloud",
			icon: "cloud",
			name: "Smithers Cloud repository",
			description: "Import a GitHub repository into hosted workspace storage.",
			action: { kind: "button", label: "Import", flow: "repos.import" },
		},
	];

	const rowIcon = (icon: StoreRow["icon"]) =>
		icon === "github" ? (
			<GitPullRequest size={16} aria-hidden="true" />
		) : icon === "local" ? (
			<HardDrive size={16} aria-hidden="true" />
		) : (
			<Server size={16} aria-hidden="true" />
		);

	const onRowsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const items = Array.from(
			event.currentTarget.querySelectorAll<HTMLElement>(".connect-store-row [data-row-action]"),
		);
		if (items.length === 0) return;
		event.preventDefault();
		const current = items.indexOf(document.activeElement as HTMLElement);
		const next =
			event.key === "ArrowDown"
				? (current + 1) % items.length
				: (current - 1 + items.length) % items.length;
		items[next]?.focus();
	};

	return (
		<section className="connectors-surface embedded-pane" aria-label="Smithers connectors">
			<SurfaceHeader
				icon={<Plug size={17} />}
				title="Connectors"
				subtitle="What Smithers can see and change"
				closeCommand="chat"
				onClose={() => controller.runCommand("chat")}
			/>

			<main className="connectors-content">
				{operation?.error ? (
					<Alert variant="destructive">
						<AlertTitle>Repository not connected</AlertTitle>
						<AlertDescription>{operation.error}</AlertDescription>
					</Alert>
				) : null}

				<div className="connect-store-list" role="list" aria-label="Connectors" onKeyDown={onRowsKeyDown}>
					{rows.map((row) => (
						<div className="connect-store-row" role="listitem" key={row.key}>
							<span className="connect-store-icon">{rowIcon(row.icon)}</span>
							<span className="connect-store-text">
								<strong>{row.name}</strong>
								<span>{row.description}</span>
							</span>
							{row.action.kind === "button" ? (
								<Button
									size="sm"
									variant="outline"
									data-flow={row.action.flow}
									data-row-action
									disabled={row.action.disabled === true}
									loading={row.action.flow === "connector.add" && selecting}
									onClick={() =>
										row.action.kind === "button" && row.action.args !== undefined
											? controller.runCommandArgs(row.action.flow, row.action.args)
											: row.action.kind === "button"
												? controller.runCommand(row.action.flow)
												: undefined
									}
								>
									{row.action.label}
								</Button>
							) : (
								<Badge variant={row.action.variant} data-row-action tabIndex={0}>
									{row.action.label}
								</Badge>
							)}
						</div>
					))}
				</div>

				<Separator />

				<section className="connected-repositories" aria-labelledby="connected-repositories-title">
					<div className="connected-repositories-heading">
						<div>
							<h2 id="connected-repositories-title">Connected repositories</h2>
						</div>
					</div>

					{connectors.length === 0 ? (
						<div className="connector-empty">
							<FolderGit2 size={20} />
							<div>
								<strong>No repositories connected</strong>
							</div>
						</div>
					) : (
						<div className="connected-repository-list">
							{connectors.map((connector) => (
								<div className="connected-repository-card" key={connector.id}>
									<div className="connected-repository-row">
										<span className="connect-store-icon">
											<FolderGit2 size={16} aria-hidden="true" />
										</span>
										<span className="connect-store-text">
											<strong>{connector.name}</strong>
											<span className="repository-path">
												{connector.branch ?? "Detached"} · <code>{shortHead(connector.head)}</code>
											</span>
										</span>
										<Badge variant={connector.access === "read-write" ? "warning" : "outline"}>
											{connector.access === "read-write" ? "Read & write" : "Read-only"}
										</Badge>
										{connector.access === "read-write" ? (
											<Button
												variant="ghost"
												size="sm"
												onClick={() => controller.runCommandArgs("connector.downgrade", connector.id)}
											>
												Make read-only
											</Button>
										) : null}
										<Button
											variant="ghost"
											size="icon"
											aria-label={`Remove ${connector.name}`}
											title={`Remove ${connector.name}`}
											onClick={() => setPendingRemovalId(connector.id)}
										>
											<Trash2 size={14} />
										</Button>
									</div>
								</div>
							))}
						</div>
					)}
				</section>
			</main>

			<ConfirmDialog
				open={pendingRemoval !== undefined}
				title={pendingRemoval ? `Disconnect ${pendingRemoval.name}?` : "Disconnect repository?"}
				body="Smithers will stop watching this repository. You can reconnect it any time."
				confirmLabel="Disconnect"
				destructive
				onConfirm={() => {
					if (pendingRemoval !== undefined) controller.runCommandArgs("connector.remove", pendingRemoval.id);
					setPendingRemovalId(null);
				}}
				onCancel={() => setPendingRemovalId(null)}
			/>
		</section>
	);
}
