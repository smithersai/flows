import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CardView } from "./ChatCards";
import type { Card } from "smithers-shared/Cards";

/*
 * Launch checklist A-8 — the recommendation card must carry proposes /
 * why-now / what-happens plus accept/edit/dismiss controls. Pins the
 * representative payload's three fields and the three affordances in the
 * rendered markup so the card can never silently drop one again.
 */

const cardViewHandlers = {
	maximized: false,
	onDecideApproval: () => {},
	onRecoAction: () => {},
	onGrantConfirm: () => {},
	onGrantCancel: () => {},
	onQueueApprove: () => {},
	onRepoToggle: () => {},
	onReposSelectAll: () => {},
	onReposSelectNone: () => {},
	onReposConfirm: () => {},
	onMaximize: () => {},
	onMinimize: () => {},
	onConnectGitHub: () => {},
	onConnectLocal: () => {},
	onRunWorkflow: () => {},
	onStopRun: () => {},
	onRetryRun: () => {},
	onChooseWorkflowRepo: () => {},
	worldDocuments: [],
	onChangeWorldDocument: () => {},
	onRunCommand: () => {},
};

const recoCard: Extract<Card, { kind: "reco" }> = {
	id: "reco-current",
	kind: "reco",
	title: "Recommendation",
	status: "active",
	createdAt: 1,
	ordinal: 1,
	payload: {
		sentence: "You have 7 open issues and 2 open PRs across 12 repos; the oldest is waiting 11 days.",
		digest: {
			computedAt: "2026-08-08T09:00:00.000Z",
			reposConsidered: 12,
			openIssues: 7,
			openPullRequests: 2,
			staleCount: 3,
			mostActiveRepo: "will/flows",
			oldestWaiting: {
				label: "will/flows#12",
				url: "https://github.com/will/flows/pull/12",
				waitingDays: 11,
			},
			untriagedInMostActive: 4,
		},
		recommendation: {
			id: "review-pr:will/flows#12",
			title: "Review Wire the sync adapter in will/flows",
			proposes: "Open pull request #12, Wire the sync adapter, in will/flows for review.",
			whyNow: "It is the oldest pull request waiting on you — untouched for 11 days.",
			whatHappens: "Smithers opens the diff and walks it with you; nothing is merged until you say so.",
			subjectUrl: "https://github.com/will/flows/pull/12",
			evidenceKey: "0123456789abcdef",
		},
	},
};

describe("the recommendation card (launch checklist A-8)", () => {
	test("renders proposes, why-now, and what-happens from the recommendation payload", () => {
		const markup = renderToStaticMarkup(<CardView card={recoCard} {...cardViewHandlers} />);
		expect(markup).toContain(recoCard.payload.recommendation!.proposes);
		expect(markup).toContain(recoCard.payload.recommendation!.whyNow);
		expect(markup).toContain(recoCard.payload.recommendation!.whatHappens);
	});

	test("carries accept, edit, and dismiss controls", () => {
		const markup = renderToStaticMarkup(<CardView card={recoCard} {...cardViewHandlers} />);
		expect(markup).toContain('data-flow="reco.accept"');
		expect(markup).toContain('data-flow="reco.edit"');
		expect(markup).toContain('data-flow="reco.dismiss"');
	});

	test("drops the controls once the card is acted on, but keeps the three fields", () => {
		const actedCard: Card = { ...recoCard, status: "acted" };
		const markup = renderToStaticMarkup(<CardView card={actedCard} {...cardViewHandlers} />);
		expect(markup).toContain(recoCard.payload.recommendation!.proposes);
		expect(markup).toContain(recoCard.payload.recommendation!.whyNow);
		expect(markup).toContain(recoCard.payload.recommendation!.whatHappens);
		expect(markup).not.toContain('data-flow="reco.accept"');
	});
});
