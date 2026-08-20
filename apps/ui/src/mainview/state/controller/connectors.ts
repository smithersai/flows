import type { RepositoryAccess } from "smithers-shared/NativeRepository";
import {
	RECO_FEEDBACK_PATH,
	RECO_FIRST_RUN_PATH,
	RECO_REPOS_PATH,
	RECO_WATCHED_PATH,
} from "smithers-shared/AgentApiRoutes";
import type { Card, RecoDigestPayload, RecoRecommendationPayload } from "../AppState";
import { REPO_CHOOSER_CARD_ID } from "../AppStore";
import type { ControllerContext } from "./context";

export interface ConnectorController {
	readonly openRepoChooser: (preselect?: string) => Promise<string | void>;
	readonly toggleWatchedRepo: (fullName: string) => string | void;
	readonly selectAllWatchedRepos: () => void;
	readonly selectNoWatchedRepos: () => void;
	readonly confirmWatchedRepos: () => Promise<string | void>;
	readonly loadFirstRunReco: (bump?: boolean) => Promise<void>;
	readonly acceptRecommendation: (cardId?: string) => Promise<string | void>;
	readonly editRecommendation: (cardId?: string) => Promise<string | void>;
	readonly dismissRecommendation: (cardId?: string) => Promise<string | void>;
	readonly refreshRecommendation: () => Promise<string | void>;
	readonly connectLocalRepository: (access: RepositoryAccess) => Promise<void>;
	readonly makeConnectorReadOnly: (id: string) => void;
	readonly removeConnector: (id: string) => void;
}

export const createConnectorController = (
	ctx: ControllerContext,
	send: (text: string) => void,
	promptSignIn: () => void,
): ConnectorController => {
	const { store, repositories, baseUrl } = ctx;
	const http = ctx.boundedFetch;
	const errorMessageOf = ctx.errorMessageOf;
	const withToast = ctx.withToast;
	const resumeDeferredCommand = (): void => ctx.resumeDeferredCommand();

	/*
	 * The recommendations seam (Wave 3b, Beat 5 — "Smithers has already read").
	 * The digest sentence becomes the first Smithers message and the one
	 * recommendation a card; a degraded answer renders its honestMessage,
	 * never filler. Every accept/edit/dismiss posts feedback (the day-one
	 * logging law) and a failed post leaves the card retryable with the honest
	 * error — the approval discipline, applied to recommendations.
	 */
	interface RepoCandidate {
		readonly fullName: string;
		readonly private: boolean;
		readonly pushedAt: string | null;
		readonly openIssues: number;
	}

	/** The reco seam's candidate rows, validated; anything off-shape is dropped. */
	const parseRepoCandidates = (wire: unknown): RepoCandidate[] =>
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

	/** Mirror the seam's selection locally, keeping provenance the row already holds. */
	const mirrorWatched = (selected: ReadonlyArray<string>): void => {
		const existing = store.collections.watchedRepos.get("watched");
		if (
			existing !== undefined &&
			existing.selected !== null &&
			existing.selected.length === selected.length &&
			existing.selected.every((name, index) => name === selected[index])
		) {
			return;
		}
		store.dispatch({
			type: "watched.replaced",
			actor: "system",
			selected: [...selected],
			selectedAt: existing?.selectedAt ?? null,
			via: existing?.via ?? null,
		});
	};

	/**
	 * Read the DURABLE watched selection and mirror it locally.
	 *
	 * The selection lives on the reco seam and `GET /api/reco/watched` answers it
	 * from its own store — it does not need GitHub. The first-run digest DOES,
	 * and when GitHub refuses that read (live on canary: `degraded:
	 * github_rejected`, HTTP 401) the degraded answer carries no `watched`, so
	 * the app came up believing the user watches nothing: `flow.create` sent
	 * them back to the onboarding chooser they had already answered, and the
	 * runtime context told the model `needsSelection`, which had it say "I need a
	 * repository to watch before I can create a workflow" to someone watching
	 * three. A degraded digest is not a forgotten selection.
	 */
	const loadWatchedSelection = async (isCurrent: () => boolean): Promise<void> => {
		try {
			const response = await http(`${baseUrl}${RECO_WATCHED_PATH}`);
			if (!response.ok) {
				await response.body?.cancel();
				return;
			}
			const body = (await response.json().catch(() => undefined)) as { selected?: unknown } | undefined;
			if (!isCurrent()) return;
			if (!Array.isArray(body?.selected)) return;
			mirrorWatched(body.selected.filter((name): name is string => typeof name === "string"));
		} catch {
			// The honest message the caller already rendered is the whole answer.
		}
	};

	/** The chooser card, when one is in the transcript. */
	const chooserCard = (): Extract<Card, { kind: "repo-chooser" }> | undefined => {
		const card = store.collections.cards.get(REPO_CHOOSER_CARD_ID);
		return card?.kind === "repo-chooser" ? card : undefined;
	};

	const patchChooser = (
		patch: Partial<Extract<Card, { kind: "repo-chooser" }>["payload"]>,
		status?: Card["status"],
	): void => {
		const card = chooserCard();
		if (card === undefined) return;
		store.dispatch({
			type: "card.updated",
			actor: ctx.commandActor,
			id: card.id,
			patch: { payload: { ...card.payload, ...patch }, ...(status === undefined ? {} : { status }) },
		});
	};

	/*
	 * Open the repo chooser — the one onboarding question, and the "just ask"
	 * path later. Candidates come from the selection read when one exists
	 * (pre-filled), else from GET /api/reco/repos; the agent's optional repo
	 * argument pre-selects on top. The card is embedded in the transcript for
	 * every actor — a chooser is never a takeover.
	 */
	const openRepoChooserImpl = async (preselect?: string): Promise<true | string> => {
		/*
		 * The chooser lists the USER'S repositories: without a signed-in
		 * session it can only open empty (the live bug: an empty "No
		 * repositories match" chooser while signed out). The sign-in step
		 * renders instead — promptSignIn answers every identity state
		 * honestly, including a build with no identity seam at all.
		 */
		const chooserIdentity = store.collections.identitySessions.get("identity");
		if (chooserIdentity?.state !== "signed-in") {
			promptSignIn();
			return "GitHub isn't connected yet — the chooser lists your repositories, so the sign-in step comes first.";
		}
		const via = ctx.commandActor === "smithers" ? "agent" : "command";
		let candidates: RepoCandidate[] | undefined;
		let selected: string[] = [];
		try {
			const watchedResponse = await http(`${baseUrl}${RECO_WATCHED_PATH}`);
			if (watchedResponse.ok) {
				const watchedBody = (await watchedResponse.json().catch(() => undefined)) as
					| { selected?: unknown }
					| undefined;
				if (Array.isArray(watchedBody?.selected)) {
					selected = watchedBody.selected.filter((name): name is string => typeof name === "string");
				}
			} else {
				await watchedResponse.body?.cancel();
			}
			const reposResponse = await http(`${baseUrl}${RECO_REPOS_PATH}`);
			if (reposResponse.ok) {
				const reposBody = (await reposResponse.json().catch(() => undefined)) as
					| { candidates?: unknown }
					| undefined;
				candidates = parseRepoCandidates(reposBody?.candidates);
			} else {
				await reposResponse.body?.cancel();
			}
		} catch {
			return "The recommendations service didn't answer — the chooser couldn't open. Try again.";
		}
		if (candidates === undefined) {
			return "The recommendations service didn't answer — the chooser couldn't open. Try again.";
		}
		// A pre-selected name the candidates list doesn't know is stated, not
		// silently dropped — and the chooser still opens with what IS visible.
		const preselectKnown = preselect === undefined || candidates.some((candidate) => candidate.fullName === preselect);
		const mergedSelection =
			preselect === undefined || !preselectKnown || selected.includes(preselect)
				? selected
				: [...selected, preselect];
		const existing = chooserCard();
		let highest = -1;
		for (const message of store.collections.messages.values()) highest = Math.max(highest, message.ordinal);
		for (const card of store.collections.cards.values()) highest = Math.max(highest, card.ordinal);
		const card: Card = {
			id: REPO_CHOOSER_CARD_ID,
			kind: "repo-chooser",
			title: "Choose the repositories Smithers watches",
			status: "active",
			createdAt: existing?.createdAt ?? Date.now(),
			ordinal: highest + 1,
			payload: { candidates, selected: mergedSelection, via, phase: "choosing" },
		};
		store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card });
		if (!preselectKnown && preselect !== undefined) {
			return `I couldn't find ${preselect} among your repositories — the chooser is open with the ones I can see.`;
		}
		return true;
	};

	const openRepoChooser = (preselect?: string): Promise<string | void> =>
		withToast(
			"reco.chooser",
			"Reading your repositories…",
			"Your repositories are ready to choose",
			() => openRepoChooserImpl(preselect),
		).then((outcome) => (outcome === true ? undefined : outcome));

	/*
	 * A.12: the toggle used to add ANY name to the selection, so
	 * `/repos.watch.toggle no-such/repo` silently put a repository the account
	 * does not have into the set the confirm would persist. The chooser's own
	 * rows are the universe — the sibling `/repos.watch <repo>` already refuses
	 * by name, and this now answers the same way.
	 */
	const toggleWatchedRepo = (fullName: string): string | void => {
		const card = chooserCard();
		if (card === undefined) return "The repository chooser isn't open — run /repos.watch first.";
		if (card.payload.phase === "saving") return;
		const known = card.payload.candidates.some((repo) => repo.fullName === fullName);
		if (!known) {
			return `I couldn't find ${fullName} among your repositories — the chooser is open with the ones I can see.`;
		}
		const selected = card.payload.selected.includes(fullName)
			? card.payload.selected.filter((name) => name !== fullName)
			: [...card.payload.selected, fullName];
		patchChooser({ selected, phase: "choosing" });
	};

	const selectAllWatchedRepos = (): void => {
		const card = chooserCard();
		if (card === undefined || card.payload.phase === "saving") return;
		patchChooser({ selected: card.payload.candidates.map((candidate) => candidate.fullName), phase: "choosing" });
	};

	const selectNoWatchedRepos = (): void => {
		const card = chooserCard();
		if (card === undefined || card.payload.phase === "saving") return;
		patchChooser({ selected: [], phase: "choosing" });
	};

	/*
	 * Confirm → PUT /api/reco/watched with the chooser's via → one calm line
	 * naming what is watched AND that asking changes it → the scoped digest
	 * arrives (the 300ms toast law covers the compute).
	 */
	const confirmWatchedReposImpl = async (): Promise<true | string> => {
		const card = chooserCard();
		if (card === undefined) return "There is no repository chooser open.";
		if (card.payload.phase === "saving") return true;
		const { selected, via } = card.payload;
		patchChooser({ phase: "saving" });
		let echoed: { selected?: unknown; selectedAt?: unknown; via?: unknown } | undefined;
		try {
			const response = await http(`${baseUrl}${RECO_WATCHED_PATH}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ selected, via }),
			});
			if (!response.ok) {
				const message = await errorMessageOf(response, "The selection didn't save. Try again.");
				patchChooser({ phase: "failed", error: message }, "error");
				return message;
			}
			echoed = (await response.json().catch(() => undefined)) as typeof echoed;
		} catch {
			const message = "The selection didn't save — the recommendations service is unreachable.";
			patchChooser({ phase: "failed", error: message }, "error");
			return message;
		}
		const saved = Array.isArray(echoed?.selected)
			? echoed.selected.filter((name): name is string => typeof name === "string")
			: selected;
		store.dispatch({
			type: "watched.replaced",
			actor: ctx.commandActor,
			selected: saved,
			selectedAt: typeof echoed?.selectedAt === "string" ? echoed.selectedAt : new Date().toISOString(),
			via: typeof echoed?.via === "string" && ["onboarding", "command", "agent"].includes(echoed.via)
				? (echoed.via as "onboarding" | "command" | "agent")
				: via,
		});
		store.dispatch({ type: "card.removed", actor: ctx.commandActor, id: card.id });
		store.dispatch({
			type: "message.appended",
			actor: "system",
			text:
				saved.length === 0
					? "Watching no repositories for now. You can change this anytime — just ask."
					: `Watching ${saved.length} ${saved.length === 1 ? "repository" : "repositories"}: ${saved.join(", ")}. You can change this anytime — just ask.`,
		});
		// The scoped digest + one recommendation arrive for the watched set.
		void loadFirstRunReco(true);
		// A confirmed selection can satisfy a parked command's repos-selected
		// requirement — the command that deferred into this chooser continues.
		resumeDeferredCommand();
		return true;
	};

	const confirmWatchedRepos = (): Promise<string | void> =>
		withToast("reco.watched.save", "Saving your selection…", "Selection saved", confirmWatchedReposImpl).then(
			(outcome) => (outcome === true ? undefined : outcome),
		);
	const loadFirstRunRecoImpl = async (bump: boolean): Promise<true | string> => {
		const identity = store.collections.identitySessions.get("identity");
		const epoch = ctx.accountEpoch;
		const state = identity?.state;
		const login = identity?.login;
		const isCurrent = (): boolean => {
			const latest = store.collections.identitySessions.get("identity");
			return ctx.accountEpoch === epoch && latest?.state === state && latest?.login === login;
		};
		let response: Response;
		try {
			response = await http(`${baseUrl}${RECO_FIRST_RUN_PATH}`);
		} catch {
			if (!isCurrent()) return true;
			const message =
				"I couldn't reach the recommendations service just now — ask me anything and we'll start from here.";
			store.dispatch({ type: "reco.message.loaded", actor: "system", message });
			return message;
		}
		if (!isCurrent()) return true;
		if (!response.ok) {
			const message = await errorMessageOf(response, "The recommendations service didn't answer.");
			if (!isCurrent()) return true;
			store.dispatch({ type: "reco.message.loaded", actor: "system", message });
			return message;
		}
		const body = (await response.json().catch(() => undefined)) as
			| {
					degraded?: unknown;
					honestMessage?: unknown;
					needsSelection?: unknown;
					emptySelection?: unknown;
					candidates?: unknown;
					watched?: unknown;
					digest?: {
						computedAt?: unknown;
						reposConsidered?: unknown;
						openIssues?: unknown;
						openPullRequests?: unknown;
						staleCount?: unknown;
						mostActiveRepo?: { name?: unknown } | null;
						oldestWaiting?: {
							repo?: unknown;
							number?: unknown;
							title?: unknown;
							url?: unknown;
							waitingDays?: unknown;
						} | null;
						untriagedInMostActive?: unknown;
						sentence?: unknown;
					};
					recommendation?: {
						id?: unknown;
						title?: unknown;
						proposes?: unknown;
						whyNow?: unknown;
						whatHappens?: unknown;
						subject?: { url?: unknown };
						evidenceKey?: unknown;
						whatChanged?: unknown;
					} | null;
			  }
			| undefined;
		if (!isCurrent()) return true;
		if (body?.degraded === true) {
			const message =
				typeof body.honestMessage === "string" && body.honestMessage.trim() !== ""
					? body.honestMessage
					: "I couldn't read your GitHub work just now — ask me anything and we'll start from here.";
			// A degraded answer IS the seam's honest success state — the work
			// itself succeeded, so the toast resolves ok; the message says the rest.
			store.dispatch({ type: "reco.message.loaded", actor: "system", message });
			// The digest needed GitHub; the SELECTION does not. Keep it.
			await loadWatchedSelection(isCurrent);
			return true;
		}
		/*
		 * Wave 10 onboarding: no watched-repos selection yet. The candidates
		 * ride inline so the chooser renders in one round trip; the chooser
		 * card IS the conversation's one question.
		 */
		if (body?.needsSelection === true) {
			const candidates = parseRepoCandidates(body.candidates);
			store.dispatch({ type: "reco.selection.needed", actor: "system", candidates });
			return true;
		}
		// Chose-zero is an honest state, never a fabricated digest.
		if (body?.emptySelection === true) {
			const message =
				typeof body.honestMessage === "string" && body.honestMessage.trim() !== ""
					? body.honestMessage
					: "You're watching no repositories right now — ask me to watch some and we'll start from there.";
			store.dispatch({ type: "reco.message.loaded", actor: "system", message });
			return true;
		}
		const digest = body?.digest;
		if (
			body === undefined ||
			digest === undefined ||
			typeof digest.sentence !== "string" ||
			digest.sentence.trim() === "" ||
			typeof digest.computedAt !== "string" ||
			typeof digest.reposConsidered !== "number" ||
			typeof digest.openIssues !== "number" ||
			typeof digest.openPullRequests !== "number" ||
			typeof digest.staleCount !== "number" ||
			typeof digest.untriagedInMostActive !== "number"
		) {
			const message =
				"The recommendations service answered in a shape I didn't understand — nothing is lost; ask me anything.";
			store.dispatch({ type: "reco.message.loaded", actor: "system", message });
			return message;
		}
		const digestPayload: RecoDigestPayload = {
			computedAt: digest.computedAt,
			reposConsidered: digest.reposConsidered,
			openIssues: digest.openIssues,
			openPullRequests: digest.openPullRequests,
			staleCount: digest.staleCount,
			mostActiveRepo:
				digest.mostActiveRepo !== null &&
				digest.mostActiveRepo !== undefined &&
				typeof digest.mostActiveRepo.name === "string"
					? digest.mostActiveRepo.name
					: null,
			oldestWaiting:
				digest.oldestWaiting !== null &&
				digest.oldestWaiting !== undefined &&
				typeof digest.oldestWaiting.repo === "string" &&
				typeof digest.oldestWaiting.number === "number" &&
				typeof digest.oldestWaiting.title === "string" &&
				typeof digest.oldestWaiting.url === "string" &&
				typeof digest.oldestWaiting.waitingDays === "number"
					? {
							label: `${digest.oldestWaiting.repo}#${digest.oldestWaiting.number} — ${digest.oldestWaiting.title}`,
							url: digest.oldestWaiting.url,
							waitingDays: digest.oldestWaiting.waitingDays,
						}
					: null,
			untriagedInMostActive: digest.untriagedInMostActive,
		};
		const wire = body.recommendation;
		const recommendation: RecoRecommendationPayload | null =
			wire !== null &&
			wire !== undefined &&
			typeof wire.id === "string" &&
			typeof wire.title === "string" &&
			typeof wire.proposes === "string" &&
			typeof wire.whyNow === "string" &&
			typeof wire.whatHappens === "string" &&
			typeof wire.evidenceKey === "string" &&
			typeof wire.subject?.url === "string"
				? {
						id: wire.id,
						title: wire.title,
						proposes: wire.proposes,
						whyNow: wire.whyNow,
						whatHappens: wire.whatHappens,
						subjectUrl: wire.subject.url,
						evidenceKey: wire.evidenceKey,
						...(typeof wire.whatChanged === "string" ? { whatChanged: wire.whatChanged } : {}),
					}
				: null;
		store.dispatch({
			type: "reco.digest.loaded",
			actor: "system",
			sentence: digest.sentence,
			digest: digestPayload,
			recommendation,
			bump,
		});
		// A scoped digest proves a selection exists — mirror it (the local
		// record keeps the chooser's pre-fill and the agent context honest).
		if (Array.isArray(body.watched)) {
			const names = body.watched.filter((name): name is string => typeof name === "string");
			mirrorWatched(names);
		}
		return true;
	};

	const loadFirstRunReco = (bump = false): Promise<void> =>
		withToast(
			"reco.first-run",
			bump ? "Refreshing what I found…" : "Reading your repos…",
			bump ? "Refreshed what I found" : "Read your repos",
			() => loadFirstRunRecoImpl(bump),
		).then(() => undefined);
	ctx.loadFirstRunReco = loadFirstRunReco;

	/** The live recommendation card: the named one, else the active one carrying a recommendation. */
	const recoCard = (cardId?: string): Extract<Card, { kind: "reco" }> | undefined => {
		if (cardId !== undefined) {
			const card = store.collections.cards.get(cardId);
			return card?.kind === "reco" ? (card as Extract<Card, { kind: "reco" }>) : undefined;
		}
		const found = [...store.collections.cards.values()].find(
			// "error" is a failed feedback post: retryable, never terminal.
			(card) => card.kind === "reco" && card.status !== "acted" && card.payload.recommendation !== null,
		);
		return found as Extract<Card, { kind: "reco" }> | undefined;
	};

	/** Every accept/edit/dismiss posts feedback; a failed post leaves the card retryable. */
	const postRecoFeedback = async (
		card: Extract<Card, { kind: "reco" }>,
		action: "accept" | "edit" | "dismiss",
	): Promise<true | string> => {
		const recommendation = card.payload.recommendation;
		if (recommendation === null) return "There is no recommendation to answer.";
		try {
			const response = await http(`${baseUrl}${RECO_FEEDBACK_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					recommendationId: recommendation.id,
					action,
					evidenceKey: recommendation.evidenceKey,
				}),
			});
			if (!response.ok) {
				const message = await errorMessageOf(response, "The feedback post didn't go through. Try again.");
				store.dispatch({ type: "reco.feedback.failed", actor: "system", cardId: card.id, message });
				return message;
			}
		} catch {
			const message = "The feedback post didn't go through. Try again.";
			store.dispatch({ type: "reco.feedback.failed", actor: "system", cardId: card.id, message });
			return message;
		}
		return true;
	};

	const postRecoFeedbackWithToast = (
		card: Extract<Card, { kind: "reco" }>,
		action: "accept" | "edit" | "dismiss",
	): Promise<true | string> =>
		withToast("reco.feedback", "Posting your feedback…", "Feedback posted", () => postRecoFeedback(card, action));

	const acceptRecommendation = async (cardId?: string): Promise<string | void> => {
		const card = recoCard(cardId);
		const recommendation = card?.payload.recommendation;
		if (card === undefined || recommendation === null || recommendation === undefined) {
			return "There is no current recommendation to accept.";
		}
		if (card.status === "acted") return "That recommendation was already answered.";
		if ((await postRecoFeedbackWithToast(card, "accept")) !== true) return undefined;
		store.dispatch({ type: "card.updated", actor: ctx.commandActor, id: card.id, patch: { status: "acted" } });
		// Accept runs the recommendation's affordance: the proposed work starts
		// as an ordinary turn through the same send path as everything else.
		send(recommendation.proposes);
		return undefined;
	};

	const editRecommendation = async (cardId?: string): Promise<string | void> => {
		const card = recoCard(cardId);
		const recommendation = card?.payload.recommendation;
		if (card === undefined || recommendation === null || recommendation === undefined) {
			return "There is no current recommendation to edit.";
		}
		if (card.status === "acted") return "That recommendation was already answered.";
		if ((await postRecoFeedbackWithToast(card, "edit")) !== true) return undefined;
		store.dispatch({ type: "card.updated", actor: ctx.commandActor, id: card.id, patch: { status: "acted" } });
		// Edit opens the composer prefilled with the proposal, ready to reshape.
		store.dispatch({
			type: "composer.control.changed",
			actor: "system",
			owner: "user",
			draft: recommendation.proposes,
		});
		return undefined;
	};

	const dismissRecommendation = async (cardId?: string): Promise<string | void> => {
		const card = recoCard(cardId);
		if (card === undefined || card.payload.recommendation === null) {
			return "There is no current recommendation to dismiss.";
		}
		if (card.status === "acted") return "That recommendation was already answered.";
		if ((await postRecoFeedbackWithToast(card, "dismiss")) !== true) return undefined;
		// Dismiss removes the card without argument.
		store.dispatch({ type: "card.removed", actor: ctx.commandActor, id: card.id });
		return undefined;
	};

	const refreshRecommendation = async (): Promise<string | void> => {
		await loadFirstRunReco(true);
		return undefined;
	};

	const connectLocalRepository = async (access: RepositoryAccess): Promise<void> => {
		const operation = store.collections.connectorOperations.get("connector-operation");
		if (operation?.phase !== "idle") return;
		store.dispatch({ type: "connector.local.requested", actor: "user", access });
		try {
			const result = await repositories.pickLocalRepository(access);
			switch (result.status) {
				case "connected":
					store.dispatch({
						type: "connector.local.connected",
						actor: "system",
						access,
						repository: result.repository,
					});
					break;
				case "cancelled":
					store.dispatch({ type: "connector.local.cancelled", actor: "user" });
					break;
				case "error":
					store.dispatch({
						type: "connector.local.failed",
						actor: "system",
						message: result.message,
					});
					break;
			}
		} catch {
			store.dispatch({
				type: "connector.local.failed",
				actor: "system",
				message: "The native repository picker stopped responding. Try again.",
			});
		}
	};

	const makeConnectorReadOnly = (id: string): void => {
		store.dispatch({
			type: "connector.access.changed",
			actor: "user",
			id,
			access: "read",
		});
	};

	const removeConnector = (id: string): void => {
		store.dispatch({ type: "connector.removed", actor: "user", id });
	};

	return {
		openRepoChooser, toggleWatchedRepo, selectAllWatchedRepos, selectNoWatchedRepos,
		confirmWatchedRepos, loadFirstRunReco, acceptRecommendation, editRecommendation,
		dismissRecommendation, refreshRecommendation, connectLocalRepository,
		makeConnectorReadOnly, removeConnector,
	};
};
