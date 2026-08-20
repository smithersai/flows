// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Production Readiness Swarm
// smithers-description: Converges disposable architecture proofs into an evidence-gated production candidate without landing on main.
// smithers-tags: production, readiness, verification
/** @jsxImportSource smthrs */
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { constants as fsConstants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createSmithers, Memory, MergeQueue, Parallel, Ralph, Sequence, Task, UI, Workflow, Worktree } from "smthrs";
import { z } from "zod/v4";
import { providers } from "../agents";
import { runBoundedProcess } from "../lib/run-bounded-process";
import InventoryResearchPrompt from "../prompts/production-readiness-swarm/inventory-research.mdx";
import InventorySynthesisPrompt from "../prompts/production-readiness-swarm/inventory-synthesis.mdx";
import PocRoundPlanPrompt from "../prompts/production-readiness-swarm/poc-round-plan.mdx";
import PocAuthorityFoundationPrompt from "../prompts/production-readiness-swarm/poc-authority-foundation.mdx";
import PocStateJournalPrompt from "../prompts/production-readiness-swarm/poc-state-journal.mdx";
import PocFlowsHarnessPrompt from "../prompts/production-readiness-swarm/poc-flows-harness.mdx";
import PocPlatformWorldviewPrompt from "../prompts/production-readiness-swarm/poc-platform-worldview.mdx";
import PocTranscriptChatUiPrompt from "../prompts/production-readiness-swarm/poc-transcript-chat-ui.mdx";
import PocIntegrateVerifyPrompt from "../prompts/production-readiness-swarm/poc-integrate-verify.mdx";
import PocFailureRoutePrompt from "../prompts/production-readiness-swarm/poc-failure-route.mdx";
import ArchitectureLearnPrompt from "../prompts/production-readiness-swarm/architecture-learn.mdx";
import ProductionPlanStateJournalPrompt from "../prompts/production-readiness-swarm/production-plan-state-journal.mdx";
import ProductionPlanFlowsHarnessPrompt from "../prompts/production-readiness-swarm/production-plan-flows-harness.mdx";
import ProductionPlanTranscriptUiPrompt from "../prompts/production-readiness-swarm/production-plan-transcript-ui.mdx";
import ProductionPlanPlatformSecurityPrompt from "../prompts/production-readiness-swarm/production-plan-platform-security.mdx";
import ProductionSupervisorPlanPrompt from "../prompts/production-readiness-swarm/production-supervisor-plan.mdx";
import ProductionWavePlanPrompt from "../prompts/production-readiness-swarm/production-wave-plan.mdx";
import ProductionSliceImplementPrompt from "../prompts/production-readiness-swarm/production-slice-implement.mdx";
import ProductionMergePrompt from "../prompts/production-readiness-swarm/production-merge.mdx";
import ProductionE2ePrompt from "../prompts/production-readiness-swarm/production-e2e.mdx";
import ProductionFailureRoutePrompt from "../prompts/production-readiness-swarm/production-failure-route.mdx";
import CommitReviewPrompt from "../prompts/production-readiness-swarm/commit-review.mdx";
import StackReviewPrompt from "../prompts/production-readiness-swarm/stack-review.mdx";
import ReviewCorrectionPrompt from "../prompts/production-readiness-swarm/review-correction.mdx";
import ReviewE2ePrompt from "../prompts/production-readiness-swarm/review-e2e.mdx";
import FinalScanPrompt from "../prompts/production-readiness-swarm/final-scan.mdx";
import FinalFixPrompt from "../prompts/production-readiness-swarm/final-fix.mdx";
import FinalArchitectureUpdatePrompt from "../prompts/production-readiness-swarm/final-architecture-update.mdx";
import HistoryCuratePrompt from "../prompts/production-readiness-swarm/history-curate.mdx";
import CommitSeriesVerifyPrompt from "../prompts/production-readiness-swarm/commit-series-verify.mdx";
import FinalVerifyPrompt from "../prompts/production-readiness-swarm/final-verify.mdx";

// The registered Claude pool currently contains quota-expired accounts. Pin the
// planning and review stages to the verified default subscription for this run.
const agents = { opus: providers.claudeOpus } as const;

const classification = z.enum(["pass", "product_failure", "environment_failure", "blocked", "not_run"]);
const evidenceRef = z.string().min(1);
const commandResult = z.strictObject({
  command: z.string().min(1),
  classification,
  exitCode: z.number().int().nullable(),
  summary: z.string().min(1),
  evidenceRef,
});
const receiptFields = {
  summary: z.string().min(1),
  status: classification,
  evidenceRefs: z.array(evidenceRef),
  blockers: z.array(z.string().min(1)),
  commands: z.array(commandResult),
};
const assertion = z.strictObject({ name: z.string().min(1), passed: z.boolean(), evidenceRefs: z.array(evidenceRef) });
const commitReceipt = z.strictObject({
  sha: z.string().min(7),
  message: z.string().min(1),
  branch: z.string().min(1),
  evidenceRefs: z.array(evidenceRef),
});
const dependencyBoundary = z.strictObject({
  newSmithersRoot: z.literal("/Users/williamcory/flows"),
  allowedProductNamespace: z.literal("@smithers/*"),
  forbiddenNamespaces: z.array(z.literal("@smthrs/*")),
  forbiddenRoots: z.array(z.literal("/Users/williamcory/smithers")),
  violations: z.array(z.string().min(1)),
});
const inventoryMetrics = z.strictObject({
  productLines: z.number().int().nonnegative(),
  productionDependencies: z.number().int().nonnegative(),
  legacyImportViolations: z.number().int().nonnegative(),
});

const acceptanceAssertions = z.strictObject({
  sqliteTanstackDbAuthority: z.boolean(),
  actorRecordedFluxAtomicJournal: z.boolean(),
  journalTransactStorageOnly: z.boolean(),
  externalEffectsUseActivitySafety: z.boolean(),
  singleFlowRegistryInvocationParity: z.boolean(),
  connectors: z.boolean(),
  workspaceBranchRevision: z.boolean(),
  harnessCellSmithersScripts: z.boolean(),
  recursiveNativeSubagents: z.boolean(),
  externalAgentAdapters: z.boolean(),
  worldviewMemoryProvenance: z.boolean(),
  rendererNeutralTranscript: z.boolean(),
  brainlessClaudeRenderer: z.boolean(),
  brainlessCodexRenderer: z.boolean(),
  noAgentTabs: z.boolean(),
  embeddedMiniApp: z.boolean(),
  sameComponentMaximized: z.boolean(),
  persistentComposerChrome: z.boolean(),
  durableUrlFrameGraph: z.boolean(),
  browserBackForward: z.boolean(),
  minimizeMaximize: z.boolean(),
  historicalFrameFork: z.boolean(),
  accessibilityE2e: z.boolean(),
  visualE2e: z.boolean(),
  nativeE2e: z.boolean(),
  architectureSite: z.boolean(),
  architectureFileTree: z.boolean(),
  architecturePseudocode: z.boolean(),
  designD2ChatAffordances: z.boolean(),
  designD2RichCardsApproval: z.boolean(),
  designD2WorldConnectors: z.boolean(),
  designD2StateSmokeTests: z.boolean(),
  newSmithersOnly: z.boolean(),
  legacyBoundary: z.boolean(),
});

const input = z.strictObject({
  targetRepo: z.string().min(1).refine(path.isAbsolute, "targetRepo must be absolute").default("/Users/williamcory/mvp"),
  architectureSitePath: z.string().min(1).refine(isSafeRelativeArchitecturePath, "architectureSitePath must be a normalized relative path without '.' or '..' components").default("docs/architecture"),
  maxPrototypeRounds: z.number().int().min(1).max(5).default(3),
  maxProductionRounds: z.number().int().min(1).max(6).default(4),
  maxConcurrency: z.number().int().min(1).max(4).default(4),
  acceptanceCommands: z.array(z.string().min(1)).default([]),
  sourceRepos: z.array(z.string().min(1)).default(["/Users/williamcory/flows/ui", "/Users/williamcory/multi", "/Users/williamcory/gui", "/Users/williamcory/flows", "/Users/williamcory/Smithers-Ops"]),
});
const initialize = z.strictObject({
  summary: z.string().min(1),
  status: z.enum(["ready", "blocked"]),
  contractVersion: z.literal("production-readiness-swarm/v2"),
  contractValidationPassed: z.boolean(),
  resolvedAcceptanceCommands: z.array(z.string().min(1)),
  e2eCommandAction: z.enum(["use_provided", "build_missing"]),
  instructionSources: z.array(z.string().min(1)),
  blockers: z.array(z.string().min(1)),
});
const worktreePreparation = z.strictObject({
  ...receiptFields,
  baseRevision: z.string().min(7),
  baseRef: z.string().min(1),
  metrics: inventoryMetrics,
  worktrees: z.array(z.strictObject({
    path: z.string().min(1),
    branch: z.string().min(1),
    headRevision: z.string().min(7),
  })).min(1),
});
const inventoryResearch = z.strictObject({
  ...receiptFields,
  baselineRevision: z.string().regex(/^[a-f0-9]{40}$/),
  baselineRef: z.string().min(1),
  metrics: inventoryMetrics,
  claims: z.array(z.strictObject({ claim: z.string().min(1), classification: z.enum(["implemented", "prototype", "superseded", "proposed"]), evidenceRefs: z.array(evidenceRef) })),
  instructionSources: z.array(evidenceRef),
  referenceComparisons: z.array(z.strictObject({
    repo: z.string().min(1),
    repoState: z.enum(["implemented", "prototype", "superseded", "proposed", "mixed"]),
    useFor: z.array(z.string().min(1)),
    doNotCarry: z.array(z.string().min(1)),
    evidenceRefs: z.array(evidenceRef).min(1),
  })),
  dependencyBoundary,
});
const inventoryEvidenceValidation = z.strictObject({
  ...receiptFields,
  checkedRefs: z.array(evidenceRef),
  missingRefs: z.array(evidenceRef),
  nonLocalRefs: z.array(evidenceRef),
});
const inventorySynthesis = z.strictObject({
  ...receiptFields,
  baselineRevision: z.string().regex(/^[a-f0-9]{40}$/),
  baselineRef: z.string().min(1),
  constraints: z.array(z.string().min(1)),
  conflicts: z.array(z.strictObject({ description: z.string().min(1), evidenceRefs: z.array(evidenceRef) })),
  metrics: inventoryMetrics,
  acceptanceCoverage: z.array(z.strictObject({ clause: z.string().min(1), status: z.enum(["covered", "missing", "conflicted"]), evidenceRefs: z.array(evidenceRef) })),
  referenceDecisions: z.array(z.strictObject({ repo: z.string().min(1), adopt: z.array(z.string().min(1)), reject: z.array(z.string().min(1)), evidenceRefs: z.array(evidenceRef).min(1) })),
});
const pocLaneName = z.enum(["authority-foundation", "state-journal", "flows-harness", "platform-worldview", "transcript-chat-ui"]);
const pocRoundPlan = z.strictObject({
  ...receiptFields,
  baseRevision: z.string().regex(/^[a-f0-9]{40}$/),
  baseRef: z.string().min(1),
  hypothesis: z.string().min(1),
  changedFromPriorRound: z.string().min(1),
  laneOwnership: z.array(z.strictObject({ lane: pocLaneName, ownedPaths: z.array(z.string().min(1)), checks: z.array(z.string().min(1)) })).length(5),
});
const pocRoundPlanValidation = z.strictObject({
  ...receiptFields,
  valid: z.boolean(),
  checkedLanes: z.array(pocLaneName),
  duplicateLanes: z.array(pocLaneName),
  invalidPaths: z.array(z.strictObject({ lane: pocLaneName, ownedPath: z.string().min(1), reason: z.string().min(1) })),
  missingAuthorityPaths: z.array(z.string().min(1)),
  ownershipConflicts: z.array(z.string().min(1)),
  baseMismatch: z.boolean(),
});
const smithersDistributionManifest = z.strictObject({
  smithersSourceRoot: z.literal("/Users/williamcory/flows"),
  sourceRevisions: z.strictObject({ flows: z.string().min(7), agent: z.string().min(7), plugins: z.string().min(7) }),
  packages: z.array(z.strictObject({ name: z.string().startsWith("@smithers/"), version: z.string().min(1), filename: z.string().endsWith(".tgz"), sourceRoot: z.string().startsWith("/Users/williamcory/flows/") })).min(4),
});
const dependencyFootprint = z.strictObject({ installedBytes: z.number().int().positive(), installedFiles: z.number().int().positive() });
const pocFoundationBootstrap = z.strictObject({
  ...receiptFields,
  branch: z.string().min(1),
  executionCwd: z.string().min(1),
  baseRevision: z.string().regex(/^[a-f0-9]{40}$/),
  distributionRoot: z.string().min(1).refine(path.isAbsolute, "distributionRoot must be absolute"),
  distributionManifest: smithersDistributionManifest.nullable(),
  effectVersion: z.string().min(1).nullable(),
  dependencyFootprint: dependencyFootprint.nullable(),
  assertions: z.strictObject({
    localDistributionPacked: z.boolean(),
    externalConsumerSmoke: z.boolean(),
    exactSourceProvenance: z.boolean(),
    journalHarnessAdaptersConnectorsInstalled: z.boolean(),
    effectRuntimeInstalled: z.boolean(),
    bunLockfileMigrated: z.boolean(),
    frozenLockfileInstall: z.boolean(),
    dependencyFootprintMeasured: z.boolean(),
    packageManifestWritesSerialized: z.boolean(),
  }),
});
const pocAuthorityFoundation = z.strictObject({
  ...receiptFields,
  lane: z.literal("authority-foundation"),
  hypothesisVerdict: z.enum(["proven", "falsified", "inconclusive"]),
  branch: z.string().min(1),
  executionCwd: z.string().min(1),
  baseRevision: z.string().regex(/^[a-f0-9]{40}$/),
  commitSha: z.string().min(7).nullable(),
  changedFiles: z.array(z.string().min(1)),
  distributionRoot: z.string().min(1).refine(path.isAbsolute, "distributionRoot must be absolute"),
  distributionManifest: smithersDistributionManifest.nullable(),
  dependencyFootprint: dependencyFootprint.nullable(),
  assertions: z.strictObject({
    localDistributionPacked: z.boolean(),
    externalConsumerSmoke: z.boolean(),
    exactSourceProvenance: z.boolean(),
    journalHarnessAdaptersConnectorsInstalled: z.boolean(),
    authorityCompositionRoot: z.boolean(),
    hostRuntimePlacement: z.boolean(),
    rendererRuntimeIsolation: z.boolean(),
    dependencyFootprintMeasured: z.boolean(),
    packageManifestWritesSerialized: z.boolean(),
    noLocalSmithersReimplementation: z.boolean(),
    focusedBoundaryTests: z.boolean(),
    // Backward-compatible with an earlier round that incorrectly coupled the
    // renderer build to this host-only lane. New foundation agents omit it.
    productBuild: z.boolean().optional(),
  }),
});
const pocStateJournal = z.strictObject({
  ...receiptFields,
  lane: z.literal("state-journal"), hypothesisVerdict: z.enum(["proven", "falsified", "inconclusive"]), branch: z.string().min(1), executionCwd: z.string().min(1), commitSha: z.string().min(7).nullable(), changedFiles: z.array(z.string().min(1)), assertions: z.strictObject({ sqliteBackedCollections: z.boolean(), tanstackDbAuthority: z.boolean(), actorRecordedFlux: z.boolean(), atomicJournal: z.boolean(), framePersistence: z.boolean(), newSmithersJournalResolved: z.boolean(), journalTransactBoundaryExercised: z.boolean(), noLocalJournalReimplementation: z.boolean() }),
});
const pocFlowsHarness = z.strictObject({
  ...receiptFields,
  lane: z.literal("flows-harness"), hypothesisVerdict: z.enum(["proven", "falsified", "inconclusive"]), branch: z.string().min(1), executionCwd: z.string().min(1), commitSha: z.string().min(7).nullable(), changedFiles: z.array(z.string().min(1)), assertions: z.strictObject({ oneFlowRegistry: z.boolean(), slashCtxCallButtonParity: z.boolean(), harnessCellExecutesSmithersScripts: z.boolean(), recursiveNativeSubagents: z.boolean(), durableFrameNavigation: z.boolean(), newSmithersPackagesResolved: z.boolean(), noLocalSmithersReimplementation: z.boolean() }),
});
const pocPlatformWorldview = z.strictObject({
  ...receiptFields,
  lane: z.literal("platform-worldview"), hypothesisVerdict: z.enum(["proven", "falsified", "inconclusive"]), branch: z.string().min(1), executionCwd: z.string().min(1), commitSha: z.string().min(7).nullable(), changedFiles: z.array(z.string().min(1)), assertions: z.strictObject({ connectors: z.boolean(), externalAdapters: z.boolean(), workspaceBranchRevision: z.boolean(), worldviewMemoryProvenance: z.boolean(), freshVersionedContextSnapshots: z.boolean(), newSmithersConnectorPackagesResolved: z.boolean(), noLocalConnectorRuntimeReimplementation: z.boolean() }),
});
const pocTranscriptChatUi = z.strictObject({
  ...receiptFields,
  lane: z.literal("transcript-chat-ui"), hypothesisVerdict: z.enum(["proven", "falsified", "inconclusive"]), branch: z.string().min(1), executionCwd: z.string().min(1), commitSha: z.string().min(7).nullable(), changedFiles: z.array(z.string().min(1)), assertions: z.strictObject({ rendererNeutralTranscript: z.boolean(), brainlessClaudeCodexRenderers: z.boolean(), noAgentTabs: z.boolean(), embeddedAndMaximizedSameComponent: z.boolean(), persistentComposer: z.boolean(), accessibleVisualFixtures: z.boolean() }),
});
const pocIntegrateVerify = z.strictObject({
  ...receiptFields,
  foundationCommit: commitReceipt.nullable(),
  allLaneReceiptsPresent: z.boolean(),
  integratedLaneCommits: z.array(commitReceipt).max(4),
  candidateBranch: z.string().min(1),
  executionCwd: z.string().min(1),
  integrationCommit: commitReceipt.nullable(),
  parallelLanesManifestClean: z.boolean(),
  legacyDependenciesRemoved: z.boolean(),
  dependencyManifestFinalized: z.boolean(),
  lockfileRegenerated: z.boolean(),
  assertions: z.array(assertion),
  dependencyBoundary,
});
const failureRoute = (phase: "poc" | "production") => z.strictObject({
  ...receiptFields,
  phase: z.literal(phase),
  failureSignature: z.string().min(1).nullable(),
  shouldRetry: z.boolean(),
  nextAction: z.enum(["proceed", "correct_product", "build_or_repair_harness", "escalate"]),
});
const architectureLearn = z.strictObject({
  ...receiptFields,
  architectureScore: z.number().min(0).max(100),
  lessons: z.array(z.strictObject({ hypothesis: z.string().min(1), outcome: z.enum(["accepted", "rejected", "revised"]), lesson: z.string().min(1), confidence: z.number().min(0).max(1), evidenceRefs: z.array(evidenceRef) })),
  sitePath: z.string().min(1),
  fileTreeDocumented: z.boolean(),
  pseudocodeDocumented: z.boolean(),
  referenceComparisonDocumented: z.boolean(),
});
const convergenceGate = z.strictObject({
  summary: z.string().min(1), status: classification, passed: z.boolean(), evidenceRefs: z.array(evidenceRef), blockers: z.array(z.string().min(1)), checks: z.array(assertion),
});
const productionPlan = (domain: "state-journal" | "flows-harness" | "transcript-ui" | "platform-security") => z.strictObject({
  ...receiptFields,
  domain: z.literal(domain),
  architectureLessonsApplied: z.boolean(),
  slices: z.array(z.strictObject({ sliceId: z.string().min(1), ownedPaths: z.array(z.string().min(1)), dependencies: z.array(z.string().min(1)), acceptanceClauses: z.array(z.string().min(1)), commands: z.array(z.string().min(1)) })),
});
const supervisorPlan = z.strictObject({
  ...receiptFields,
  ownershipConflicts: z.array(z.string().min(1)),
  waves: z.array(z.strictObject({ waveId: z.string().min(1), sliceIds: z.array(z.string().min(1)), dependsOnWaves: z.array(z.string().min(1)), serialMerge: z.boolean() })),
  acceptanceClausesMapped: z.array(z.string().min(1)),
});
const wavePlan = z.strictObject({
  ...receiptFields,
  waveId: z.string().min(1), correctionRound: z.number().int().nonnegative(), sliceIds: z.array(z.string().min(1)).min(1).max(4), uniquePathOwnership: z.boolean(), acceptanceCommands: z.array(z.string().min(1)),
});
const implementationReceipt = z.strictObject({
  ...receiptFields,
  waveId: z.string().min(1), sliceIds: z.array(z.string().min(1)).length(1), branch: z.string().min(1), commit: commitReceipt.nullable(), changedFiles: z.array(z.string().min(1)), acceptanceCovered: z.array(z.string().min(1)),
});
const mergeReceipt = z.strictObject({
  ...receiptFields,
  integrated: z.boolean(), targetBranch: z.string().min(1), commits: z.array(commitReceipt), conflicts: z.array(z.string().min(1)), landedOnMain: z.literal(false), forcePushed: z.literal(false),
});
const e2eReceipt = (phase: "production" | "review") => z.strictObject({
  ...receiptFields,
  phase: z.literal(phase),
  missingCommandsBuilt: z.boolean(), assertions: acceptanceAssertions, dependencyBoundary, artifacts: z.array(evidenceRef),
});
const reviewReceipt = z.strictObject({
  ...receiptFields,
  verdict: z.enum(["pass", "changes_requested", "blocked"]), reviewedCommits: z.array(z.string().min(7)), findings: z.array(z.strictObject({ severity: z.enum(["critical", "major", "minor"]), description: z.string().min(1), evidenceRefs: z.array(evidenceRef) })),
});
const correctionReceipt = (phase: "review" | "final") => z.strictObject({
  ...receiptFields,
  phase: z.literal(phase),
  corrections: z.array(z.strictObject({ finding: z.string().min(1), introducingCommit: z.string().min(7), correctionCommit: z.string().min(7), evidenceRefs: z.array(evidenceRef) })),
});
const finalScan = z.strictObject({ ...receiptFields, findings: z.array(z.strictObject({ category: z.enum(["architecture", "dependency", "legacy-boundary", "line-growth", "documentation", "evidence"]), severity: z.enum(["critical", "major", "minor"]), description: z.string().min(1), evidenceRefs: z.array(evidenceRef) })), simplificationScore: z.number().min(0).max(100) });
const finalArchitecture = z.strictObject({ ...receiptFields, architectureScore: z.number().min(0).max(100), sitePath: z.string().min(1), documentedFiles: z.array(z.string().min(1)), fileTreeDocumented: z.boolean(), pseudocodeDocumented: z.boolean(), referenceComparisonDocumented: z.boolean(), decisionsLinkedToEvidence: z.boolean() });
const historyReceipt = z.strictObject({ ...receiptFields, backupBookmark: z.string().min(1), targetBranch: z.string().min(1), commits: z.array(commitReceipt).min(1), forcePushed: z.literal(false), landedOnMain: z.literal(false) });
const commitSeriesVerify = z.strictObject({ ...receiptFields, allCommitsVerified: z.boolean(), commitResults: z.array(z.strictObject({ sha: z.string().min(7), status: classification, commands: z.array(commandResult), evidenceRefs: z.array(evidenceRef) })) });
const finalVerify = z.strictObject({ ...receiptFields, assertions: acceptanceAssertions, dependencyBoundary, architectureScore: z.number().min(0).max(100), allCommitsVerified: z.boolean(), cleanWorkingTree: z.boolean(), artifacts: z.array(evidenceRef) });
const release = z.strictObject({
  summary: z.string().min(1), status: z.enum(["production-ready", "blocked"]), architectureScore: z.number().min(0).max(100), e2eStatus: classification,
  gateReceipts: z.strictObject({ poc: z.boolean(), production: z.boolean(), review: z.boolean(), final: z.boolean(), history: z.boolean() }),
  assertions: acceptanceAssertions.nullable(), commitManifest: z.array(commitReceipt), backupBookmark: z.string().nullable(), artifactLocations: z.array(evidenceRef), evidenceRefs: z.array(evidenceRef), blockers: z.array(z.string().min(1)),
});

const { smithers, outputs } = createSmithers({
  input, initialize, prepare_poc_worktrees: worktreePreparation, inventory_research: inventoryResearch, validate_inventory_evidence: inventoryEvidenceValidation, inventory_synthesis: inventorySynthesis,
  poc_round_plan: pocRoundPlan, validate_poc_round_plan: pocRoundPlanValidation, prepare_poc_foundation_dependencies: pocFoundationBootstrap, poc_authority_foundation: pocAuthorityFoundation, prepare_poc_round_base: worktreePreparation,
  poc_state_journal: pocStateJournal, poc_flows_harness: pocFlowsHarness,
  poc_platform_worldview: pocPlatformWorldview, poc_transcript_chat_ui: pocTranscriptChatUi,
  poc_integrate_verify: pocIntegrateVerify, poc_failure_route: failureRoute("poc"), architecture_learn: architectureLearn, poc_gate: convergenceGate,
  production_plan_state_journal: productionPlan("state-journal"), production_plan_flows_harness: productionPlan("flows-harness"),
  production_plan_transcript_ui: productionPlan("transcript-ui"), production_plan_platform_security: productionPlan("platform-security"),
  production_supervisor_plan: supervisorPlan, production_wave_plan: wavePlan, prepare_production_worktrees: worktreePreparation, production_slice_implement: implementationReceipt,
  production_merge: mergeReceipt, production_e2e: e2eReceipt("production"), production_failure_route: failureRoute("production"), production_gate: convergenceGate,
  commit_review: reviewReceipt, stack_review: reviewReceipt, review_correction: correctionReceipt("review"), review_e2e: e2eReceipt("review"), review_gate: convergenceGate,
  final_scan: finalScan, final_fix: correctionReceipt("final"), final_architecture_update: finalArchitecture,
  history_curate: historyReceipt, commit_series_verify: commitSeriesVerify, final_verify: finalVerify, release_readiness: release,
});

const allTrue = (value: Record<string, boolean> | undefined) => value !== undefined && Object.values(value).every(Boolean);
const authorityFoundationAssertionsReady = (
  assertions: z.infer<typeof pocAuthorityFoundation>["assertions"],
) => {
  const { productBuild: _deferredRendererBuild, ...authorityAssertions } = assertions;
  return allTrue(authorityAssertions);
};
const authorityFoundationReadyForFanout = (
  foundation: z.infer<typeof pocAuthorityFoundation>,
) => {
  const normalPass = foundation.status === "pass" && foundation.hypothesisVerdict === "proven";
  const rendererGateWasMisassigned = foundation.status === "product_failure"
    && foundation.hypothesisVerdict === "falsified"
    && foundation.assertions.productBuild === false
    && foundation.commands.some((command) => command.exitCode === 0 && /vite[^\n]*build/i.test(command.command));
  return authorityFoundationAssertionsReady(foundation.assertions)
    && (normalPass || rendererGateWasMisassigned);
};
const refs = (...groups: Array<string[] | undefined>) => [...new Set(groups.flatMap((group) => group ?? []))];
const blockers = (...groups: Array<string[] | undefined>) => [...new Set(groups.flatMap((group) => group ?? []))];
const skippedLaneBase = <Lane extends "state-journal" | "flows-harness" | "platform-worldview" | "transcript-chat-ui">(
  lane: Lane,
  branch: string,
  executionCwd: string,
  preparation: z.infer<typeof worktreePreparation>,
) => ({
  summary: `Skipped ${lane} because the serial authority foundation did not produce a verified round base.`,
  status: "environment_failure" as const,
  evidenceRefs: preparation.evidenceRefs,
  blockers: ["prepare_poc_round_base.status must be pass before any domain implementation agent is scheduled."],
  commands: [],
  lane,
  hypothesisVerdict: "inconclusive" as const,
  branch,
  executionCwd,
  commitSha: null,
  changedFiles: [],
});
const receiptContext = (entries: Record<string, unknown>) => Object.entries(entries)
  .map(([label, value]) => `${label}:\n${JSON.stringify(value ?? null, null, 2)}`)
  .join("\n\n");
type PromptDeps = Record<string, unknown>;
const safeSegment = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "slice";
const evidencePath = (reference: string) => reference.replace(/:\d+(?:-\d+)?$/, "");
const validateInventoryEvidence = (research: z.infer<typeof inventoryResearch>) => {
  const checkedRefs = refs(
    research.evidenceRefs,
    research.commands.map((command) => command.evidenceRef),
    research.claims.flatMap((claim) => claim.evidenceRefs),
    research.referenceComparisons.flatMap((comparison) => comparison.evidenceRefs),
    research.instructionSources,
  );
  const nonLocalRefs = checkedRefs.filter((reference) => !path.isAbsolute(evidencePath(reference)));
  const missingRefs = checkedRefs.filter((reference) => path.isAbsolute(evidencePath(reference)) && !existsSync(evidencePath(reference)));
  return { checkedRefs, missingRefs, nonLocalRefs };
};
const ownedPathMatches = (file: string, patterns: string[]) => patterns.some((pattern) => {
  const normalizedFile = file.replace(/^\.\//, "");
  const normalizedPattern = pattern.replace(/^\.\//, "");
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
  }
  return normalizedFile === normalizedPattern;
});
const pocLanes = pocLaneName.options;
const requiredAuthorityPaths = [
  "package.json",
  "bun.lock",
  "src/bun/index.ts",
  "src/shared/NativeRPC.ts",
  "src/bun/authority/**",
  "src/shared/authority/**",
] as const;
const canonicalOwnedPath = /^(?!\/)(?!.*(?:\s|[():\\]))(?:[A-Za-z0-9._@+-]+\/)*(?:[A-Za-z0-9._@+-]+|\*\*)$/;
const ownedPathWitness = (pattern: string) => pattern.endsWith("/**") ? `${pattern.slice(0, -3)}/__ownership_probe__` : pattern;
const validatePocRoundPlan = (
  plan: z.infer<typeof pocRoundPlan>,
  preparation: z.infer<typeof worktreePreparation>,
) => {
  const laneCounts = new Map<string, number>();
  for (const lane of plan.laneOwnership) laneCounts.set(lane.lane, (laneCounts.get(lane.lane) ?? 0) + 1);
  const duplicateLanes = pocLanes.filter((lane) => (laneCounts.get(lane) ?? 0) > 1);
  const checkedLanes = pocLanes.filter((lane) => (laneCounts.get(lane) ?? 0) === 1);
  const invalidPaths = plan.laneOwnership.flatMap((lane) => lane.ownedPaths
    .filter((ownedPath) => !canonicalOwnedPath.test(ownedPath) || ownedPath.startsWith("./") || ownedPath.includes("//"))
    .map((ownedPath) => ({
      lane: lane.lane,
      ownedPath,
      reason: "Owned paths must be canonical repo-relative paths or a terminal /** prefix, with no annotations, whitespace, colon, parentheses, or backslashes.",
    })));
  const authorityPaths = plan.laneOwnership.find((lane) => lane.lane === "authority-foundation")?.ownedPaths ?? [];
  const missingAuthorityPaths = requiredAuthorityPaths.filter((requiredPath) => !authorityPaths.includes(requiredPath));
  const ownershipConflicts = new Set<string>();
  for (let index = 0; index < plan.laneOwnership.length; index += 1) {
    const left = plan.laneOwnership[index]!;
    for (let otherIndex = index + 1; otherIndex < plan.laneOwnership.length; otherIndex += 1) {
      const right = plan.laneOwnership[otherIndex]!;
      const overlap = left.ownedPaths.some((pattern) => ownedPathMatches(ownedPathWitness(pattern), right.ownedPaths))
        || right.ownedPaths.some((pattern) => ownedPathMatches(ownedPathWitness(pattern), left.ownedPaths));
      if (overlap) ownershipConflicts.add(`${left.lane} overlaps ${right.lane}`);
    }
  }
  for (const lane of plan.laneOwnership.filter((entry) => entry.lane !== "authority-foundation")) {
    const reservedWitnesses = [
      "package.json",
      "bun.lock",
      "src/bun/index.ts",
      "src/shared/NativeRPC.ts",
      "src/bun/authority/__ownership_probe__",
      "src/shared/authority/__ownership_probe__",
    ];
    if (reservedWitnesses.some((reserved) => ownedPathMatches(reserved, lane.ownedPaths))) {
      ownershipConflicts.add(`${lane.lane} claims a serial authority-foundation path`);
    }
  }
  const baseMismatch = plan.baseRevision !== preparation.baseRevision || plan.baseRef !== preparation.baseRef;
  const valid = checkedLanes.length === pocLanes.length
    && duplicateLanes.length === 0
    && invalidPaths.length === 0
    && missingAuthorityPaths.length === 0
    && ownershipConflicts.size === 0
    && !baseMismatch;
  return {
    valid,
    checkedLanes,
    duplicateLanes,
    invalidPaths,
    missingAuthorityPaths: [...missingAuthorityPaths],
    ownershipConflicts: [...ownershipConflicts],
    baseMismatch,
  };
};
type GitWorktreeSpec = { path: string; branch: string };

export function isSafeRelativeArchitecturePath(value: string): boolean {
  if (!value || value.includes("\\") || path.isAbsolute(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    && path.posix.normalize(value) === value;
}

/** Resolve inside a worktree and reject any existing symlink in the path. */
export function resolveArchitectureSitePath(worktreeRoot: string, relativePath: string): string {
  if (!isSafeRelativeArchitecturePath(relativePath)) {
    throw new Error(`Unsafe architectureSitePath: ${relativePath}`);
  }
  const lexicalRoot = path.resolve(worktreeRoot);
  const lexicalTarget = path.resolve(lexicalRoot, relativePath);
  if (!lexicalTarget.startsWith(`${lexicalRoot}${path.sep}`)) {
    throw new Error(`architectureSitePath escapes its worktree: ${relativePath}`);
  }
  if (!existsSync(lexicalRoot)) return lexicalTarget;
  const canonicalRoot = realpathSync(lexicalRoot);
  let current = lexicalRoot;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`architectureSitePath traverses a symbolic link: ${current}`);
    }
    const canonicalCurrent = realpathSync(current);
    if (canonicalCurrent !== canonicalRoot && !canonicalCurrent.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error(`architectureSitePath escapes its canonical worktree: ${current}`);
    }
  }
  return path.join(canonicalRoot, relativePath);
}
const execText = (command: string, args: string[], cwd: string) => execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
const runBounded = (command: string, args: string[], cwd: string, timeoutMs: number) =>
  runBoundedProcess(command, args, cwd, { timeoutMs });
const measureDependencyTree = (root: string) => {
  const pending = [root];
  let installedFiles = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current)) {
      const candidate = path.join(current, entry);
      const stat = lstatSync(candidate);
      installedFiles += 1;
      if (stat.isDirectory() && !stat.isSymbolicLink()) pending.push(candidate);
    }
  }
  const installedKilobytes = Number.parseInt(execText("du", ["-sk", root], path.dirname(root)).split(/\s+/)[0] ?? "0", 10);
  return { installedBytes: installedKilobytes * 1024, installedFiles };
};
const freezeGitRevision = (targetRepo: string, mutableRevision: string, label: string) => {
  const tree = execText("git", ["rev-parse", `${mutableRevision}^{tree}`], targetRepo);
  const parents = execText("git", ["show", "-s", "--format=%P", mutableRevision], targetRepo)
    .split(/\s+/)
    .filter(Boolean);
  const parentArgs = parents.flatMap((parent) => ["-p", parent]);
  const frozenRevision = execText("git", ["commit-tree", tree, ...parentArgs, "-m", label], targetRepo);
  execText("git", ["diff", "--quiet", mutableRevision, frozenRevision, "--", "."], targetRepo);
  return frozenRevision;
};
const gitGrep = (targetRepo: string, args: string[]) => {
  const result = spawnSync("git", ["grep", ...args], { cwd: targetRepo, encoding: "utf8" });
  if (result.status !== 0 && result.status !== 1) throw new Error(`git grep failed (${result.status}): ${result.stderr.trim()}`);
  return result.stdout.trim();
};
const measureBaseline = (targetRepo: string, baseRevision: string) => {
  const productLineRows = gitGrep(targetRepo, ["-n", "-I", "-e", "^", baseRevision, "--", "src"]);
  const legacyFiles = gitGrep(targetRepo, ["-l", "-E", "-e", "@smthrs/|/Users/williamcory/smithers", baseRevision, "--", "src", "package.json", "bun.lock"]);
  const manifest = JSON.parse(execText("git", ["show", `${baseRevision}:package.json`], targetRepo)) as { dependencies?: Record<string, unknown> };
  return {
    productLines: productLineRows ? productLineRows.split("\n").length : 0,
    productionDependencies: Object.keys(manifest.dependencies ?? {}).length,
    legacyImportViolations: legacyFiles ? legacyFiles.split("\n").length : 0,
  };
};
const prepareGitWorktrees = (targetRepo: string, baseRef: string, specs: GitWorktreeSpec[]) => {
  const prepared: Array<GitWorktreeSpec & { headRevision: string }> = [];
  const commands: z.infer<typeof commandResult>[] = [];
  for (const spec of specs) {
    mkdirSync(path.dirname(spec.path), { recursive: true });
    const command = `git worktree add -B ${spec.branch} ${spec.path} ${baseRef}`;
    if (!existsSync(spec.path)) execText("git", ["worktree", "add", "-B", spec.branch, spec.path, baseRef], targetRepo);
    const actualRoot = realpathSync(execText("git", ["rev-parse", "--show-toplevel"], spec.path));
    const expectedRoot = realpathSync(spec.path);
    if (actualRoot !== expectedRoot) throw new Error(`Worktree root mismatch: expected ${expectedRoot}, received ${actualRoot}`);
    const actualBranch = execText("git", ["branch", "--show-current"], spec.path);
    if (actualBranch !== spec.branch) throw new Error(`Worktree branch mismatch at ${spec.path}: expected ${spec.branch}, received ${actualBranch}`);
    const headRevision = execText("git", ["rev-parse", "HEAD"], spec.path);
    prepared.push({ ...spec, headRevision });
    commands.push({ command, classification: "pass", exitCode: 0, summary: `Prepared isolated Git worktree ${spec.branch}.`, evidenceRef: spec.path });
  }
  return { prepared, commands };
};
const resetGitWorktrees = (baseRevision: string, specs: GitWorktreeSpec[]) => {
  const prepared: Array<GitWorktreeSpec & { headRevision: string }> = [];
  const commands: z.infer<typeof commandResult>[] = [];
  for (const spec of specs) {
    const actualRoot = realpathSync(execText("git", ["rev-parse", "--show-toplevel"], spec.path));
    const expectedRoot = realpathSync(spec.path);
    if (actualRoot !== expectedRoot) throw new Error(`Worktree root mismatch: expected ${expectedRoot}, received ${actualRoot}`);
    const actualBranch = execText("git", ["branch", "--show-current"], spec.path);
    if (actualBranch !== spec.branch) throw new Error(`Worktree branch mismatch at ${spec.path}: expected ${spec.branch}, received ${actualBranch}`);
    const dirty = execText("git", ["status", "--porcelain", "--untracked-files=no"], spec.path);
    if (dirty !== "") throw new Error(`Refusing to reset a modified disposable worktree: ${spec.path}`);
    execText("git", ["reset", "--hard", baseRevision], spec.path);
    const headRevision = execText("git", ["rev-parse", "HEAD"], spec.path);
    if (headRevision !== baseRevision) throw new Error(`Round-base reset failed at ${spec.path}`);
    prepared.push({ ...spec, headRevision });
    commands.push({ command: `git reset --hard ${baseRevision}`, classification: "pass", exitCode: 0, summary: `Advanced ${spec.branch} to the verified serial authority foundation.`, evidenceRef: spec.path });
  }
  return { prepared, commands };
};
const cloneFoundationDependencies = (foundationRoot: string, specs: GitWorktreeSpec[]) => {
  const source = path.join(realpathSync(foundationRoot), "node_modules");
  if (!existsSync(source)) throw new Error(`Verified foundation has no dependency tree: ${source}`);
  const commands: z.infer<typeof commandResult>[] = [];
  for (const spec of specs) {
    const root = realpathSync(spec.path);
    const destination = path.join(root, "node_modules");
    if (path.dirname(destination) !== root) throw new Error(`Unsafe dependency destination: ${destination}`);
    rmSync(destination, { recursive: true, force: true });
    cpSync(source, destination, { recursive: true, mode: fsConstants.COPYFILE_FICLONE });
    commands.push({ command: `copy-on-write clone ${source} -> ${destination}`, classification: "pass", exitCode: 0, summary: `Reused the verified foundation dependency tree for ${spec.branch} without another network install.`, evidenceRef: destination });
  }
  return commands;
};
const acceptanceContract = `SQLite-backed TanStack DB authority synced from one host SQLite record through monotonic all-collection ProjectionBatch revisions; actor-recorded Flux plus atomic Journal for every mutation; Journal.transact is storage-only and may contain app-table writes plus Journal evidence but never Flow bodies, Activity bodies, model calls, tools, MCP, connectors, filesystem work, boundary prepare/settle, or other external effects; external work uses the real new-Flows Activity sealed/compensable/irreversible tiers with stable idempotency keys, applicable ownership fencing, and compensation/recovery evidence because no local WAL or projection batch makes a remote effect atomic; one Flow registry with slash, ctx.call, and button parity; connectors; workspace/branch/revision; Harness Cell executing Smithers scripts; recursive native subagents and external adapters; worldview/memory with provenance; renderer-neutral transcript with individually vendored, content-pinned Brainless Claude and Brainless Codex accessible React primitives, never full provider session/composer blocks; no agent tabs; new content as an embedded mini-app; the same component maximized; persistent composer chrome; URL-addressed durable frame graph; browser back/forward; minimize/maximize; historical-frame fork; accessibility, visual, and native E2E; new @smithers/* product dependencies only; serial host and RPC composition roots that keep parallel domain ownership conflict-free; and a concise, navigable architecture documentation site built from the app's existing components and design tokens, with visual diagrams or annotated product imagery, a verified file tree, concrete pseudocode, and an evidence-backed comparison of mvp, flows/ui, multi, gui, new Flows/Harness, and Smithers-Ops product decisions. The governing implementation evidence is /Users/williamcory/flows/flows/docs/architecture/implementation-status.md. /Users/williamcory/mvp/DESIGN.md is the live authoritative engineering handoff and must be read directly even when it is newer than the pinned code snapshot. Checked D1/D2 items are regression contracts, not missing work: retry failed turns; per-message copy; the /connect, /world, /plan, and /reset menu with slash/Smithers/button parity; Smithers-driven suggestions via actions.replaced; PlanCard, ApprovalCard, and StatusCard states with one live approval; World delete confirmation; shared SurfaceHeader; connector copy and remove confirmation; and Smithers MessageAvatar. The current unchecked engineering work is mandatory: lucide ArrowUp and Square composer glyphs without adding a legacy product dependency; the backend half of the NDJSON card/card.update contract with a Flow name, AgentTurnFrame support, and a real approval-decision round trip; and the World BacklinksPanel plus OutlineView. Keep DESIGN.md post-demo items labelled and outside the demo gate: day grouping, ArtifactCard, DiffCard, Analyze codebase, full frame navigation, and Vitest plus Testing Library state smoke tests. Frame durability and test work may still be required independently by this broader architecture-readiness contract; do not mislabel that work as D2 or demo scope.`;

export default smithers((ctx) => {
  const targetRepo = ctx.input.targetRepo;
  const architectureSitePath = ctx.input.architectureSitePath;
  const maxPrototypeRounds = ctx.input.maxPrototypeRounds;
  const maxProductionRounds = ctx.input.maxProductionRounds;
  const maxConcurrency = ctx.input.maxConcurrency;
  const runSegment = ctx.runId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const worktreeRoot = path.join(path.dirname(targetRepo), ".smithers-worktrees", path.basename(targetRepo), runSegment);
  const branchRoot = `smithers/production-readiness/${runSegment}`;
  const baselineBranch = `${branchRoot}/baseline`;
  const candidateBranch = `${branchRoot}/candidate`;
  const backupBookmark = `${branchRoot}/backup`;
  const pocGateReceipt = ctx.latest(outputs.poc_gate, "poc_gate");
  const pocConverged = pocGateReceipt?.passed === true;
  const completedPocRounds = ctx.iterationCount(outputs.poc_gate, "poc_gate");
  const activePocRound = Math.min(
    Math.max(1, completedPocRounds + (pocConverged ? 0 : 1)),
    maxPrototypeRounds,
  );
  const pocRounds = Array.from({ length: maxPrototypeRounds }, (_, index) => {
    const ordinal = index + 1;
    const roundSegment = ordinal === 1 ? "" : `round-${String(ordinal).padStart(2, "0")}`;
    const roundBranchRoot = roundSegment ? `${branchRoot}/${roundSegment}` : branchRoot;
    const roundWorktreeRoot = roundSegment ? path.join(worktreeRoot, roundSegment) : worktreeRoot;
    const branches = {
      authorityFoundation: `${roundBranchRoot}/poc-authority-foundation`,
      stateJournal: `${roundBranchRoot}/poc-state-journal`,
      flowsHarness: `${roundBranchRoot}/poc-flows-harness`,
      platformWorldview: `${roundBranchRoot}/poc-platform-worldview`,
      transcriptChatUi: `${roundBranchRoot}/poc-transcript-chat-ui`,
    } as const;
    const integrationBranch = `${roundBranchRoot}/poc-integration`;
    const specs: GitWorktreeSpec[] = [
      { path: path.join(roundWorktreeRoot, "poc-authority-foundation"), branch: branches.authorityFoundation },
      { path: path.join(roundWorktreeRoot, "poc-state-journal"), branch: branches.stateJournal },
      { path: path.join(roundWorktreeRoot, "poc-flows-harness"), branch: branches.flowsHarness },
      { path: path.join(roundWorktreeRoot, "poc-platform-worldview"), branch: branches.platformWorldview },
      { path: path.join(roundWorktreeRoot, "poc-transcript-chat-ui"), branch: branches.transcriptChatUi },
      { path: path.join(roundWorktreeRoot, "poc-integration"), branch: integrationBranch },
    ];
    return { ordinal, branches, integrationBranch, distributionRoot: path.join(worktreeRoot, "smithers-distribution"), specs };
  });
  const activeRound = pocRounds[activePocRound - 1]!;
  const pocBranches = activeRound.branches;
  const pocIntegrationBranch = activeRound.integrationBranch;
  const pocDistributionRoot = activeRound.distributionRoot;
  const pocWorktreeSpecs = pocRounds.flatMap((round) => round.specs);
  const pocWorktreePath = (lane: "poc-authority-foundation" | "poc-state-journal" | "poc-flows-harness" | "poc-platform-worldview" | "poc-transcript-chat-ui" | "poc-integration") => activeRound.specs.find((spec) => spec.path.endsWith(`/${lane}`))!.path;
  const expectedPocArchitectureSitePath = resolveArchitectureSitePath(pocWorktreePath("poc-integration"), architectureSitePath);

  const inventoryEvidenceReceipt = ctx.latest(outputs.validate_inventory_evidence, "validate_inventory_evidence");
  const inventoryEvidenceValid = inventoryEvidenceReceipt?.status === "pass";
  const pocRoundPlanReceipt = ctx.latest(outputs.poc_round_plan, "poc_round_plan");
  const pocRoundPlanValidationReceipt = ctx.latest(outputs.validate_poc_round_plan, "validate_poc_round_plan");
  const pocRoundPlanValid = pocRoundPlanValidationReceipt?.status === "pass" && pocRoundPlanValidationReceipt.valid;
  const pocFoundationBootstrapReceipt = ctx.latest(outputs.prepare_poc_foundation_dependencies, "prepare_poc_foundation_dependencies");
  const pocFoundationBootstrapReady = pocFoundationBootstrapReceipt?.status === "pass"
    && pocFoundationBootstrapReceipt.distributionManifest !== null
    && pocFoundationBootstrapReceipt.dependencyFootprint !== null
    && allTrue(pocFoundationBootstrapReceipt.assertions);
  const pocFoundationReceipt = ctx.latest(outputs.poc_authority_foundation, "poc_authority_foundation");
  const pocRoundBasePreparation = ctx.latest(outputs.prepare_poc_round_base, "prepare_poc_round_base");
  const pocRoundBaseReady = pocRoundBasePreparation?.status === "pass";
  const pocStateReceipt = ctx.latest(outputs.poc_state_journal, "poc_state_journal");
  const pocFlowsReceipt = ctx.latest(outputs.poc_flows_harness, "poc_flows_harness");
  const pocPlatformReceipt = ctx.latest(outputs.poc_platform_worldview, "poc_platform_worldview");
  const pocTranscriptReceipt = ctx.latest(outputs.poc_transcript_chat_ui, "poc_transcript_chat_ui");
  const pocIntegration = ctx.latest(outputs.poc_integrate_verify, "poc_integrate_verify");
  const pocArchitecture = ctx.latest(outputs.architecture_learn, "architecture_learn");
  const pocFailure = ctx.latest(outputs.poc_failure_route, "poc_failure_route");
  const pocExhausted = !pocConverged && ctx.iterationCount(outputs.poc_gate, "poc_gate") >= maxPrototypeRounds;

  const statePlan = ctx.latest(outputs.production_plan_state_journal, "production_plan_state_journal");
  const flowsPlan = ctx.latest(outputs.production_plan_flows_harness, "production_plan_flows_harness");
  const transcriptPlan = ctx.latest(outputs.production_plan_transcript_ui, "production_plan_transcript_ui");
  const platformPlan = ctx.latest(outputs.production_plan_platform_security, "production_plan_platform_security");
  const productionWave = ctx.latest(outputs.production_wave_plan, "production_wave_plan");
  const productionMerge = ctx.latest(outputs.production_merge, "production_merge");
  const productionE2e = ctx.latest(outputs.production_e2e, "production_e2e");
  const productionFailure = ctx.latest(outputs.production_failure_route, "production_failure_route");
  const productionGateReceipt = ctx.latest(outputs.production_gate, "production_gate");
  const productionConverged = productionGateReceipt?.passed === true;
  const productionExhausted = pocConverged && !productionConverged && ctx.iterationCount(outputs.production_gate, "production_gate") >= maxProductionRounds;

  const commitReview = ctx.latest(outputs.commit_review, "commit_review");
  const stackReview = ctx.latest(outputs.stack_review, "stack_review");
  const reviewCorrectionNeeded = commitReview?.verdict === "changes_requested" || stackReview?.verdict === "changes_requested";
  const reviewE2e = ctx.latest(outputs.review_e2e, "review_e2e");
  const reviewGateReceipt = ctx.latest(outputs.review_gate, "review_gate");
  const reviewPassed = reviewGateReceipt?.passed === true;
  const reviewFailed = reviewGateReceipt !== undefined && !reviewPassed;

  const finalArchitectureReceipt = ctx.latest(outputs.final_architecture_update, "final_architecture_update");
  const history = ctx.latest(outputs.history_curate, "history_curate");
  const commitVerification = ctx.latest(outputs.commit_series_verify, "commit_series_verify");
  const finalVerification = ctx.latest(outputs.final_verify, "final_verify");
  const sliceDescriptors = (productionWave?.sliceIds ?? []).map((sliceId, index) => {
    const suffix = `${String(index + 1).padStart(2, "0")}-${safeSegment(sliceId)}`;
    return {
      sliceId,
      taskId: `production_slice_${suffix}`,
      worktreeId: `production-slice-worktree-${suffix}`,
      worktreePath: path.join(worktreeRoot, "production-slices", suffix),
      branch: `${branchRoot}/slice-${suffix}`,
    };
  });
  const sliceTaskIds = sliceDescriptors.map((slice) => slice.taskId);
  const sliceNeeds = Object.fromEntries(sliceDescriptors.map((slice) => [slice.taskId, slice.taskId]));
  const sliceDeps = Object.fromEntries(sliceDescriptors.map((slice) => [slice.taskId, outputs.production_slice_implement]));
  const mergeNeeds = { wavePlan: "production_wave_plan", ...sliceNeeds };
  const mergeDeps = { wavePlan: outputs.production_wave_plan, ...sliceDeps };

  const releaseVerdict = () => {
    const pocPassed = pocGateReceipt?.passed === true;
    const productionPassed = productionGateReceipt?.passed === true;
    const reviewsPassed = reviewGateReceipt?.passed === true;
    const finalPassed = finalVerification?.status === "pass" && allTrue(finalVerification.assertions) && finalVerification.dependencyBoundary.violations.length === 0 && finalVerification.allCommitsVerified && finalVerification.cleanWorkingTree;
    const historyPassed = history?.status === "pass" && history.forcePushed === false && history.landedOnMain === false && commitVerification?.status === "pass" && commitVerification.allCommitsVerified;
    const architecturePassed = finalArchitectureReceipt?.status === "pass" && finalArchitectureReceipt.architectureScore >= 90 && finalArchitectureReceipt.fileTreeDocumented && finalArchitectureReceipt.pseudocodeDocumented && finalArchitectureReceipt.referenceComparisonDocumented && finalArchitectureReceipt.decisionsLinkedToEvidence;
    const ready = pocPassed && productionPassed && reviewsPassed && finalPassed && historyPassed && architecturePassed;
    const missing = [
      !pocPassed ? "POC convergence evidence did not pass." : null,
      !productionPassed ? "Production E2E convergence evidence did not pass." : null,
      !reviewsPassed ? "Post-E2E review evidence did not pass." : null,
      !finalPassed ? "Final acceptance assertions did not all pass." : null,
      !historyPassed ? "Curated non-main history was not fully verified." : null,
      !architecturePassed ? "Architecture documentation evidence did not pass." : null,
    ].filter((item): item is string => item !== null);
    return {
      summary: ready ? "All typed production-readiness evidence passed without legacy imports, main landing, or force-push." : "Production readiness is blocked by one or more failed or missing typed receipts.",
      status: ready ? "production-ready" as const : "blocked" as const,
      architectureScore: finalArchitectureReceipt?.architectureScore ?? pocArchitecture?.architectureScore ?? 0,
      e2eStatus: finalVerification?.status ?? reviewE2e?.status ?? productionE2e?.status ?? "not_run" as const,
      gateReceipts: { poc: pocPassed, production: productionPassed, review: reviewsPassed, final: finalPassed && architecturePassed, history: historyPassed },
      assertions: finalVerification?.assertions ?? null,
      commitManifest: history?.commits ?? [],
      backupBookmark: history?.backupBookmark ?? null,
      artifactLocations: refs(finalVerification?.artifacts, finalArchitectureReceipt?.documentedFiles, [architectureSitePath]),
      evidenceRefs: refs(pocGateReceipt?.evidenceRefs, productionGateReceipt?.evidenceRefs, reviewGateReceipt?.evidenceRefs, finalVerification?.evidenceRefs, commitVerification?.evidenceRefs),
      blockers: blockers(missing, pocGateReceipt?.blockers, productionGateReceipt?.blockers, reviewGateReceipt?.blockers, finalVerification?.blockers, commitVerification?.blockers),
    };
  };

  return <Workflow name="production-readiness-swarm">
    <UI entry="../ui/production-readiness-swarm.tsx" title="Production Readiness Swarm" />
    <Memory bank={`production-readiness:${targetRepo}`} retain="on-complete" tools>
      <Sequence>
        <Task id="initialize" output={outputs.initialize}>{() => ({
          summary: ctx.input.acceptanceCommands.length > 0 ? "Validated the run contract and accepted explicit E2E commands." : "Validated the run contract; missing E2E commands are scheduled as implementation work.",
          status: "ready" as const,
          contractVersion: "production-readiness-swarm/v2" as const,
          contractValidationPassed: true,
          resolvedAcceptanceCommands: ctx.input.acceptanceCommands,
          e2eCommandAction: ctx.input.acceptanceCommands.length > 0 ? "use_provided" as const : "build_missing" as const,
          instructionSources: [path.join(targetRepo, "AGENTS.md")],
          blockers: [],
        })}</Task>
        <Task id="prepare_poc_worktrees" output={outputs.prepare_poc_worktrees} retries={1} dependsOn={["initialize"]} needs={{ initialize: "initialize" }} deps={{ initialize: outputs.initialize }}>{() => {
          const mutableRevision = execText("jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id"], targetRepo);
          execText("git", ["cat-file", "-e", `${mutableRevision}^{commit}`], targetRepo);
          const baseRevision = freezeGitRevision(targetRepo, mutableRevision, `smithers: freeze production-readiness baseline ${runSegment}`);
          execText("git", ["branch", "-f", baselineBranch, baseRevision], targetRepo);
          const metrics = measureBaseline(targetRepo, baseRevision);
          const preparation = prepareGitWorktrees(targetRepo, baselineBranch, pocWorktreeSpecs);
          return {
            summary: "Pinned the exact versioned mvp snapshot and prepared every disposable POC checkout before agent scheduling.",
            status: "pass" as const,
            evidenceRefs: [targetRepo, ...preparation.prepared.map((item) => item.path)],
            blockers: [],
            commands: [
              { command: `jj log -r @; git commit-tree <tree>; git branch -f ${baselineBranch} <frozen-revision>`, classification: "pass" as const, exitCode: 0, summary: "Froze the mutable jj working-copy tree into an immutable Git-reachable run baseline.", evidenceRef: targetRepo },
              { command: `git grep/show ${baseRevision} -- src package.json bun.lock`, classification: "pass" as const, exitCode: 0, summary: `Measured the pinned baseline deterministically: ${metrics.productLines} product lines, ${metrics.productionDependencies} production dependencies, ${metrics.legacyImportViolations} legacy-violating files.`, evidenceRef: targetRepo },
              ...preparation.commands,
            ],
            baseRevision,
            baseRef: baselineBranch,
            metrics,
            worktrees: preparation.prepared,
          };
        }}</Task>
        <Ralph id="inventory-evidence-loop" maxIterations={3} onMaxReached="return-last" until={inventoryEvidenceValid}>
          <Sequence>
            <Task id="inventory_research" output={outputs.inventory_research} agent={providers.codexLuna} retries={1} dependsOn={["prepare_poc_worktrees"]} needs={{ initialize: "initialize", preparation: "prepare_poc_worktrees" }} deps={{ initialize: outputs.initialize, preparation: outputs.prepare_poc_worktrees }}>
              {(deps: PromptDeps) => <InventoryResearchPrompt acceptance={acceptanceContract} context={receiptContext({ initialization: deps.initialize, baselinePreparation: deps.preparation, priorEvidenceValidation: inventoryEvidenceReceipt, targetRepo, requiredReferenceRepos: ctx.input.sourceRepos })} />}
            </Task>
            <Task id="validate_inventory_evidence" output={outputs.validate_inventory_evidence} dependsOn={["inventory_research"]} needs={{ research: "inventory_research" }} deps={{ research: outputs.inventory_research }}>{(deps: PromptDeps) => {
              const research = deps.research as z.infer<typeof inventoryResearch>;
              const validation = validateInventoryEvidence(research);
              const passed = validation.missingRefs.length === 0 && validation.nonLocalRefs.length === 0;
              return {
                summary: passed ? "Every inventory evidence reference resolves to a local path." : "Inventory evidence contains missing or non-local references; the Ralph evidence loop will give these exact refs to the next inventory attempt.",
                status: passed ? "pass" as const : "product_failure" as const,
                evidenceRefs: validation.checkedRefs,
                blockers: passed ? [] : [...validation.missingRefs.map((reference) => `Missing evidence: ${reference}`), ...validation.nonLocalRefs.map((reference) => `Non-local evidence: ${reference}`)],
                commands: [{ command: "existsSync(normalizeLineSuffix(reference)) for every typed inventory evidence reference", classification: passed ? "pass" as const : "product_failure" as const, exitCode: passed ? 0 : 1, summary: `Checked ${validation.checkedRefs.length} evidence references.`, evidenceRef: targetRepo }],
                ...validation,
              };
            }}</Task>
          </Sequence>
        </Ralph>
        <Task id="inventory_synthesis" output={outputs.inventory_synthesis} agent={providers.codexSol} retries={1} dependsOn={["inventory_research", "validate_inventory_evidence", "prepare_poc_worktrees"]} needs={{ research: "inventory_research", validation: "validate_inventory_evidence", preparation: "prepare_poc_worktrees" }} deps={{ research: outputs.inventory_research, validation: outputs.validate_inventory_evidence, preparation: outputs.prepare_poc_worktrees }}>
          {(deps: PromptDeps) => <InventorySynthesisPrompt acceptance={acceptanceContract} context={receiptContext({ inventoryResearch: deps.research, inventoryEvidenceValidation: deps.validation, worktreePreparation: deps.preparation })} />}
        </Task>

        <Ralph id="poc-architecture-loop" maxIterations={maxPrototypeRounds * 4} onMaxReached="return-last" until={pocConverged || pocExhausted}>
          <Sequence>
            <Task id="poc_round_plan" output={outputs.poc_round_plan} agent={providers.codexSol} retries={1} dependsOn={["inventory_synthesis", "prepare_poc_worktrees"]} needs={{ synthesis: "inventory_synthesis", preparation: "prepare_poc_worktrees" }} deps={{ synthesis: outputs.inventory_synthesis, preparation: outputs.prepare_poc_worktrees }}>
              {(deps: PromptDeps) => <PocRoundPlanPrompt acceptance={acceptanceContract} context={receiptContext({ inventorySynthesis: deps.synthesis, worktreePreparation: deps.preparation, priorPlanValidation: pocRoundPlanValidationReceipt, priorPocGate: pocGateReceipt, priorFailureRoute: pocFailure, pocBranches, pocIntegrationBranch })} />}
            </Task>
            <Task id="validate_poc_round_plan" output={outputs.validate_poc_round_plan} dependsOn={["poc_round_plan", "prepare_poc_worktrees"]} needs={{ plan: "poc_round_plan", preparation: "prepare_poc_worktrees" }} deps={{ plan: outputs.poc_round_plan, preparation: outputs.prepare_poc_worktrees }}>{(deps: PromptDeps) => {
                  const plan = deps.plan as z.infer<typeof pocRoundPlan>;
                  const preparation = deps.preparation as z.infer<typeof worktreePreparation>;
                  const validation = validatePocRoundPlan(plan, preparation);
                  const invalidAuthorityChecks = (plan.laneOwnership.find((lane) => lane.lane === "authority-foundation")?.checks ?? [])
                    .filter((check) => /vite|product build|renderer build|postcss|tailwind|font pipeline/i.test(check));
                  const valid = validation.valid && invalidAuthorityChecks.length === 0;
                  const validationBlockers = [
                    ...validation.duplicateLanes.map((lane) => `Duplicate lane: ${lane}`),
                    ...validation.invalidPaths.map((entry) => `Invalid owned path for ${entry.lane}: ${entry.ownedPath}`),
                    ...validation.missingAuthorityPaths.map((ownedPath) => `Authority lane is missing exact ownership: ${ownedPath}`),
                    ...validation.ownershipConflicts,
                    ...(validation.baseMismatch ? [`Plan base ${plan.baseRevision}/${plan.baseRef} does not match prepared base ${preparation.baseRevision}/${preparation.baseRef}.`] : []),
                    ...invalidAuthorityChecks.map((check) => `Authority lane check crosses into the renderer/integration build gate: ${check}`),
                  ];
                  return {
                    summary: valid ? "POC lane ownership is canonical, disjoint, complete, phase-correct, and pinned to the prepared baseline." : "POC plan ownership or phase ordering is not machine-safe; the Ralph plan loop will give the exact validation failures to the next planner attempt.",
                    status: valid ? "pass" as const : "product_failure" as const,
                    evidenceRefs: [targetRepo],
                    blockers: validationBlockers,
                    commands: [{ command: "validatePocRoundPlan(plan, preparation) and reject renderer/build checks in authority-foundation", classification: valid ? "pass" as const : "product_failure" as const, exitCode: valid ? 0 : 1, summary: `Validated ${plan.laneOwnership.length} lane declarations and ${plan.laneOwnership.reduce((total, lane) => total + lane.ownedPaths.length, 0)} owned paths.`, evidenceRef: targetRepo }],
                    ...validation,
                    valid,
                  };
            }}</Task>
            {pocRoundPlanValidationReceipt === undefined || !pocRoundPlanValid ? null : <Sequence>
            <Task id="prepare_poc_foundation_dependencies" output={outputs.prepare_poc_foundation_dependencies} retries={1} dependsOn={["poc_round_plan", "validate_poc_round_plan", "prepare_poc_worktrees"]} needs={{ plan: "poc_round_plan", validation: "validate_poc_round_plan", preparation: "prepare_poc_worktrees" }} deps={{ plan: outputs.poc_round_plan, validation: outputs.validate_poc_round_plan, preparation: outputs.prepare_poc_worktrees }}>{async (deps: PromptDeps) => {
              const plan = deps.plan as z.infer<typeof pocRoundPlan>;
              const validation = deps.validation as z.infer<typeof pocRoundPlanValidation>;
              const foundationRoot = pocWorktreePath("poc-authority-foundation");
              const foundationOwnership = plan.laneOwnership.find((lane) => lane.lane === "authority-foundation")?.ownedPaths ?? [];
              const commandReceipts: z.infer<typeof commandResult>[] = [];
              let distributionManifest: z.infer<typeof smithersDistributionManifest> | null = null;
              let effectVersion: string | null = null;
              let measuredFootprint: z.infer<typeof dependencyFootprint> | null = null;
              let failure: string | null = null;
              let failureClassification: "environment_failure" | "product_failure" = "environment_failure";
              const assertions = {
                localDistributionPacked: false,
                externalConsumerSmoke: false,
                exactSourceProvenance: false,
                journalHarnessAdaptersConnectorsInstalled: false,
                effectRuntimeInstalled: false,
                bunLockfileMigrated: false,
                frozenLockfileInstall: false,
                dependencyFootprintMeasured: false,
                packageManifestWritesSerialized: false,
              };
              const record = (outcome: Awaited<ReturnType<typeof runBounded>>, evidenceRef: string) => {
                commandReceipts.push({
                  command: outcome.rendered,
                  classification: outcome.passed ? "pass" : "environment_failure",
                  exitCode: outcome.exitCode,
                  summary: outcome.summary,
                  evidenceRef,
                });
                if (!outcome.passed) throw new Error(outcome.summary);
                return outcome.stdout;
              };
              try {
                if (validation.status !== "pass" || !validation.valid) {
                  failureClassification = "product_failure";
                  throw new Error(`POC plan validation did not pass: ${validation.blockers.join("; ")}`);
                }
                const actualRoot = realpathSync(execText("git", ["rev-parse", "--show-toplevel"], foundationRoot));
                if (actualRoot !== realpathSync(foundationRoot)) throw new Error(`Foundation worktree root mismatch: ${actualRoot}`);
                const actualBranch = execText("git", ["branch", "--show-current"], foundationRoot);
                if (actualBranch !== pocBranches.authorityFoundation) throw new Error(`Foundation branch mismatch: ${actualBranch}`);
                const foundationHead = execText("git", ["rev-parse", "HEAD"], foundationRoot);
                if (foundationHead !== plan.baseRevision) {
                  const parents = execText("git", ["rev-list", "--parents", "-n", "1", "HEAD"], foundationRoot).split(" ");
                  if (parents.length !== 2) throw new Error("Bootstrap retry requires a single-parent authority-foundation commit.");
                  execText("git", ["diff", "--quiet", plan.baseRevision, `${foundationHead}^`, "--", "."], foundationRoot);
                  const committed = execText("git", ["diff", "--name-only", plan.baseRevision, foundationHead, "--", "."], foundationRoot);
                  const committedPaths = committed === "" ? [] : committed.split("\n").filter(Boolean);
                  if (committedPaths.length === 0 || !committedPaths.every((file) => ownedPathMatches(file, foundationOwnership))) {
                    throw new Error(`Bootstrap retry found committed changes outside authority ownership: ${committedPaths.join(", ")}`);
                  }
                }
                const dirty = execText("git", ["status", "--porcelain", "--untracked-files=no"], foundationRoot);
                const dirtyPaths = dirty === "" ? [] : dirty.split("\n").map((line) => line.slice(3).trim()).filter(Boolean);
                if (!dirtyPaths.every((file) => ownedPathMatches(file, foundationOwnership))) {
                  throw new Error(`Bootstrap retry found changes outside authority ownership: ${dirtyPaths.join(", ")}`);
                }
                commandReceipts.push({ command: "verify canonical worktree, branch, committed base tree, and retry ownership", classification: "pass", exitCode: 0, summary: "Verified the deterministic bootstrap mutates only the isolated authority-foundation checkout.", evidenceRef: foundationRoot });

                const packOutput = record(
                  await runBounded("node", [path.join(foundationRoot, ".smithers/lib/build-local-smithers-distribution.mjs"), pocDistributionRoot, "--smoke"], foundationRoot, 10 * 60_000),
                  pocDistributionRoot,
                );
                const packed = JSON.parse(packOutput) as { manifest?: Record<string, unknown>; smoke?: { imported?: string[] } | null };
                const parsedManifest = smithersDistributionManifest.safeParse(packed.manifest === undefined ? undefined : {
                  smithersSourceRoot: packed.manifest.smithersSourceRoot,
                  sourceRevisions: packed.manifest.sourceRevisions,
                  packages: packed.manifest.packages,
                });
                if (!parsedManifest.success) {
                  failureClassification = "product_failure";
                  throw new Error(`Local Smithers distribution manifest failed validation: ${parsedManifest.error.message}`);
                }
                distributionManifest = parsedManifest.data;
                const requiredPackages = ["@smithers/database", "@smithers/journal", "@smithers/harness", "@smithers/adapters", "@smithers/connectors"];
                const packageByName = new Map(distributionManifest.packages.map((entry) => [entry.name, entry]));
                const missingPackages = requiredPackages.filter((name) => !packageByName.has(name));
                const missingTarballs = distributionManifest.packages.filter((entry) => !existsSync(path.join(pocDistributionRoot, entry.filename))).map((entry) => entry.filename);
                assertions.localDistributionPacked = missingPackages.length === 0 && missingTarballs.length === 0;
                assertions.externalConsumerSmoke = requiredPackages.filter((name) => name !== "@smithers/database").every((name) => packed.smoke?.imported?.includes(name));
                assertions.exactSourceProvenance = distributionManifest.smithersSourceRoot === "/Users/williamcory/flows"
                  && distributionManifest.packages.every((entry) => entry.sourceRoot.startsWith("/Users/williamcory/flows/"));
                if (!assertions.localDistributionPacked || !assertions.externalConsumerSmoke || !assertions.exactSourceProvenance) {
                  failureClassification = "product_failure";
                  throw new Error(`Distribution proof failed; missing packages=${missingPackages.join(",")}; missing tarballs=${missingTarballs.join(",")}`);
                }

                const journalSourceManifest = JSON.parse(readFileSync("/Users/williamcory/flows/flows/packages/journal/package.json", "utf8")) as { dependencies?: Record<string, string> };
                effectVersion = journalSourceManifest.dependencies?.effect ?? null;
                if (effectVersion === null) throw new Error("The owning Journal package does not declare an Effect runtime version.");
                const installSpecs = requiredPackages.map((name) => path.join(pocDistributionRoot, packageByName.get(name)!.filename));
                record(
                  await runBounded("npm", ["install", "--ignore-scripts", "--save-exact", ...installSpecs, `effect@${effectVersion}`], foundationRoot, 15 * 60_000),
                  path.join(foundationRoot, "package.json"),
                );
                const bunLockPath = path.join(foundationRoot, "bun.lock");
                const npmLockPath = path.join(foundationRoot, "package-lock.json");
                if (!existsSync(npmLockPath)) throw new Error("npm install did not produce the package-lock.json migration source.");
                if (existsSync(bunLockPath)) rmSync(bunLockPath);
                commandReceipts.push({ command: "remove the Git-recoverable baseline bun.lock before migration", classification: "pass", exitCode: 0, summary: "Removed only the isolated authority worktree lockfile so Bun could import the complete npm-resolved local tarball graph.", evidenceRef: bunLockPath });
                record(
                  await runBounded("bun", ["pm", "migrate"], foundationRoot, 2 * 60_000),
                  bunLockPath,
                );
                assertions.bunLockfileMigrated = existsSync(bunLockPath);
                rmSync(npmLockPath);
                commandReceipts.push({ command: "remove package-lock.json after bun pm migrate", classification: "pass", exitCode: 0, summary: "Kept bun.lock as the sole product lockfile after deterministic migration.", evidenceRef: bunLockPath });
                record(
                  await runBounded("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], foundationRoot, 10 * 60_000),
                  bunLockPath,
                );
                assertions.frozenLockfileInstall = existsSync(bunLockPath) && !existsSync(npmLockPath);
                const productManifest = JSON.parse(readFileSync(path.join(foundationRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
                assertions.journalHarnessAdaptersConnectorsInstalled = requiredPackages.every((name) => typeof productManifest.dependencies?.[name] === "string" && existsSync(path.join(foundationRoot, "node_modules", name)));
                assertions.effectRuntimeInstalled = productManifest.dependencies?.effect === effectVersion && existsSync(path.join(foundationRoot, "node_modules", "effect"));
                measuredFootprint = measureDependencyTree(path.join(foundationRoot, "node_modules"));
                assertions.dependencyFootprintMeasured = measuredFootprint.installedBytes > 0 && measuredFootprint.installedFiles > 0;
                assertions.packageManifestWritesSerialized = true;
                if (!allTrue(assertions)) {
                  failureClassification = "product_failure";
                  throw new Error("One or more deterministic dependency bootstrap assertions failed.");
                }
              } catch (error) {
                failure = error instanceof Error ? error.message : String(error);
              }
              const passed = failure === null && distributionManifest !== null && effectVersion !== null && measuredFootprint !== null && allTrue(assertions);
              return {
                summary: passed ? "Packed, externally imported, installed, locked, and measured the real new-Smithers authority closure before agent execution." : "The deterministic authority dependency bootstrap failed before implementation agents were scheduled.",
                status: passed ? "pass" as const : failureClassification,
                evidenceRefs: refs([foundationRoot, pocDistributionRoot, path.join(foundationRoot, "package.json"), path.join(foundationRoot, "bun.lock")], commandReceipts.map((command) => command.evidenceRef)),
                blockers: passed ? [] : [failure ?? "Unknown deterministic bootstrap failure."],
                commands: commandReceipts,
                branch: pocBranches.authorityFoundation,
                executionCwd: foundationRoot,
                baseRevision: plan.baseRevision,
                distributionRoot: pocDistributionRoot,
                distributionManifest,
                effectVersion,
                dependencyFootprint: measuredFootprint,
                assertions,
              };
            }}</Task>
            {pocFoundationBootstrapReceipt === undefined ? null : pocFoundationBootstrapReady ? <Worktree id="poc-authority-foundation-worktree" path={pocWorktreePath("poc-authority-foundation")} branch={pocBranches.authorityFoundation} baseBranch={baselineBranch}>
              <Task id="poc_authority_foundation" output={outputs.poc_authority_foundation} agent={agents.opus} retries={1} timeoutMs={40 * 60_000} dependsOn={["prepare_poc_foundation_dependencies"]} needs={{ plan: "poc_round_plan", preparation: "prepare_poc_worktrees", bootstrap: "prepare_poc_foundation_dependencies" }} deps={{ plan: outputs.poc_round_plan, preparation: outputs.prepare_poc_worktrees, bootstrap: outputs.prepare_poc_foundation_dependencies }}>
                {(deps: PromptDeps) => <PocAuthorityFoundationPrompt context={receiptContext({ pocRoundPlan: deps.plan, worktreePreparation: deps.preparation, foundationDependencyBootstrap: deps.bootstrap, branch: pocBranches.authorityFoundation, worktreePath: pocWorktreePath("poc-authority-foundation"), distributionRoot: pocDistributionRoot })} />}
              </Task>
            </Worktree> : <Task id="poc_authority_foundation" output={outputs.poc_authority_foundation} dependsOn={["prepare_poc_foundation_dependencies"]} needs={{ bootstrap: "prepare_poc_foundation_dependencies", plan: "poc_round_plan" }} deps={{ bootstrap: outputs.prepare_poc_foundation_dependencies, plan: outputs.poc_round_plan }}>{(deps: PromptDeps) => {
              const bootstrap = deps.bootstrap as z.infer<typeof pocFoundationBootstrap>;
              const plan = deps.plan as z.infer<typeof pocRoundPlan>;
              return {
                summary: "Skipped authority implementation because deterministic dependency preparation did not pass.",
                status: bootstrap.status === "product_failure" ? "product_failure" as const : "environment_failure" as const,
                evidenceRefs: bootstrap.evidenceRefs,
                blockers: bootstrap.blockers,
                commands: bootstrap.commands,
                lane: "authority-foundation" as const,
                hypothesisVerdict: "inconclusive" as const,
                branch: bootstrap.branch,
                executionCwd: bootstrap.executionCwd,
                baseRevision: plan.baseRevision,
                commitSha: null,
                changedFiles: [],
                distributionRoot: bootstrap.distributionRoot,
                distributionManifest: bootstrap.distributionManifest,
                dependencyFootprint: bootstrap.dependencyFootprint,
                assertions: {
                  localDistributionPacked: bootstrap.assertions.localDistributionPacked,
                  externalConsumerSmoke: bootstrap.assertions.externalConsumerSmoke,
                  exactSourceProvenance: bootstrap.assertions.exactSourceProvenance,
                  journalHarnessAdaptersConnectorsInstalled: bootstrap.assertions.journalHarnessAdaptersConnectorsInstalled && bootstrap.assertions.effectRuntimeInstalled,
                  authorityCompositionRoot: false,
                  hostRuntimePlacement: false,
                  rendererRuntimeIsolation: false,
                  dependencyFootprintMeasured: bootstrap.assertions.dependencyFootprintMeasured,
                  packageManifestWritesSerialized: bootstrap.assertions.packageManifestWritesSerialized,
                  noLocalSmithersReimplementation: false,
                  focusedBoundaryTests: false,
                },
              };
            }}</Task>}
            <Task id="prepare_poc_round_base" output={outputs.prepare_poc_round_base} retries={1} dependsOn={["poc_authority_foundation", "poc_round_plan"]} needs={{ foundation: "poc_authority_foundation", plan: "poc_round_plan" }} deps={{ foundation: outputs.poc_authority_foundation, plan: outputs.poc_round_plan }}>{(deps: PromptDeps) => {
              const foundation = deps.foundation as z.infer<typeof pocAuthorityFoundation>;
              const plan = deps.plan as z.infer<typeof pocRoundPlan>;
              const foundationOwnership = plan.laneOwnership.find((lane) => lane.lane === "authority-foundation")?.ownedPaths ?? [];
              const expectedFoundationCwd = pocWorktreePath("poc-authority-foundation");
              let revisionValid = false;
              let actualChangedFiles: string[] = [];
              if (foundation.commitSha !== null) {
                try {
                  const branchHead = execText("git", ["rev-parse", pocBranches.authorityFoundation], targetRepo);
                  const parentRevision = execText("git", ["rev-parse", `${foundation.commitSha}^`], targetRepo);
                  const changed = execText("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", foundation.commitSha], targetRepo);
                  actualChangedFiles = changed === "" ? [] : changed.split("\n");
                  execText("git", ["diff", "--quiet", plan.baseRevision, parentRevision, "--", "."], targetRepo);
                  revisionValid = branchHead === foundation.commitSha;
                } catch {
                  revisionValid = false;
                }
              }
              const receiptValid = authorityFoundationReadyForFanout(foundation)
                && foundation.branch === pocBranches.authorityFoundation
                && foundation.executionCwd === expectedFoundationCwd
                && foundation.baseRevision === plan.baseRevision
                && foundation.commitSha !== null
                && foundation.commitSha !== plan.baseRevision
                && foundation.distributionRoot === pocDistributionRoot
                && foundation.distributionManifest !== null
                && foundation.dependencyFootprint !== null
                && foundation.changedFiles.length > 0
                && actualChangedFiles.length > 0
                && foundation.changedFiles.slice().sort().join("\n") === actualChangedFiles.slice().sort().join("\n")
                && actualChangedFiles.every((file) => ownedPathMatches(file, foundationOwnership))
                && revisionValid;
              const roundSpecs = activeRound.specs.filter((spec) => spec.branch !== pocBranches.authorityFoundation);
              const baseRevision = receiptValid ? foundation.commitSha! : plan.baseRevision;
              const preparation = receiptValid
                ? resetGitWorktrees(baseRevision, roundSpecs)
                : {
                    prepared: roundSpecs.map((spec) => ({ ...spec, headRevision: execText("git", ["rev-parse", "HEAD"], spec.path) })),
                    commands: [] as z.infer<typeof commandResult>[],
                  };
              const dependencyCloneCommands = receiptValid
                ? cloneFoundationDependencies(expectedFoundationCwd, roundSpecs.filter((spec) => spec.branch !== pocIntegrationBranch))
                : [];
              const metrics = measureBaseline(targetRepo, baseRevision);
              return {
                summary: receiptValid ? "Advanced every domain and integration worktree to the verified serial authority foundation." : "Did not advance the POC fan-out because the authority foundation receipt failed deterministic validation.",
                status: receiptValid ? "pass" as const : "product_failure" as const,
                evidenceRefs: refs(foundation.evidenceRefs, [expectedFoundationCwd, ...preparation.prepared.map((item) => item.path)]),
                blockers: receiptValid ? [] : ["Authority foundation must be a proven, single-parent, ownership-clean commit with every typed assertion true."],
                commands: [
                  { command: "verify foundation receipt, branch head, parent revision, changed files, and typed assertions", classification: receiptValid ? "pass" as const : "product_failure" as const, exitCode: receiptValid ? 0 : 1, summary: receiptValid ? "Verified the serial authority foundation commit." : "Foundation verification failed; disposable lanes remain at their prior base.", evidenceRef: expectedFoundationCwd },
                  ...preparation.commands,
                  ...dependencyCloneCommands,
                ],
                baseRevision,
                baseRef: pocBranches.authorityFoundation,
                metrics,
                worktrees: preparation.prepared,
              };
            }}</Task>
            {pocRoundBasePreparation === undefined ? null : pocRoundBaseReady ? <Parallel id="poc-fleet" maxConcurrency={4} subtreeConcurrency={4}>
              <Worktree id="poc-state-worktree" path={pocWorktreePath("poc-state-journal")} branch={pocBranches.stateJournal} baseBranch={pocBranches.authorityFoundation}><Task id="poc_state_journal" output={outputs.poc_state_journal} agent={providers.codexLuna} retries={1} timeoutMs={20 * 60_000} dependsOn={["prepare_poc_round_base"]} needs={{ plan: "poc_round_plan", foundation: "poc_authority_foundation", preparation: "prepare_poc_round_base" }} deps={{ plan: outputs.poc_round_plan, foundation: outputs.poc_authority_foundation, preparation: outputs.prepare_poc_round_base }}>{(deps: PromptDeps) => <PocStateJournalPrompt targetRepo={targetRepo} context={receiptContext({ pocRoundPlan: deps.plan, authorityFoundation: deps.foundation, roundBasePreparation: deps.preparation, branch: pocBranches.stateJournal, worktreePath: pocWorktreePath("poc-state-journal") })} />}</Task></Worktree>
              <Worktree id="poc-flows-worktree" path={pocWorktreePath("poc-flows-harness")} branch={pocBranches.flowsHarness} baseBranch={pocBranches.authorityFoundation}><Task id="poc_flows_harness" output={outputs.poc_flows_harness} agent={providers.codexLuna} retries={1} timeoutMs={20 * 60_000} dependsOn={["prepare_poc_round_base"]} needs={{ plan: "poc_round_plan", foundation: "poc_authority_foundation", preparation: "prepare_poc_round_base" }} deps={{ plan: outputs.poc_round_plan, foundation: outputs.poc_authority_foundation, preparation: outputs.prepare_poc_round_base }}>{(deps: PromptDeps) => <PocFlowsHarnessPrompt targetRepo={targetRepo} context={receiptContext({ pocRoundPlan: deps.plan, authorityFoundation: deps.foundation, roundBasePreparation: deps.preparation, branch: pocBranches.flowsHarness, worktreePath: pocWorktreePath("poc-flows-harness") })} />}</Task></Worktree>
              <Worktree id="poc-platform-worktree" path={pocWorktreePath("poc-platform-worldview")} branch={pocBranches.platformWorldview} baseBranch={pocBranches.authorityFoundation}><Task id="poc_platform_worldview" output={outputs.poc_platform_worldview} agent={providers.codexLuna} retries={1} timeoutMs={20 * 60_000} dependsOn={["prepare_poc_round_base"]} needs={{ plan: "poc_round_plan", foundation: "poc_authority_foundation", preparation: "prepare_poc_round_base" }} deps={{ plan: outputs.poc_round_plan, foundation: outputs.poc_authority_foundation, preparation: outputs.prepare_poc_round_base }}>{(deps: PromptDeps) => <PocPlatformWorldviewPrompt targetRepo={targetRepo} context={receiptContext({ pocRoundPlan: deps.plan, authorityFoundation: deps.foundation, roundBasePreparation: deps.preparation, branch: pocBranches.platformWorldview, worktreePath: pocWorktreePath("poc-platform-worldview") })} />}</Task></Worktree>
              <Worktree id="poc-transcript-worktree" path={pocWorktreePath("poc-transcript-chat-ui")} branch={pocBranches.transcriptChatUi} baseBranch={pocBranches.authorityFoundation}><Task id="poc_transcript_chat_ui" output={outputs.poc_transcript_chat_ui} agent={providers.codexLuna} retries={1} timeoutMs={20 * 60_000} dependsOn={["prepare_poc_round_base"]} needs={{ plan: "poc_round_plan", foundation: "poc_authority_foundation", preparation: "prepare_poc_round_base" }} deps={{ plan: outputs.poc_round_plan, foundation: outputs.poc_authority_foundation, preparation: outputs.prepare_poc_round_base }}>{(deps: PromptDeps) => <PocTranscriptChatUiPrompt targetRepo={targetRepo} context={receiptContext({ pocRoundPlan: deps.plan, authorityFoundation: deps.foundation, roundBasePreparation: deps.preparation, branch: pocBranches.transcriptChatUi, worktreePath: pocWorktreePath("poc-transcript-chat-ui") })} />}</Task></Worktree>
            </Parallel> : <Parallel id="poc-fleet-precondition-receipts" maxConcurrency={4} subtreeConcurrency={4}>
              <Task id="poc_state_journal" output={outputs.poc_state_journal} dependsOn={["prepare_poc_round_base"]} needs={{ preparation: "prepare_poc_round_base" }} deps={{ preparation: outputs.prepare_poc_round_base }}>{(deps: PromptDeps) => ({ ...skippedLaneBase("state-journal", pocBranches.stateJournal, pocWorktreePath("poc-state-journal"), deps.preparation as z.infer<typeof worktreePreparation>), assertions: { sqliteBackedCollections: false, tanstackDbAuthority: false, actorRecordedFlux: false, atomicJournal: false, framePersistence: false, newSmithersJournalResolved: false, journalTransactBoundaryExercised: false, noLocalJournalReimplementation: false } })}</Task>
              <Task id="poc_flows_harness" output={outputs.poc_flows_harness} dependsOn={["prepare_poc_round_base"]} needs={{ preparation: "prepare_poc_round_base" }} deps={{ preparation: outputs.prepare_poc_round_base }}>{(deps: PromptDeps) => ({ ...skippedLaneBase("flows-harness", pocBranches.flowsHarness, pocWorktreePath("poc-flows-harness"), deps.preparation as z.infer<typeof worktreePreparation>), assertions: { oneFlowRegistry: false, slashCtxCallButtonParity: false, harnessCellExecutesSmithersScripts: false, recursiveNativeSubagents: false, durableFrameNavigation: false, newSmithersPackagesResolved: false, noLocalSmithersReimplementation: false } })}</Task>
              <Task id="poc_platform_worldview" output={outputs.poc_platform_worldview} dependsOn={["prepare_poc_round_base"]} needs={{ preparation: "prepare_poc_round_base" }} deps={{ preparation: outputs.prepare_poc_round_base }}>{(deps: PromptDeps) => ({ ...skippedLaneBase("platform-worldview", pocBranches.platformWorldview, pocWorktreePath("poc-platform-worldview"), deps.preparation as z.infer<typeof worktreePreparation>), assertions: { connectors: false, externalAdapters: false, workspaceBranchRevision: false, worldviewMemoryProvenance: false, freshVersionedContextSnapshots: false, newSmithersConnectorPackagesResolved: false, noLocalConnectorRuntimeReimplementation: false } })}</Task>
              <Task id="poc_transcript_chat_ui" output={outputs.poc_transcript_chat_ui} dependsOn={["prepare_poc_round_base"]} needs={{ preparation: "prepare_poc_round_base" }} deps={{ preparation: outputs.prepare_poc_round_base }}>{(deps: PromptDeps) => ({ ...skippedLaneBase("transcript-chat-ui", pocBranches.transcriptChatUi, pocWorktreePath("poc-transcript-chat-ui"), deps.preparation as z.infer<typeof worktreePreparation>), assertions: { rendererNeutralTranscript: false, brainlessClaudeCodexRenderers: false, noAgentTabs: false, embeddedAndMaximizedSameComponent: false, persistentComposer: false, accessibleVisualFixtures: false } })}</Task>
            </Parallel>}
            <Worktree id="poc-integration-worktree" path={pocWorktreePath("poc-integration")} branch={pocIntegrationBranch} baseBranch={pocBranches.authorityFoundation}>
              {pocRoundBaseReady ? <MergeQueue maxConcurrency={1}><Task id="poc_integrate_verify" output={outputs.poc_integrate_verify} agent={providers.codexSol} retries={1} dependsOn={["poc_state_journal", "poc_flows_harness", "poc_platform_worldview", "poc_transcript_chat_ui", "prepare_poc_round_base"]} needs={{ state: "poc_state_journal", flows: "poc_flows_harness", platform: "poc_platform_worldview", transcript: "poc_transcript_chat_ui", foundation: "poc_authority_foundation", preparation: "prepare_poc_round_base" }} deps={{ state: outputs.poc_state_journal, flows: outputs.poc_flows_harness, platform: outputs.poc_platform_worldview, transcript: outputs.poc_transcript_chat_ui, foundation: outputs.poc_authority_foundation, preparation: outputs.prepare_poc_round_base }}>
                {(deps: PromptDeps) => <PocIntegrateVerifyPrompt targetRepo={targetRepo} acceptance={acceptanceContract} context={receiptContext({ authorityFoundation: deps.foundation, stateJournalLane: deps.state, flowsHarnessLane: deps.flows, platformWorldviewLane: deps.platform, transcriptChatUiLane: deps.transcript, roundBasePreparation: deps.preparation, laneBranches: pocBranches, integrationBranch: pocIntegrationBranch, worktreePath: pocWorktreePath("poc-integration") })} />}
              </Task></MergeQueue> : <Task id="poc_integrate_verify" output={outputs.poc_integrate_verify} dependsOn={["poc_state_journal", "poc_flows_harness", "poc_platform_worldview", "poc_transcript_chat_ui", "prepare_poc_round_base"]} needs={{ preparation: "prepare_poc_round_base" }} deps={{ preparation: outputs.prepare_poc_round_base }}>{(deps: PromptDeps) => {
                const preparation = deps.preparation as z.infer<typeof worktreePreparation>;
                return { summary: "Skipped serial integration because the authority foundation did not produce a verified round base.", status: "environment_failure" as const, evidenceRefs: preparation.evidenceRefs, blockers: ["Integration requires prepare_poc_round_base.status to be pass."], commands: [], foundationCommit: null, allLaneReceiptsPresent: true, integratedLaneCommits: [], candidateBranch: pocIntegrationBranch, executionCwd: pocWorktreePath("poc-integration"), integrationCommit: null, parallelLanesManifestClean: false, legacyDependenciesRemoved: false, dependencyManifestFinalized: false, lockfileRegenerated: false, assertions: [{ name: "verified serial authority foundation", passed: false, evidenceRefs: preparation.evidenceRefs }], dependencyBoundary: { newSmithersRoot: "/Users/williamcory/flows" as const, allowedProductNamespace: "@smithers/*" as const, forbiddenNamespaces: ["@smthrs/*" as const], forbiddenRoots: ["/Users/williamcory/smithers" as const], violations: ["Dependency boundary was not evaluated because the authority-foundation precondition failed."] } };
              }}</Task>}
              {pocRoundBaseReady ? <Task id="poc_failure_route" output={outputs.poc_failure_route} agent={providers.codexSol} dependsOn={["poc_integrate_verify"]} needs={{ integration: "poc_integrate_verify" }} deps={{ integration: outputs.poc_integrate_verify }}>
                {(deps: PromptDeps) => <PocFailureRoutePrompt context={receiptContext({ pocIntegration: deps.integration, integrationBranch: pocIntegrationBranch })} />}
              </Task> : <Task id="poc_failure_route" output={outputs.poc_failure_route} dependsOn={["poc_integrate_verify"]} needs={{ integration: "poc_integrate_verify" }} deps={{ integration: outputs.poc_integrate_verify }}>{(deps: PromptDeps) => ({ summary: "Routed the failed authority-foundation precondition directly to a fresh prototype round.", status: "pass" as const, evidenceRefs: (deps.integration as z.infer<typeof pocIntegrateVerify>).evidenceRefs, blockers: [], commands: [], phase: "poc" as const, failureSignature: "authority-foundation-precondition", shouldRetry: true, nextAction: "build_or_repair_harness" as const })}</Task>}
              <Task id="architecture_learn" output={outputs.architecture_learn} agent={providers.codexSol} dependsOn={["poc_integrate_verify", "poc_failure_route", "inventory_research", "inventory_synthesis"]} needs={{ foundation: "poc_authority_foundation", roundBase: "prepare_poc_round_base", integration: "poc_integrate_verify", failure: "poc_failure_route", research: "inventory_research", synthesis: "inventory_synthesis" }} deps={{ foundation: outputs.poc_authority_foundation, roundBase: outputs.prepare_poc_round_base, integration: outputs.poc_integrate_verify, failure: outputs.poc_failure_route, research: outputs.inventory_research, synthesis: outputs.inventory_synthesis }}>
                {(deps: PromptDeps) => <ArchitectureLearnPrompt architectureSitePath={architectureSitePath} acceptance={acceptanceContract} context={receiptContext({ authorityFoundation: deps.foundation, roundBasePreparation: deps.roundBase, pocIntegration: deps.integration, pocFailureRoute: deps.failure, referenceResearch: deps.research, referenceSynthesis: deps.synthesis, integrationBranch: pocIntegrationBranch })} />}
              </Task>
              <Task id="poc_gate" output={outputs.poc_gate} dependsOn={["poc_integrate_verify", "poc_failure_route", "architecture_learn"]}>{() => {
                const plannedOwnership = new Map((pocRoundPlanReceipt?.laneOwnership ?? []).map((lane) => [lane.lane, lane.ownedPaths]));
                const foundationPassed = pocFoundationReceipt !== undefined
                  && authorityFoundationReadyForFanout(pocFoundationReceipt)
                  && pocFoundationReceipt.commitSha !== null
                  && pocFoundationReceipt.commitSha !== pocRoundPlanReceipt?.baseRevision
                  && pocFoundationReceipt.branch === pocBranches.authorityFoundation
                  && pocFoundationReceipt.executionCwd === pocWorktreePath("poc-authority-foundation")
                  && pocFoundationReceipt.changedFiles.length > 0
                  && pocFoundationReceipt.changedFiles.every((file) => ownedPathMatches(file, plannedOwnership.get("authority-foundation") ?? []))
                  && pocRoundBasePreparation?.status === "pass"
                  && pocRoundBasePreparation.baseRevision === pocFoundationReceipt.commitSha;
                const laneReceipts = [pocStateReceipt, pocFlowsReceipt, pocPlatformReceipt, pocTranscriptReceipt];
                const expectedBranches = [pocBranches.stateJournal, pocBranches.flowsHarness, pocBranches.platformWorldview, pocBranches.transcriptChatUi];
                const expectedCwds = [pocWorktreePath("poc-state-journal"), pocWorktreePath("poc-flows-harness"), pocWorktreePath("poc-platform-worldview"), pocWorktreePath("poc-transcript-chat-ui")];
                const laneReceiptsPassed = laneReceipts.every((lane, index) => lane !== undefined
                  && lane.status === "pass"
                  && lane.hypothesisVerdict === "proven"
                  && lane.commitSha !== null
                  && lane.commitSha !== pocRoundBasePreparation?.baseRevision
                  && lane.branch === expectedBranches[index]
                  && lane.executionCwd === expectedCwds[index]
                  && lane.changedFiles.length > 0
                  && lane.changedFiles.every((file) => ownedPathMatches(file, plannedOwnership.get(lane.lane) ?? []))
                  && allTrue(lane.assertions));
                const integrationPassed = foundationPassed && laneReceiptsPassed && pocIntegration?.status === "pass" && pocIntegration.executionCwd === pocWorktreePath("poc-integration") && pocIntegration.candidateBranch === pocIntegrationBranch && pocIntegration.foundationCommit?.sha === pocFoundationReceipt?.commitSha && pocIntegration.allLaneReceiptsPresent && pocIntegration.integratedLaneCommits.length === 4 && pocIntegration.integrationCommit !== null && pocIntegration.parallelLanesManifestClean && pocIntegration.legacyDependenciesRemoved && pocIntegration.dependencyManifestFinalized && pocIntegration.lockfileRegenerated && pocIntegration.dependencyBoundary.violations.length === 0;
                const architecturePassed = pocArchitecture?.status === "pass" && pocArchitecture.sitePath === expectedPocArchitectureSitePath && pocArchitecture.architectureScore >= 85 && pocArchitecture.fileTreeDocumented && pocArchitecture.pseudocodeDocumented && pocArchitecture.referenceComparisonDocumented;
                const routePassed = pocFailure?.status === "pass" && pocFailure.nextAction === "proceed" && !pocFailure.shouldRetry;
                const passed = integrationPassed && architecturePassed && routePassed;
                return { summary: passed ? "POC evidence converged." : "POC evidence requires another falsifiable round.", status: passed ? "pass" as const : (pocFailure?.status ?? pocIntegration?.status ?? "blocked"), passed, evidenceRefs: refs(pocFoundationReceipt?.evidenceRefs, pocRoundBasePreparation?.evidenceRefs, pocIntegration?.evidenceRefs, pocArchitecture?.evidenceRefs, pocFailure?.evidenceRefs), blockers: blockers(pocFoundationReceipt?.blockers, pocRoundBasePreparation?.blockers, pocIntegration?.blockers, pocArchitecture?.blockers, pocFailure?.blockers, foundationPassed ? [] : ["The serial authority foundation was not proven, ownership-clean, or inherited as the exact round base."], laneReceiptsPassed ? [] : ["One or more domain lane receipts were not proven, branch-pinned, ownership-clean, or fully asserted."], passed ? [] : ["POC convergence checks did not all pass."]), checks: [{ name: "serial real-Smithers authority foundation and exact inherited round base", passed: foundationPassed, evidenceRefs: refs(pocFoundationReceipt?.evidenceRefs, pocRoundBasePreparation?.evidenceRefs) }, { name: "four proven, branch-pinned, ownership-clean domain lane receipts", passed: laneReceiptsPassed, evidenceRefs: refs(...laneReceipts.map((lane) => lane?.evidenceRefs)) }, { name: "foundation plus four integrated domain receipts and new-Smithers boundary", passed: integrationPassed, evidenceRefs: pocIntegration?.evidenceRefs ?? [] }, { name: "architecture score, file tree, and pseudocode", passed: architecturePassed, evidenceRefs: pocArchitecture?.evidenceRefs ?? [] }, { name: "typed failure route permits progression", passed: routePassed, evidenceRefs: pocFailure?.evidenceRefs ?? [] }] };
              }}</Task>
            </Worktree>
            </Sequence>}
          </Sequence>
        </Ralph>

        {pocConverged ? <Sequence>
          <Parallel id="production-domain-planning" maxConcurrency={maxConcurrency}>
            <Task id="production_plan_state_journal" output={outputs.production_plan_state_journal} agent={agents.opus} dependsOn={["poc_gate", "poc_integrate_verify", "architecture_learn"]} needs={{ gate: "poc_gate", integration: "poc_integrate_verify", architecture: "architecture_learn" }} deps={{ gate: outputs.poc_gate, integration: outputs.poc_integrate_verify, architecture: outputs.architecture_learn }}>
              {(deps: PromptDeps) => <ProductionPlanStateJournalPrompt acceptance={acceptanceContract} context={receiptContext({ pocGate: deps.gate, pocIntegration: deps.integration, architectureLearning: deps.architecture, productionBaseBookmark: pocIntegrationBranch, candidateBranch })} />}
            </Task>
            <Task id="production_plan_flows_harness" output={outputs.production_plan_flows_harness} agent={agents.opus} dependsOn={["poc_gate", "poc_integrate_verify", "architecture_learn"]} needs={{ gate: "poc_gate", integration: "poc_integrate_verify", architecture: "architecture_learn" }} deps={{ gate: outputs.poc_gate, integration: outputs.poc_integrate_verify, architecture: outputs.architecture_learn }}>
              {(deps: PromptDeps) => <ProductionPlanFlowsHarnessPrompt acceptance={acceptanceContract} context={receiptContext({ pocGate: deps.gate, pocIntegration: deps.integration, architectureLearning: deps.architecture, productionBaseBookmark: pocIntegrationBranch, candidateBranch })} />}
            </Task>
            <Task id="production_plan_transcript_ui" output={outputs.production_plan_transcript_ui} agent={agents.opus} dependsOn={["poc_gate", "poc_integrate_verify", "architecture_learn"]} needs={{ gate: "poc_gate", integration: "poc_integrate_verify", architecture: "architecture_learn" }} deps={{ gate: outputs.poc_gate, integration: outputs.poc_integrate_verify, architecture: outputs.architecture_learn }}>
              {(deps: PromptDeps) => <ProductionPlanTranscriptUiPrompt acceptance={acceptanceContract} context={receiptContext({ pocGate: deps.gate, pocIntegration: deps.integration, architectureLearning: deps.architecture, productionBaseBookmark: pocIntegrationBranch, candidateBranch })} />}
            </Task>
            <Task id="production_plan_platform_security" output={outputs.production_plan_platform_security} agent={agents.opus} dependsOn={["poc_gate", "poc_integrate_verify", "architecture_learn"]} needs={{ gate: "poc_gate", integration: "poc_integrate_verify", architecture: "architecture_learn" }} deps={{ gate: outputs.poc_gate, integration: outputs.poc_integrate_verify, architecture: outputs.architecture_learn }}>
              {(deps: PromptDeps) => <ProductionPlanPlatformSecurityPrompt acceptance={acceptanceContract} context={receiptContext({ pocGate: deps.gate, pocIntegration: deps.integration, architectureLearning: deps.architecture, productionBaseBookmark: pocIntegrationBranch, candidateBranch })} />}
            </Task>
          </Parallel>
          <Task id="production_supervisor_plan" output={outputs.production_supervisor_plan} agent={agents.opus} dependsOn={["production_plan_state_journal", "production_plan_flows_harness", "production_plan_transcript_ui", "production_plan_platform_security"]} needs={{ state: "production_plan_state_journal", flows: "production_plan_flows_harness", transcript: "production_plan_transcript_ui", platform: "production_plan_platform_security" }} deps={{ state: outputs.production_plan_state_journal, flows: outputs.production_plan_flows_harness, transcript: outputs.production_plan_transcript_ui, platform: outputs.production_plan_platform_security }}>
            {(deps: PromptDeps) => <ProductionSupervisorPlanPrompt acceptance={acceptanceContract} context={receiptContext({ stateJournalPlan: deps.state, flowsHarnessPlan: deps.flows, transcriptUiPlan: deps.transcript, platformSecurityPlan: deps.platform, productionBaseBookmark: pocIntegrationBranch, candidateBranch })} />}
          </Task>
          <Ralph id="production-ratchet" maxIterations={maxProductionRounds} onMaxReached="return-last" until={productionConverged}>
            <Sequence>
              <Task id="production_wave_plan" output={outputs.production_wave_plan} agent={agents.opus} dependsOn={["production_supervisor_plan"]} needs={{ supervisor: "production_supervisor_plan" }} deps={{ supervisor: outputs.production_supervisor_plan }}>
                {(deps: PromptDeps) => <ProductionWavePlanPrompt context={receiptContext({ supervisorPlan: deps.supervisor, priorProductionGate: productionGateReceipt, priorMerge: productionMerge, priorE2e: productionE2e, priorFailureRoute: productionFailure, productionBaseBookmark: pocIntegrationBranch, candidateBranch })} />}
              </Task>
              {sliceDescriptors.length > 0 ? <Task id="prepare_production_worktrees" output={outputs.prepare_production_worktrees} retries={1} dependsOn={["production_wave_plan", "poc_integrate_verify"]} needs={{ wave: "production_wave_plan", integration: "poc_integrate_verify" }} deps={{ wave: outputs.production_wave_plan, integration: outputs.poc_integrate_verify }}>{() => {
                const specs: GitWorktreeSpec[] = [
                  ...sliceDescriptors.map((slice) => ({ path: slice.worktreePath, branch: slice.branch })),
                  { path: path.join(worktreeRoot, "production-candidate"), branch: candidateBranch },
                ];
                const baseRevision = execText("git", ["rev-parse", pocIntegrationBranch], targetRepo);
                const metrics = measureBaseline(targetRepo, baseRevision);
                const preparation = prepareGitWorktrees(targetRepo, pocIntegrationBranch, specs);
                const integrationRoot = pocWorktreePath("poc-integration");
                const dependencyTargets = specs.filter((spec) => !existsSync(path.join(spec.path, "node_modules")));
                const dependencyCloneCommands = dependencyTargets.length > 0
                  ? cloneFoundationDependencies(integrationRoot, dependencyTargets)
                  : [];
                return {
                  summary: "Prepared the candidate and current production-wave checkouts with copy-on-write reuse of the verified integration dependency tree before Sol implementation scheduling.",
                  status: "pass" as const,
                  evidenceRefs: [targetRepo, integrationRoot, ...preparation.prepared.map((item) => item.path)],
                  blockers: [],
                  commands: [...preparation.commands, ...dependencyCloneCommands],
                  baseRevision,
                  baseRef: pocIntegrationBranch,
                  metrics,
                  worktrees: preparation.prepared,
                };
              }}</Task> : null}
              {sliceDescriptors.length > 0 ? <Parallel id="production-slice-wave" maxConcurrency={maxConcurrency} subtreeConcurrency={maxConcurrency}>
                {sliceDescriptors.map((slice) => <Worktree key={slice.taskId} id={slice.worktreeId} path={slice.worktreePath} branch={slice.branch} baseBranch={pocIntegrationBranch}>
                  <Task id={slice.taskId} output={outputs.production_slice_implement} agent={providers.codexSol} retries={1} dependsOn={["prepare_production_worktrees", "production_supervisor_plan"]} needs={{ preparation: "prepare_production_worktrees", wave: "production_wave_plan", supervisor: "production_supervisor_plan", state: "production_plan_state_journal", flows: "production_plan_flows_harness", transcript: "production_plan_transcript_ui", platform: "production_plan_platform_security" }} deps={{ preparation: outputs.prepare_production_worktrees, wave: outputs.production_wave_plan, supervisor: outputs.production_supervisor_plan, state: outputs.production_plan_state_journal, flows: outputs.production_plan_flows_harness, transcript: outputs.production_plan_transcript_ui, platform: outputs.production_plan_platform_security }}>
                    {(deps: PromptDeps) => <ProductionSliceImplementPrompt targetRepo={targetRepo} acceptance={acceptanceContract} context={receiptContext({ selectedSliceId: slice.sliceId, worktreePreparation: deps.preparation, wavePlan: deps.wave, supervisorPlan: deps.supervisor, domainPlans: { stateJournal: deps.state, flowsHarness: deps.flows, transcriptUi: deps.transcript, platformSecurity: deps.platform }, branch: slice.branch, baseBookmark: pocIntegrationBranch, candidateBranch })} />}
                  </Task>
                </Worktree>)}
              </Parallel> : null}
              {sliceDescriptors.length > 0 ? <Worktree id="production-candidate-worktree" path={path.join(worktreeRoot, "production-candidate")} branch={candidateBranch} baseBranch={pocIntegrationBranch}>
                <MergeQueue maxConcurrency={1}><Task id="production_merge" output={outputs.production_merge} agent={providers.codexSol} retries={1} dependsOn={sliceTaskIds} needs={{ preparation: "prepare_production_worktrees", ...mergeNeeds }} deps={{ preparation: outputs.prepare_production_worktrees, ...mergeDeps }}>
                  {(deps: PromptDeps) => <ProductionMergePrompt context={receiptContext({ worktreePreparation: deps.preparation, wavePlan: deps.wavePlan, implementationReceipts: Object.fromEntries(sliceDescriptors.map((slice) => [slice.taskId, deps[slice.taskId]])), sourceBranches: Object.fromEntries(sliceDescriptors.map((slice) => [slice.taskId, slice.branch])), targetBranch: candidateBranch, baseBookmark: pocIntegrationBranch })} />}
                </Task></MergeQueue>
                <Task id="production_e2e" output={outputs.production_e2e} agent={providers.codexSol} dependsOn={["production_merge"]} needs={{ merge: "production_merge" }} deps={{ merge: outputs.production_merge }}>
                  {(deps: PromptDeps) => <ProductionE2ePrompt acceptance={acceptanceContract} acceptanceCommands={ctx.input.acceptanceCommands} context={receiptContext({ productionMerge: deps.merge, candidateBranch, productionBaseBookmark: pocIntegrationBranch })} />}
                </Task>
                <Task id="production_failure_route" output={outputs.production_failure_route} agent={agents.opus} dependsOn={["production_merge", "production_e2e"]} needs={{ merge: "production_merge", e2e: "production_e2e" }} deps={{ merge: outputs.production_merge, e2e: outputs.production_e2e }}>
                  {(deps: PromptDeps) => <ProductionFailureRoutePrompt context={receiptContext({ productionMerge: deps.merge, productionE2e: deps.e2e, candidateBranch })} />}
                </Task>
                <Task id="production_gate" output={outputs.production_gate} dependsOn={["production_merge", "production_e2e", "production_failure_route"]}>{() => {
                  const mergePassed = productionMerge?.status === "pass" && productionMerge.integrated && !productionMerge.landedOnMain && !productionMerge.forcePushed;
                  const e2ePassed = productionE2e?.status === "pass" && allTrue(productionE2e.assertions) && productionE2e.dependencyBoundary.violations.length === 0;
                  const routePassed = productionFailure?.status === "pass" && productionFailure.nextAction === "proceed" && !productionFailure.shouldRetry;
                  const passed = mergePassed && e2ePassed && routePassed;
                  return { summary: passed ? "Production implementation and E2E evidence converged." : "Production evidence requires another correction wave.", status: passed ? "pass" as const : (productionFailure?.status ?? productionE2e?.status ?? "blocked"), passed, evidenceRefs: refs(productionMerge?.evidenceRefs, productionE2e?.evidenceRefs, productionFailure?.evidenceRefs), blockers: blockers(productionMerge?.blockers, productionE2e?.blockers, productionFailure?.blockers, passed ? [] : ["Production convergence checks did not all pass."]), checks: [{ name: "serial candidate integration without main landing or force-push", passed: mergePassed, evidenceRefs: productionMerge?.evidenceRefs ?? [] }, { name: "all production E2E and dependency-boundary assertions", passed: e2ePassed, evidenceRefs: productionE2e?.evidenceRefs ?? [] }, { name: "typed failure route permits progression", passed: routePassed, evidenceRefs: productionFailure?.evidenceRefs ?? [] }] };
                }}</Task>
              </Worktree> : null}
            </Sequence>
          </Ralph>

          {productionConverged ? <Worktree id="post-e2e-candidate-worktree" path={path.join(worktreeRoot, "production-candidate")} branch={candidateBranch} baseBranch={pocIntegrationBranch}><Sequence>
            <Parallel id="post-e2e-review" maxConcurrency={2}>
              <Task id="commit_review" output={outputs.commit_review} agent={agents.opus} dependsOn={["production_gate", "production_merge", "production_e2e"]} needs={{ gate: "production_gate", merge: "production_merge", e2e: "production_e2e" }} deps={{ gate: outputs.production_gate, merge: outputs.production_merge, e2e: outputs.production_e2e }}>
                {(deps: PromptDeps) => <CommitReviewPrompt context={receiptContext({ productionGate: deps.gate, productionMerge: deps.merge, productionE2e: deps.e2e, candidateBranch })} />}
              </Task>
              <Task id="stack_review" output={outputs.stack_review} agent={agents.opus} dependsOn={["production_gate", "production_merge", "production_e2e"]} needs={{ gate: "production_gate", merge: "production_merge", e2e: "production_e2e" }} deps={{ gate: outputs.production_gate, merge: outputs.production_merge, e2e: outputs.production_e2e }}>
                {(deps: PromptDeps) => <StackReviewPrompt acceptance={acceptanceContract} context={receiptContext({ productionGate: deps.gate, productionMerge: deps.merge, productionE2e: deps.e2e, domainPlans: { statePlan, flowsPlan, transcriptPlan, platformPlan }, candidateBranch })} />}
              </Task>
            </Parallel>
            {reviewCorrectionNeeded ? <Task id="review_correction" output={outputs.review_correction} agent={providers.codexSol} dependsOn={["commit_review", "stack_review"]} needs={{ commitReview: "commit_review", stackReview: "stack_review" }} deps={{ commitReview: outputs.commit_review, stackReview: outputs.stack_review }}>
              {(deps: PromptDeps) => <ReviewCorrectionPrompt context={receiptContext({ commitReview: deps.commitReview, stackReview: deps.stackReview, candidateBranch })} />}
            </Task> : null}
            {reviewCorrectionNeeded ? <Task id="review_e2e" output={outputs.review_e2e} agent={providers.codexSol} dependsOn={["review_correction"]} needs={{ correction: "review_correction", commitReview: "commit_review", stackReview: "stack_review", merge: "production_merge" }} deps={{ correction: outputs.review_correction, commitReview: outputs.commit_review, stackReview: outputs.stack_review, merge: outputs.production_merge }}>
              {(deps: PromptDeps) => <ReviewE2ePrompt acceptance={acceptanceContract} context={receiptContext({ reviewCorrection: deps.correction, commitReview: deps.commitReview, stackReview: deps.stackReview, productionMerge: deps.merge, candidateBranch })} />}
            </Task> : <Task id="review_e2e" output={outputs.review_e2e} agent={providers.codexSol} dependsOn={["commit_review", "stack_review"]} needs={{ commitReview: "commit_review", stackReview: "stack_review", merge: "production_merge" }} deps={{ commitReview: outputs.commit_review, stackReview: outputs.stack_review, merge: outputs.production_merge }}>
              {(deps: PromptDeps) => <ReviewE2ePrompt acceptance={acceptanceContract} context={receiptContext({ commitReview: deps.commitReview, stackReview: deps.stackReview, productionMerge: deps.merge, candidateBranch })} />}
            </Task>}
            <Task id="review_gate" output={outputs.review_gate} dependsOn={["commit_review", "stack_review", "review_e2e"]}>{() => {
              const reviewsPass = commitReview?.status === "pass" && commitReview.verdict === "pass" && stackReview?.status === "pass" && stackReview.verdict === "pass";
              const e2ePass = reviewE2e?.status === "pass" && allTrue(reviewE2e.assertions) && reviewE2e.dependencyBoundary.violations.length === 0;
              const passed = reviewsPass && e2ePass;
              return { summary: passed ? "Post-E2E reviews and correction verification passed." : "Post-E2E review gate is blocked by typed review or E2E evidence.", status: passed ? "pass" as const : (reviewE2e?.status ?? "blocked"), passed, evidenceRefs: refs(commitReview?.evidenceRefs, stackReview?.evidenceRefs, reviewE2e?.evidenceRefs), blockers: blockers(commitReview?.blockers, stackReview?.blockers, reviewE2e?.blockers, passed ? [] : ["Review convergence checks did not all pass."]), checks: [{ name: "commit and stack review verdicts", passed: reviewsPass, evidenceRefs: refs(commitReview?.evidenceRefs, stackReview?.evidenceRefs) }, { name: "post-review E2E and legacy boundary", passed: e2ePass, evidenceRefs: reviewE2e?.evidenceRefs ?? [] }] };
            }}</Task>

            {reviewPassed ? <Sequence>
              <Task id="final_scan" output={outputs.final_scan} agent={agents.opus} dependsOn={["review_gate", "review_e2e", "commit_review", "stack_review"]} needs={{ gate: "review_gate", e2e: "review_e2e", commitReview: "commit_review", stackReview: "stack_review" }} deps={{ gate: outputs.review_gate, e2e: outputs.review_e2e, commitReview: outputs.commit_review, stackReview: outputs.stack_review }}>
                {(deps: PromptDeps) => <FinalScanPrompt acceptance={acceptanceContract} context={receiptContext({ reviewGate: deps.gate, reviewE2e: deps.e2e, commitReview: deps.commitReview, stackReview: deps.stackReview, candidateBranch })} />}
              </Task>
              <Task id="final_fix" output={outputs.final_fix} agent={providers.codexSol} dependsOn={["final_scan"]} needs={{ scan: "final_scan" }} deps={{ scan: outputs.final_scan }}>
                {(deps: PromptDeps) => <FinalFixPrompt context={receiptContext({ finalScan: deps.scan, candidateBranch })} />}
              </Task>
              <Task id="final_architecture_update" output={outputs.final_architecture_update} agent={agents.opus} dependsOn={["final_scan", "final_fix", "review_e2e", "inventory_research", "inventory_synthesis", "architecture_learn"]} needs={{ scan: "final_scan", fix: "final_fix", e2e: "review_e2e", research: "inventory_research", synthesis: "inventory_synthesis", architecture: "architecture_learn" }} deps={{ scan: outputs.final_scan, fix: outputs.final_fix, e2e: outputs.review_e2e, research: outputs.inventory_research, synthesis: outputs.inventory_synthesis, architecture: outputs.architecture_learn }}>
                {(deps: PromptDeps) => <FinalArchitectureUpdatePrompt architectureSitePath={architectureSitePath} acceptance={acceptanceContract} context={receiptContext({ finalScan: deps.scan, finalFix: deps.fix, reviewE2e: deps.e2e, referenceResearch: deps.research, referenceSynthesis: deps.synthesis, priorArchitecture: deps.architecture, candidateBranch })} />}
              </Task>
              <MergeQueue maxConcurrency={1}><Task id="history_curate" output={outputs.history_curate} agent={providers.codexSol} dependsOn={["final_architecture_update"]} needs={{ architecture: "final_architecture_update", fix: "final_fix", gate: "review_gate" }} deps={{ architecture: outputs.final_architecture_update, fix: outputs.final_fix, gate: outputs.review_gate }}>
                {(deps: PromptDeps) => <HistoryCuratePrompt context={receiptContext({ finalArchitecture: deps.architecture, finalFix: deps.fix, reviewGate: deps.gate, targetBranch: candidateBranch, backupBookmark })} />}
              </Task></MergeQueue>
              <Task id="commit_series_verify" output={outputs.commit_series_verify} agent={agents.opus} dependsOn={["history_curate"]} needs={{ history: "history_curate" }} deps={{ history: outputs.history_curate }}>
                {(deps: PromptDeps) => <CommitSeriesVerifyPrompt context={receiptContext({ curatedHistory: deps.history, candidateBranch, backupBookmark })} />}
              </Task>
              <Task id="final_verify" output={outputs.final_verify} agent={agents.opus} dependsOn={["history_curate", "commit_series_verify", "final_architecture_update", "review_e2e"]} needs={{ history: "history_curate", commits: "commit_series_verify", architecture: "final_architecture_update", e2e: "review_e2e" }} deps={{ history: outputs.history_curate, commits: outputs.commit_series_verify, architecture: outputs.final_architecture_update, e2e: outputs.review_e2e }}>
                {(deps: PromptDeps) => <FinalVerifyPrompt acceptance={acceptanceContract} context={receiptContext({ curatedHistory: deps.history, commitVerification: deps.commits, finalArchitecture: deps.architecture, reviewE2e: deps.e2e, candidateBranch, backupBookmark })} />}
              </Task>
              <Task id="release_readiness" output={outputs.release_readiness} dependsOn={["final_verify"]}>{releaseVerdict}</Task>
            </Sequence> : reviewFailed ? <Task id="release_readiness" output={outputs.release_readiness} dependsOn={["review_gate"]}>{releaseVerdict}</Task> : null}
          </Sequence></Worktree> : productionExhausted ? <Task id="release_readiness" output={outputs.release_readiness}>{releaseVerdict}</Task> : null}
        </Sequence> : pocExhausted ? <Task id="release_readiness" output={outputs.release_readiness}>{releaseVerdict}</Task> : null}
      </Sequence>
    </Memory>
  </Workflow>;
});
