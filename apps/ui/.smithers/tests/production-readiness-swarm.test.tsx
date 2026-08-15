import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderWorkflow, runTask } from "smthrs/testing";
import { runBoundedProcess } from "../lib/run-bounded-process";
import workflow from "../workflows/production-readiness-swarm.tsx";

const workflowPath = join(import.meta.dir, "..", "workflows", "production-readiness-swarm.tsx");
const promptDir = join(import.meta.dir, "..", "prompts", "production-readiness-swarm");
const distributionBuilderPath = join(import.meta.dir, "..", "lib", "build-local-smithers-distribution.mjs");
const branchRoot = "smithers/production-readiness/test-run";
const baselineBranch = `${branchRoot}/baseline`;
const pocIntegrationBranch = `${branchRoot}/poc-integration`;
const pocWorktreeRoot = "/Users/williamcory/.smithers-worktrees/mvp/test-run";
const pocFoundationBranch = `${branchRoot}/poc-authority-foundation`;
const pocFoundationRevision = "5555555555555555555555555555555555555555";
const candidateBranch = `${branchRoot}/candidate`;
const backupBookmark = `${branchRoot}/backup`;
const referenceRepos = [
  "/Users/williamcory/flows/ui",
  "/Users/williamcory/multi",
  "/Users/williamcory/gui",
  "/Users/williamcory/flows",
  "/Users/williamcory/Smithers-Ops",
];
const workflowInput = {
  targetRepo: "/Users/williamcory/mvp",
  architectureSitePath: "docs/architecture",
  maxPrototypeRounds: 1,
  maxProductionRounds: 1,
  maxConcurrency: 4,
  acceptanceCommands: [],
  sourceRepos: referenceRepos,
};
const allAcceptanceAssertions = {
  sqliteTanstackDbAuthority: true,
  actorRecordedFluxAtomicJournal: true,
  journalTransactStorageOnly: true,
  externalEffectsUseActivitySafety: true,
  singleFlowRegistryInvocationParity: true,
  connectors: true,
  workspaceBranchRevision: true,
  harnessCellSmithersScripts: true,
  recursiveNativeSubagents: true,
  externalAgentAdapters: true,
  worldviewMemoryProvenance: true,
  rendererNeutralTranscript: true,
  brainlessClaudeRenderer: true,
  brainlessCodexRenderer: true,
  noAgentTabs: true,
  embeddedMiniApp: true,
  sameComponentMaximized: true,
  persistentComposerChrome: true,
  durableUrlFrameGraph: true,
  browserBackForward: true,
  minimizeMaximize: true,
  historicalFrameFork: true,
  accessibilityE2e: true,
  visualE2e: true,
  nativeE2e: true,
  architectureSite: true,
  architectureFileTree: true,
  architecturePseudocode: true,
  designD2ChatAffordances: true,
  designD2RichCardsApproval: true,
  designD2WorldConnectors: true,
  designD2StateSmokeTests: true,
  newSmithersOnly: true,
  legacyBoundary: true,
};
const boundary = {
  newSmithersRoot: "/Users/williamcory/flows",
  allowedProductNamespace: "@smithers/*",
  forbiddenNamespaces: ["@smthrs/*"],
  forbiddenRoots: ["/Users/williamcory/smithers"],
  violations: [],
};
const commit = { sha: "abcdef123456", message: "✨ feat: production candidate", branch: candidateBranch, evidenceRefs: ["artifacts/commit.json"] };

type OutputSnapshot = Record<string, unknown[]>;
type Rendered = Awaited<ReturnType<typeof render>>;
type TaskDescriptor = Rendered["tasks"][number];

function receipt(marker: string) {
  return { summary: marker, status: "pass", evidenceRefs: [`artifacts/${marker}.json`], blockers: [], commands: [] };
}

function row<T extends Record<string, unknown>>(nodeId: string, value: T): { nodeId: string; iteration: number } & T {
  return { nodeId, iteration: 0, ...value };
}

function task(graph: Rendered, nodeId: string): TaskDescriptor {
  const found = graph.tasks.find((candidate) => candidate.nodeId === nodeId);
  if (!found) throw new Error(`Expected rendered task ${nodeId}`);
  return found;
}

function ids(graph: Rendered) {
  return graph.tasks.map((candidate) => candidate.nodeId);
}

function schema(descriptor: TaskDescriptor) {
  if (!descriptor.outputSchema) throw new Error(`Expected output schema for ${descriptor.nodeId}`);
  return descriptor.outputSchema;
}

function agentModels(descriptor: TaskDescriptor) {
  const configured = Array.isArray(descriptor.agent) ? descriptor.agent : descriptor.agent ? [descriptor.agent] : [];
  return configured.map((agent) => (agent as { model?: string }).model ?? "unknown");
}

function agentIds(descriptor: TaskDescriptor) {
  const configured = Array.isArray(descriptor.agent) ? descriptor.agent : descriptor.agent ? [descriptor.agent] : [];
  return configured.map((agent) => (agent as { id?: string }).id ?? "unknown");
}

function prompt(descriptor: TaskDescriptor) {
  return descriptor.prompt ?? "";
}

async function render(outputs: OutputSnapshot = {}) {
  return renderWorkflow(workflow, { workflowPath, input: workflowInput, outputs, runId: "test-run" });
}

const initialize = row("initialize", {
  summary: "initialization-marker",
  status: "ready",
  contractVersion: "production-readiness-swarm/v2",
  contractValidationPassed: true,
  resolvedAcceptanceCommands: [],
  e2eCommandAction: "build_missing",
  instructionSources: ["AGENTS.md"],
  blockers: [],
});
const pocPreparation = row("prepare_poc_worktrees", {
  ...receipt("poc-worktree-preparation-marker"),
  baseRevision: "a".repeat(40),
  baseRef: `${branchRoot}/baseline`,
  metrics: { productLines: 3165, productionDependencies: 11, legacyImportViolations: 6 },
  worktrees: [
    { path: `${pocWorktreeRoot}/poc-authority-foundation`, branch: pocFoundationBranch, headRevision: "a".repeat(40) },
    { path: `${pocWorktreeRoot}/poc-state-journal`, branch: `${branchRoot}/poc-state-journal`, headRevision: "a".repeat(40) },
    { path: `${pocWorktreeRoot}/poc-flows-harness`, branch: `${branchRoot}/poc-flows-harness`, headRevision: "a".repeat(40) },
    { path: `${pocWorktreeRoot}/poc-platform-worldview`, branch: `${branchRoot}/poc-platform-worldview`, headRevision: "a".repeat(40) },
    { path: `${pocWorktreeRoot}/poc-transcript-chat-ui`, branch: `${branchRoot}/poc-transcript-chat-ui`, headRevision: "a".repeat(40) },
    { path: `${pocWorktreeRoot}/poc-integration`, branch: pocIntegrationBranch, headRevision: "a".repeat(40) },
  ],
});
const inventoryResearch = row("inventory_research", {
  ...receipt("research-marker"),
  baselineRevision: pocPreparation.baseRevision,
  baselineRef: pocPreparation.baseRef,
  metrics: pocPreparation.metrics,
  claims: [],
  instructionSources: ["AGENTS.md"],
  referenceComparisons: referenceRepos.map((repo) => ({ repo, repoState: "prototype", useFor: [`adopt-marker:${repo}`], doNotCarry: [`reject-marker:${repo}`], evidenceRefs: [`${repo}/AGENTS.md`] })),
  dependencyBoundary: boundary,
});
const inventoryEvidenceValidation = row("validate_inventory_evidence", {
  ...receipt("inventory-evidence-validation-marker"),
  checkedRefs: ["/Users/williamcory/mvp/AGENTS.md"],
  missingRefs: [],
  nonLocalRefs: [],
});
const inventorySynthesis = row("inventory_synthesis", {
  ...receipt("synthesis-marker"),
  baselineRevision: pocPreparation.baseRevision,
  baselineRef: pocPreparation.baseRef,
  constraints: [],
  conflicts: [],
  metrics: inventoryResearch.metrics,
  acceptanceCoverage: [],
  referenceDecisions: referenceRepos.map((repo) => ({ repo, adopt: [`adopt-marker:${repo}`], reject: [`reject-marker:${repo}`], evidenceRefs: [`${repo}/AGENTS.md`] })),
});
const pocRoundPlan = row("poc_round_plan", {
  ...receipt("poc-plan-marker"),
  baseRevision: pocPreparation.baseRevision,
  baseRef: pocPreparation.baseRef,
  hypothesis: "one falsifiable POC hypothesis",
  changedFromPriorRound: "first round",
  laneOwnership: [
    { lane: "authority-foundation", ownedPaths: ["package.json", "bun.lock", "src/bun/index.ts", "src/shared/NativeRPC.ts", "src/bun/authority/**", "src/shared/authority/**"], checks: ["check real Smithers closure"] },
    { lane: "state-journal", ownedPaths: ["poc/state.ts"], checks: ["check state-journal"] },
    { lane: "flows-harness", ownedPaths: ["poc/flows.ts"], checks: ["check flows-harness"] },
    { lane: "platform-worldview", ownedPaths: ["poc/platform.ts"], checks: ["check platform-worldview"] },
    { lane: "transcript-chat-ui", ownedPaths: ["poc/transcript.ts"], checks: ["check transcript-chat-ui"] },
  ],
});
const pocPlanValidation = row("validate_poc_round_plan", {
  ...receipt("poc-plan-validation-marker"),
  valid: true,
  checkedLanes: ["authority-foundation", "state-journal", "flows-harness", "platform-worldview", "transcript-chat-ui"],
  duplicateLanes: [],
  invalidPaths: [],
  missingAuthorityPaths: [],
  ownershipConflicts: [],
  baseMismatch: false,
});
const distributionManifest = {
  smithersSourceRoot: "/Users/williamcory/flows",
  sourceRevisions: { flows: "aaaaaaaa", agent: "bbbbbbbb", plugins: "cccccccc" },
  packages: ["database", "journal", "harness", "adapters", "connectors"].map((name) => ({ name: `@smithers/${name}`, version: "0.1.0", filename: `smithers-${name}-0.1.0.tgz`, sourceRoot: `/Users/williamcory/flows/${name}` })),
};
const pocFoundationBootstrap = row("prepare_poc_foundation_dependencies", {
  ...receipt("foundation-bootstrap-marker"),
  branch: pocFoundationBranch,
  executionCwd: `${pocWorktreeRoot}/poc-authority-foundation`,
  baseRevision: pocPreparation.baseRevision,
  distributionRoot: `${pocWorktreeRoot}/smithers-distribution`,
  distributionManifest,
  effectVersion: "4.0.0-beta.102",
  dependencyFootprint: { installedBytes: 1_100_000_000, installedFiles: 69_000 },
  assertions: {
    localDistributionPacked: true,
    externalConsumerSmoke: true,
    exactSourceProvenance: true,
    journalHarnessAdaptersConnectorsInstalled: true,
    effectRuntimeInstalled: true,
    bunLockfileMigrated: true,
    frozenLockfileInstall: true,
    dependencyFootprintMeasured: true,
    packageManifestWritesSerialized: true,
  },
});
const pocFoundation = row("poc_authority_foundation", {
  ...receipt("foundation-marker"),
  lane: "authority-foundation",
  hypothesisVerdict: "proven",
  branch: pocFoundationBranch,
  executionCwd: `${pocWorktreeRoot}/poc-authority-foundation`,
  baseRevision: pocPreparation.baseRevision,
  commitSha: pocFoundationRevision,
  changedFiles: ["package.json", "src/bun/authority/SmithersAuthority.ts"],
  distributionRoot: `${pocWorktreeRoot}/smithers-distribution`,
  distributionManifest,
  dependencyFootprint: { installedBytes: 1_100_000_000, installedFiles: 69_000 },
  assertions: {
    localDistributionPacked: true,
    externalConsumerSmoke: true,
    exactSourceProvenance: true,
    journalHarnessAdaptersConnectorsInstalled: true,
    authorityCompositionRoot: true,
    hostRuntimePlacement: true,
    rendererRuntimeIsolation: true,
    dependencyFootprintMeasured: true,
    packageManifestWritesSerialized: true,
    noLocalSmithersReimplementation: true,
    focusedBoundaryTests: true,
  },
});
const pocRoundBase = row("prepare_poc_round_base", {
  ...receipt("round-base-marker"),
  baseRevision: pocFoundationRevision,
  baseRef: pocFoundationBranch,
  metrics: { productLines: 3175, productionDependencies: 15, legacyImportViolations: 6 },
  worktrees: [
    { path: `${pocWorktreeRoot}/poc-state-journal`, branch: `${branchRoot}/poc-state-journal`, headRevision: pocFoundationRevision },
    { path: `${pocWorktreeRoot}/poc-flows-harness`, branch: `${branchRoot}/poc-flows-harness`, headRevision: pocFoundationRevision },
    { path: `${pocWorktreeRoot}/poc-platform-worldview`, branch: `${branchRoot}/poc-platform-worldview`, headRevision: pocFoundationRevision },
    { path: `${pocWorktreeRoot}/poc-transcript-chat-ui`, branch: `${branchRoot}/poc-transcript-chat-ui`, headRevision: pocFoundationRevision },
    { path: `${pocWorktreeRoot}/poc-integration`, branch: pocIntegrationBranch, headRevision: pocFoundationRevision },
  ],
});
const failedPocRoundBase = row("prepare_poc_round_base", {
  ...pocRoundBase,
  summary: "authority foundation precondition failed",
  status: "product_failure",
  blockers: ["foundation not proven"],
});
const pocLaneBranches = {
  state: `${branchRoot}/poc-state-journal`,
  flows: `${branchRoot}/poc-flows-harness`,
  platform: `${branchRoot}/poc-platform-worldview`,
  transcript: `${branchRoot}/poc-transcript-chat-ui`,
};
const pocLanes = {
  poc_state_journal: row("poc_state_journal", { ...receipt("state-lane-marker"), lane: "state-journal", branch: pocLaneBranches.state, executionCwd: `${pocWorktreeRoot}/poc-state-journal`, commitSha: "1111111", hypothesisVerdict: "proven", changedFiles: ["poc/state.ts"], assertions: { sqliteBackedCollections: true, tanstackDbAuthority: true, actorRecordedFlux: true, atomicJournal: true, framePersistence: true, newSmithersJournalResolved: true, journalTransactBoundaryExercised: true, noLocalJournalReimplementation: true } }),
  poc_flows_harness: row("poc_flows_harness", { ...receipt("flows-lane-marker"), lane: "flows-harness", branch: pocLaneBranches.flows, executionCwd: `${pocWorktreeRoot}/poc-flows-harness`, commitSha: "2222222", hypothesisVerdict: "proven", changedFiles: ["poc/flows.ts"], assertions: { oneFlowRegistry: true, slashCtxCallButtonParity: true, harnessCellExecutesSmithersScripts: true, recursiveNativeSubagents: true, durableFrameNavigation: true, newSmithersPackagesResolved: true, noLocalSmithersReimplementation: true } }),
  poc_platform_worldview: row("poc_platform_worldview", { ...receipt("platform-lane-marker"), lane: "platform-worldview", branch: pocLaneBranches.platform, executionCwd: `${pocWorktreeRoot}/poc-platform-worldview`, commitSha: "3333333", hypothesisVerdict: "proven", changedFiles: ["poc/platform.ts"], assertions: { connectors: true, externalAdapters: true, workspaceBranchRevision: true, worldviewMemoryProvenance: true, freshVersionedContextSnapshots: true, newSmithersConnectorPackagesResolved: true, noLocalConnectorRuntimeReimplementation: true } }),
  poc_transcript_chat_ui: row("poc_transcript_chat_ui", { ...receipt("transcript-lane-marker"), lane: "transcript-chat-ui", branch: pocLaneBranches.transcript, executionCwd: `${pocWorktreeRoot}/poc-transcript-chat-ui`, commitSha: "4444444", hypothesisVerdict: "proven", changedFiles: ["poc/transcript.ts"], assertions: { rendererNeutralTranscript: true, brainlessClaudeCodexRenderers: true, noAgentTabs: true, embeddedAndMaximizedSameComponent: true, persistentComposer: true, accessibleVisualFixtures: true } }),
};
const pocIntegration = row("poc_integrate_verify", {
  ...receipt("poc-integration-marker"),
  foundationCommit: { sha: pocFoundationRevision, message: "chore: install real Smithers authority", branch: pocFoundationBranch, evidenceRefs: ["artifacts/foundation.json"] },
  allLaneReceiptsPresent: true,
  integratedLaneCommits: Object.entries(pocLaneBranches).map(([name, branch], index) => ({ sha: `${index + 1}`.repeat(7), message: `${name} POC`, branch, evidenceRefs: [`artifacts/${name}.json`] })),
  candidateBranch: pocIntegrationBranch,
  executionCwd: `${pocWorktreeRoot}/poc-integration`,
  integrationCommit: { ...commit, branch: pocIntegrationBranch },
  parallelLanesManifestClean: true,
  legacyDependenciesRemoved: true,
  dependencyManifestFinalized: true,
  lockfileRegenerated: true,
  assertions: [],
  dependencyBoundary: boundary,
});
const pocFailure = row("poc_failure_route", { ...receipt("poc-failure-marker"), phase: "poc", failureSignature: null, shouldRetry: false, nextAction: "proceed" });
const architectureLearn = row("architecture_learn", { ...receipt("architecture-marker"), architectureScore: 90, lessons: [], sitePath: `${pocWorktreeRoot}/poc-integration/docs/architecture`, fileTreeDocumented: true, pseudocodeDocumented: true, referenceComparisonDocumented: true });
const pocGate = row("poc_gate", { ...receipt("poc-gate-marker"), passed: true, checks: [] });

const prePocOutputs: OutputSnapshot = {
  initialize: [initialize],
  prepare_poc_worktrees: [pocPreparation],
  inventory_research: [inventoryResearch],
  validate_inventory_evidence: [inventoryEvidenceValidation],
  inventory_synthesis: [inventorySynthesis],
  poc_round_plan: [pocRoundPlan],
  validate_poc_round_plan: [pocPlanValidation],
  prepare_poc_foundation_dependencies: [pocFoundationBootstrap],
  poc_authority_foundation: [pocFoundation],
  prepare_poc_round_base: [pocRoundBase],
};
const plannedPocOutputs: OutputSnapshot = {
  initialize: [initialize],
  prepare_poc_worktrees: [pocPreparation],
  inventory_research: [inventoryResearch],
  validate_inventory_evidence: [inventoryEvidenceValidation],
  inventory_synthesis: [inventorySynthesis],
  poc_round_plan: [pocRoundPlan],
  validate_poc_round_plan: [pocPlanValidation],
};
const bootstrappedPocOutputs: OutputSnapshot = {
  ...plannedPocOutputs,
  prepare_poc_foundation_dependencies: [pocFoundationBootstrap],
};
const pocLaneOutputs: OutputSnapshot = {
  ...prePocOutputs,
  ...Object.fromEntries(Object.entries(pocLanes).map(([name, value]) => [name, [value]])),
};
const pocPassed: OutputSnapshot = {
  ...pocLaneOutputs,
  poc_integrate_verify: [pocIntegration],
  poc_failure_route: [pocFailure],
  architecture_learn: [architectureLearn],
  poc_gate: [pocGate],
};

const domainPlanRows = {
  production_plan_state_journal: row("production_plan_state_journal", { ...receipt("state-plan-marker"), domain: "state-journal", architectureLessonsApplied: true, slices: [] }),
  production_plan_flows_harness: row("production_plan_flows_harness", { ...receipt("flows-plan-marker"), domain: "flows-harness", architectureLessonsApplied: true, slices: [] }),
  production_plan_transcript_ui: row("production_plan_transcript_ui", { ...receipt("transcript-plan-marker"), domain: "transcript-ui", architectureLessonsApplied: true, slices: [] }),
  production_plan_platform_security: row("production_plan_platform_security", { ...receipt("platform-plan-marker"), domain: "platform-security", architectureLessonsApplied: true, slices: [] }),
};
const supervisorPlan = row("production_supervisor_plan", { ...receipt("supervisor-marker"), ownershipConflicts: [], waves: [], acceptanceClausesMapped: [] });
const waveSliceIds = ["State/Auth", "Flow UI", "Transcript+Native"];
const wavePlan = row("production_wave_plan", { ...receipt("wave-marker"), waveId: "wave-1", correctionRound: 0, sliceIds: waveSliceIds, uniquePathOwnership: true, acceptanceCommands: [] });
const sliceDescriptors = [
  { taskId: "production_slice_01-state-auth", branch: `${branchRoot}/slice-01-state-auth`, marker: "slice-state-marker", sliceId: waveSliceIds[0] },
  { taskId: "production_slice_02-flow-ui", branch: `${branchRoot}/slice-02-flow-ui`, marker: "slice-flows-marker", sliceId: waveSliceIds[1] },
  { taskId: "production_slice_03-transcript-native", branch: `${branchRoot}/slice-03-transcript-native`, marker: "slice-transcript-marker", sliceId: waveSliceIds[2] },
];
const sliceRows = sliceDescriptors.map(({ taskId, branch, marker, sliceId }, index) => row(taskId, { ...receipt(marker), waveId: "wave-1", sliceIds: [sliceId], branch, commit: { ...commit, sha: `${index + 5}`.repeat(7), branch }, changedFiles: [`src/${index}.ts`], acceptanceCovered: [] }));
const productionPreparation = row("prepare_production_worktrees", {
  ...receipt("production-worktree-preparation-marker"),
  baseRevision: "1234567abcdef1234567890",
  baseRef: pocIntegrationBranch,
  metrics: { productLines: 4000, productionDependencies: 14, legacyImportViolations: 0 },
  worktrees: [
    ...sliceDescriptors.map(({ taskId, branch }) => ({ path: `/tmp/test-run/production-slices/${taskId.replace("production_slice_", "")}`, branch, headRevision: "1234567abcdef1234567890" })),
    { path: "/tmp/test-run/production-candidate", branch: candidateBranch, headRevision: "1234567abcdef1234567890" },
  ],
});
const productionMerge = row("production_merge", { ...receipt("merge-marker"), integrated: true, targetBranch: candidateBranch, commits: sliceRows.map((slice) => slice.commit), conflicts: [], landedOnMain: false, forcePushed: false });
const productionE2e = row("production_e2e", { ...receipt("production-e2e-marker"), phase: "production", missingCommandsBuilt: true, assertions: allAcceptanceAssertions, dependencyBoundary: boundary, artifacts: ["artifacts/e2e"] });
const productionFailure = row("production_failure_route", { ...receipt("production-failure-marker"), phase: "production", failureSignature: null, shouldRetry: false, nextAction: "proceed" });
const productionGate = row("production_gate", { ...receipt("production-gate-marker"), passed: true, checks: [] });
const productionPlanningOutputs: OutputSnapshot = {
  ...pocPassed,
  ...Object.fromEntries(Object.entries(domainPlanRows).map(([name, value]) => [name, [value]])),
  production_supervisor_plan: [supervisorPlan],
};
const waveOutputs: OutputSnapshot = { ...productionPlanningOutputs, production_wave_plan: [wavePlan] };
const preparedWaveOutputs: OutputSnapshot = { ...waveOutputs, prepare_production_worktrees: [productionPreparation] };
const implementationOutputs: OutputSnapshot = { ...preparedWaveOutputs, production_slice_implement: sliceRows };
const productionPassed: OutputSnapshot = {
  ...implementationOutputs,
  production_merge: [productionMerge],
  production_e2e: [productionE2e],
  production_failure_route: [productionFailure],
  production_gate: [productionGate],
};

const commitReview = row("commit_review", { ...receipt("commit-review-marker"), verdict: "pass", reviewedCommits: [commit.sha], findings: [] });
const stackReview = row("stack_review", { ...receipt("stack-review-marker"), verdict: "pass", reviewedCommits: [commit.sha], findings: [] });
const reviewCorrection = row("review_correction", { ...receipt("review-correction-marker"), phase: "review", corrections: [] });
const reviewE2e = row("review_e2e", { ...receipt("review-e2e-marker"), phase: "review", missingCommandsBuilt: false, assertions: allAcceptanceAssertions, dependencyBoundary: boundary, artifacts: [] });
const reviewGate = row("review_gate", { ...receipt("review-gate-marker"), passed: true, checks: [] });
const reviewPassed: OutputSnapshot = { ...productionPassed, commit_review: [commitReview], stack_review: [stackReview], review_e2e: [reviewE2e], review_gate: [reviewGate] };

const finalScan = row("final_scan", { ...receipt("final-scan-marker"), findings: [], simplificationScore: 95 });
const finalFix = row("final_fix", { ...receipt("final-fix-marker"), phase: "final", corrections: [] });
const finalArchitecture = row("final_architecture_update", { ...receipt("final-architecture-marker"), architectureScore: 96, sitePath: "docs/architecture", documentedFiles: ["docs/architecture/index.html"], fileTreeDocumented: true, pseudocodeDocumented: true, referenceComparisonDocumented: true, decisionsLinkedToEvidence: true });
const history = row("history_curate", { ...receipt("history-marker"), backupBookmark, targetBranch: candidateBranch, commits: [commit], forcePushed: false, landedOnMain: false });
const commitVerification = row("commit_series_verify", { ...receipt("commit-verification-marker"), allCommitsVerified: true, commitResults: [] });

function terminalOutputs(finalAssertion = true): OutputSnapshot {
  return {
    ...reviewPassed,
    final_scan: [finalScan],
    final_fix: [finalFix],
    final_architecture_update: [finalArchitecture],
    history_curate: [history],
    commit_series_verify: [commitVerification],
    final_verify: [row("final_verify", { ...receipt("final-verification-marker"), status: finalAssertion ? "pass" : "product_failure", assertions: { ...allAcceptanceAssertions, historicalFrameFork: finalAssertion }, dependencyBoundary: boundary, allCommitsVerified: true, cleanWorkingTree: true, architectureScore: 96, artifacts: ["artifacts/final-e2e.json"], blockers: finalAssertion ? [] : ["historical frame fork failed"] })],
  };
}

describe("production-readiness-swarm", () => {
  test("builds a provenance-pinned local Smithers package closure without rewriting runtime authority", async () => {
    const builder = await import(distributionBuilderPath) as {
      packageRoots: string[];
      publicationManifest: (manifest: Record<string, unknown>, dependencySpecs: Map<string, string>) => Record<string, unknown>;
    };
    expect(builder.packageRoots).toEqual(expect.arrayContaining([
      "flows/packages/journal",
      "agent/packages/harness",
      "plugins/packages/adapters",
      "connectors",
    ]));
    const dependencySpecs = new Map([["@smithers/journal", "file:/tmp/smithers-journal-0.1.0.tgz"]]);
    const packed = builder.publicationManifest({
      name: "@smithers/example",
      version: "0.1.0",
      exports: { ".": "./src/index.ts" },
      publishConfig: { access: "public", exports: { ".": { import: "./dist/esm/index.js" } } },
      dependencies: { "@smithers/journal": "file:../flows/packages/journal", effect: "4.0.0-beta.102" },
    }, dependencySpecs) as { exports: unknown; dependencies: Record<string, string> };
    expect(packed.exports).toEqual({ ".": { import: "./dist/esm/index.js" } });
    expect(packed.dependencies["@smithers/journal"]).toBe("file:/tmp/smithers-journal-0.1.0.tgz");
    expect(packed.dependencies.effect).toBe("4.0.0-beta.102");

    const connectors = builder.publicationManifest({
      name: "@smithers/connectors",
      version: "0.1.0",
      private: true,
      dependencies: { "@elizaos/core": "2.0.3-beta.7", zod: "3.25.76", "@elizaos/plugin-github": "2.0.3-beta.7" },
    }, new Map()) as { private: boolean; dependencies: Record<string, string>; exports: Record<string, string> };
    expect(connectors.private).toBe(false);
    expect(connectors.dependencies).toEqual({ "@elizaos/core": "2.0.3-beta.7", zod: "3.25.76" });
    expect(connectors.exports["."]).toBe("./runtime/index.ts");
    expect(await readFile(distributionBuilderPath, "utf8")).not.toContain("@smthrs/");
  });

  test("uses strict output-driven contracts and treats missing E2E commands as build work", async () => {
    const source = await readFile(workflowPath, "utf8");
    expect(source).not.toMatch(/until=\{false\}/);
    expect(source).not.toContain(".passthrough(");
    expect(source).not.toMatch(/status:\s*z\.string\(\)/);
    expect(source).toContain('id="inventory-evidence-loop"');
    expect(source).toContain("until={inventoryEvidenceValid}");
    expect(source).toContain('id="validate_poc_round_plan"');
    expect(source).toContain("pocRoundPlanValidationReceipt === undefined || !pocRoundPlanValid");
    expect(source).toContain("until={pocConverged || pocExhausted}");
    expect(source).toContain("until={productionConverged}");

    const initial = await render();
    const init = task(initial, "initialize");
    const initialized = await runTask(init);
    expect(initialized).toMatchObject({ status: "ready", e2eCommandAction: "build_missing", blockers: [] });
    expect(schema(init).safeParse(initialized).success).toBe(true);
    expect(schema(init).safeParse({ ...initialized as object, surprise: true }).success).toBe(false);

    const poc = await render(prePocOutputs);
    expect(schema(task(poc, "poc_state_journal")).safeParse({ summary: "decorative", status: "pass", evidenceRefs: [], blockers: [], commands: [] }).success).toBe(false);
    const integrated = await render(pocLaneOutputs);
    expect(schema(task(integrated, "poc_integrate_verify")).safeParse({ ...initialized as object }).success).toBe(false);
  });

  test("freezes the current jj snapshot before preparing run-scoped Git worktrees", async () => {
    const source = await readFile(workflowPath, "utf8");
    expect(source).not.toContain('baseBranch="main"');
    expect(source).toContain('execText("jj", ["log", "-r", "@"');
    expect(source).toContain('execText("git", ["commit-tree", tree');
    expect(source).toContain('execText("git", ["diff", "--quiet", mutableRevision, frozenRevision');
    expect(source).toContain('execText("git", ["branch", "-f", baselineBranch, baseRevision]');
    const preparationFrame = await render({ initialize: [initialize] });
    const preparation = task(preparationFrame, "prepare_poc_worktrees");
    expect(preparation.retries).toBe(1);
    const bootstrapFrame = await render(plannedPocOutputs);
    const bootstrap = task(bootstrapFrame, "prepare_poc_foundation_dependencies");
    expect(bootstrap.agent).toBeUndefined();
    expect(bootstrap.dependsOn).toEqual(expect.arrayContaining(["poc_round_plan", "validate_poc_round_plan", "prepare_poc_worktrees"]));
    const foundationFrame = await render(bootstrappedPocOutputs);
    const foundation = task(foundationFrame, "poc_authority_foundation");
    expect(foundation.worktreeBranch).toBe(pocFoundationBranch);
    expect(foundation.worktreeBaseBranch).toBe(baselineBranch);
    const poc = await render(prePocOutputs);
    const lanes = ["poc_state_journal", "poc_flows_harness", "poc_platform_worldview", "poc_transcript_chat_ui"].map((nodeId) => task(poc, nodeId));
    expect(lanes.every((lane) => lane.worktreeBaseBranch === pocFoundationBranch)).toBe(true);
    expect(new Set(lanes.map((lane) => lane.worktreeBranch)).size).toBe(4);
    expect(lanes.every((lane) => lane.worktreeBranch?.startsWith(`${branchRoot}/`) === true)).toBe(true);
    const integration = task(await render(pocLaneOutputs), "poc_integrate_verify");
    expect(integration.worktreeBaseBranch).toBe(pocFoundationBranch);
    expect(integration.worktreeBranch).toBe(pocIntegrationBranch);
  });

  test("repairs non-canonical POC ownership before package work or implementation fan-out", async () => {
    const invalidPlan = row("poc_round_plan", {
      ...pocRoundPlan,
      laneOwnership: pocRoundPlan.laneOwnership.map((lane) => lane.lane === "authority-foundation"
        ? { ...lane, ownedPaths: lane.ownedPaths.map((ownedPath) => ownedPath === "package.json" ? "package.json (written by bootstrap)" : ownedPath) }
        : lane),
    });
    const invalidFrame = await render({
      initialize: [initialize],
      prepare_poc_worktrees: [pocPreparation],
      inventory_research: [inventoryResearch],
      validate_inventory_evidence: [inventoryEvidenceValidation],
      inventory_synthesis: [inventorySynthesis],
      poc_round_plan: [invalidPlan],
    });
    const validationTask = task(invalidFrame, "validate_poc_round_plan");
    expect(validationTask.agent).toBeUndefined();
    const rejected = await runTask(validationTask) as Record<string, unknown>;
    expect(rejected).toMatchObject({ status: "product_failure", valid: false });
    expect(rejected.invalidPaths).toEqual(expect.arrayContaining([expect.objectContaining({ ownedPath: "package.json (written by bootstrap)" })]));
    expect(rejected.missingAuthorityPaths).toEqual(expect.arrayContaining(["package.json"]));

    const phaseInvalidPlan = row("poc_round_plan", {
      ...pocRoundPlan,
      laneOwnership: pocRoundPlan.laneOwnership.map((lane) => lane.lane === "authority-foundation"
        ? { ...lane, checks: [...lane.checks, "Run the Vite product build with a 120-second renderer timeout"] }
        : lane),
    });
    const phaseInvalidFrame = await render({
      initialize: [initialize],
      prepare_poc_worktrees: [pocPreparation],
      inventory_research: [inventoryResearch],
      validate_inventory_evidence: [inventoryEvidenceValidation],
      inventory_synthesis: [inventorySynthesis],
      poc_round_plan: [phaseInvalidPlan],
    });
    const phaseRejected = await runTask(task(phaseInvalidFrame, "validate_poc_round_plan")) as { status: string; valid: boolean; blockers: string[] };
    expect(phaseRejected).toMatchObject({ status: "product_failure", valid: false });
    expect(phaseRejected.blockers.some((blocker) => blocker.includes("crosses into the renderer/integration build gate"))).toBe(true);

    const repairFrame = await render({
      initialize: [initialize],
      prepare_poc_worktrees: [pocPreparation],
      inventory_research: [inventoryResearch],
      validate_inventory_evidence: [inventoryEvidenceValidation],
      inventory_synthesis: [inventorySynthesis],
      poc_round_plan: [invalidPlan],
      validate_poc_round_plan: [row("validate_poc_round_plan", rejected)],
    });
    expect(ids(repairFrame)).toContain("poc_round_plan");
    expect(ids(repairFrame)).not.toContain("prepare_poc_foundation_dependencies");
    expect(prompt(task(repairFrame, "poc_round_plan"))).toContain("package.json (written by bootstrap)");
    expect(prompt(task(repairFrame, "poc_round_plan"))).toContain("priorPlanValidation");
  });

  test("keeps deterministic package preparation heartbeat-safe and migrates one verified Bun lockfile", async () => {
    const source = await readFile(workflowPath, "utf8");
    const runner = await readFile(join(import.meta.dir, "..", "lib", "run-bounded-process.ts"), "utf8");
    expect(source).toContain("runBoundedProcess(command, args, cwd, { timeoutMs })");
    expect(runner).toContain("spawn(command, [...args]");
    expect(runner).toContain("detached: grouped");
    expect(runner).toContain("process.kill(-child.pid, signal)");
    expect(runner).toContain('signalProcessGroup("SIGKILL")');
    expect(source).toContain("await runBounded");
    expect(source).toContain('await runBounded("bun", ["pm", "migrate"]');
    expect(source).toContain('await runBounded("bun", ["install", "--frozen-lockfile", "--ignore-scripts"]');
    expect(source).toContain("rmSync(npmLockPath)");
    expect(source).not.toContain('"--package-lock=false"');
  });

  test("kills a timed-out command's resistant descendants as one process group", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "smithers-bounded-process-"));
    const pidFile = join(root, "grandchild.pid");
    const grandchildProgram = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const parentProgram = [
      "const {spawn}=require('node:child_process')",
      "const {writeFileSync}=require('node:fs')",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildProgram)}],{stdio:'ignore'})`,
      `writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
      "process.on('SIGTERM',()=>process.exit(0))",
      "setInterval(()=>{},1000)",
    ].join(";");
    let grandchildPid: number | undefined;
    try {
      const result = await runBoundedProcess(process.execPath, ["-e", parentProgram], root, {
        // CI and local POC runs can be CPU-saturated by concurrent bundlers.
        // Give the fixture enough time to publish its descendant receipt before
        // exercising the deliberately short termination grace period.
        timeoutMs: 3_000,
        terminationGraceMs: 100,
      });
      expect(result).toMatchObject({ passed: false, timedOut: true });
      grandchildPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      let alive = true;
      for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
        try { process.kill(grandchildPid, 0); } catch { alive = false; }
        if (alive) await Bun.sleep(25);
      }
      expect(alive).toBe(false);
    } finally {
      if (grandchildPid !== undefined) {
        try { process.kill(grandchildPid, "SIGKILL"); } catch { /* already gone */ }
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires proven authority-clean lane receipts and rotates failed POC rounds into fresh worktrees", async () => {
    const workflowSource = await readFile(workflowPath, "utf8");
    expect(workflowSource).toContain("completedPocRounds + (pocConverged ? 0 : 1)");
    const readyForGate: OutputSnapshot = {
      ...pocLaneOutputs,
      poc_integrate_verify: [pocIntegration],
      poc_failure_route: [pocFailure],
      architecture_learn: [architectureLearn],
    };
    const passingGate = await runTask(task(await render(readyForGate), "poc_gate"));
    expect(passingGate).toMatchObject({ passed: true, status: "pass" });

    const localSmithersLane = row("poc_flows_harness", {
      ...pocLanes.poc_flows_harness,
      assertions: { ...pocLanes.poc_flows_harness.assertions, noLocalSmithersReimplementation: false },
    });
    const rejectedGate = await runTask(task(await render({ ...readyForGate, poc_flows_harness: [localSmithersLane] }), "poc_gate"));
    expect(rejectedGate).toMatchObject({ passed: false });
    expect((rejectedGate as { blockers: string[] }).blockers).toContain("One or more domain lane receipts were not proven, branch-pinned, ownership-clean, or fully asserted.");

    const escapedTranscriptLane = row("poc_transcript_chat_ui", {
      ...pocLanes.poc_transcript_chat_ui,
      changedFiles: ["src/mainview/index.css"],
    });
    const ownershipGate = await runTask(task(await render({ ...readyForGate, poc_transcript_chat_ui: [escapedTranscriptLane] }), "poc_gate"));
    expect(ownershipGate).toMatchObject({ passed: false });

    const failedGate = row("poc_gate", { ...receipt("failed-poc-gate"), status: "product_failure", passed: false, checks: [] });
    const secondRound = await renderWorkflow(workflow, {
      workflowPath,
      input: { ...workflowInput, maxPrototypeRounds: 2 },
      outputs: { ...readyForGate, poc_gate: [failedGate] },
      runId: "test-run",
    });
    const secondFoundation = task(secondRound, "poc_authority_foundation");
    expect(secondFoundation.worktreeBranch).toBe(`${branchRoot}/round-02/poc-authority-foundation`);
    expect(secondFoundation.worktreePath).toContain("/round-02/poc-authority-foundation");
  });

  test("short-circuits failed foundation preconditions without scheduling implementation or integration agents", async () => {
    const failedBootstrap = row("prepare_poc_foundation_dependencies", {
      ...pocFoundationBootstrap,
      summary: "deterministic bootstrap timed out",
      status: "environment_failure",
      blockers: ["npm install exceeded its deterministic budget"],
      distributionManifest: null,
      effectVersion: null,
      dependencyFootprint: null,
      assertions: Object.fromEntries(Object.keys(pocFoundationBootstrap.assertions).map((name) => [name, false])),
    });
    const bootstrapFailureFrame = await render({ ...plannedPocOutputs, prepare_poc_foundation_dependencies: [failedBootstrap] });
    const skippedFoundationTask = task(bootstrapFailureFrame, "poc_authority_foundation");
    expect(skippedFoundationTask.agent).toBeUndefined();
    expect(await runTask(skippedFoundationTask)).toMatchObject({
      status: "environment_failure",
      hypothesisVerdict: "inconclusive",
      commitSha: null,
      distributionManifest: null,
      dependencyFootprint: null,
    });

    const failedPreparationOutputs: OutputSnapshot = { ...prePocOutputs, prepare_poc_round_base: [failedPocRoundBase] };
    const fleetFrame = await render(failedPreparationOutputs);
    const laneIds = ["poc_state_journal", "poc_flows_harness", "poc_platform_worldview", "poc_transcript_chat_ui"];
    const skippedRows: OutputSnapshot = {};
    for (const nodeId of laneIds) {
      const laneTask = task(fleetFrame, nodeId);
      expect(laneTask.agent).toBeUndefined();
      const result = await runTask(laneTask) as Record<string, unknown>;
      expect(result).toMatchObject({ status: "environment_failure", hypothesisVerdict: "inconclusive", commitSha: null });
      skippedRows[nodeId] = [row(nodeId, result)];
    }

    const integrationFrame = await render({ ...failedPreparationOutputs, ...skippedRows });
    const integrationTask = task(integrationFrame, "poc_integrate_verify");
    expect(integrationTask.agent).toBeUndefined();
    const integration = await runTask(integrationTask) as Record<string, unknown>;
    expect(integration).toMatchObject({ status: "environment_failure", foundationCommit: null, integratedLaneCommits: [], integrationCommit: null });

    const routeFrame = await render({ ...failedPreparationOutputs, ...skippedRows, poc_integrate_verify: [row("poc_integrate_verify", integration)] });
    const routeTask = task(routeFrame, "poc_failure_route");
    expect(routeTask.agent).toBeUndefined();
    expect(await runTask(routeTask)).toMatchObject({ status: "pass", shouldRetry: true, nextAction: "build_or_repair_harness" });
  });

  test("uses a fresh Opus authority lane and passes typed POC receipts through prompts", async () => {
    const initial = await render({ initialize: [initialize], prepare_poc_worktrees: [pocPreparation] });
    const inventoryPrompt = prompt(task(initial, "inventory_research"));
    expect(inventoryPrompt).toContain("initialization-marker");
    expect(inventoryPrompt).toContain("poc-worktree-preparation-marker");
    expect(inventoryPrompt).toContain("sole content and metric authority");
    expect(inventoryPrompt).toContain("optional numeric `:line` or `:start-end` suffix");
    expect(inventoryPrompt).toContain("never an imagined `<worktreeRoot>/baseline` path");
    expect(inventoryPrompt).toContain(String(pocPreparation.baseRevision));
    for (const repo of referenceRepos) expect(inventoryPrompt).toContain(repo);
    const validationFrame = await render({ initialize: [initialize], prepare_poc_worktrees: [pocPreparation], inventory_research: [inventoryResearch] });
    const validationTask = task(validationFrame, "validate_inventory_evidence");
    expect(validationTask.agent).toBeUndefined();
    const rejectedEvidence = await runTask(validationTask);
    expect(rejectedEvidence).toMatchObject({ status: "product_failure" });
    expect((rejectedEvidence as { nonLocalRefs: string[] }).nonLocalRefs).toContain("AGENTS.md");
    const repairFrame = await render({
      initialize: [initialize],
      prepare_poc_worktrees: [pocPreparation],
      inventory_research: [inventoryResearch],
      validate_inventory_evidence: [row("validate_inventory_evidence", rejectedEvidence as Record<string, unknown>)],
    });
    const repairTask = task(repairFrame, "inventory_research");
    expect(prompt(repairTask)).toContain("priorEvidenceValidation");
    expect(prompt(repairTask)).toContain("AGENTS.md");
    expect(prompt(repairTask)).toContain("automatic repair iteration");
    const synthesisFrame = await render({ initialize: [initialize], prepare_poc_worktrees: [pocPreparation], inventory_research: [inventoryResearch], validate_inventory_evidence: [inventoryEvidenceValidation] });
    const synthesisTask = task(synthesisFrame, "inventory_synthesis");
    expect(prompt(synthesisTask)).toContain("research-marker");
    expect(prompt(synthesisTask)).toContain("inventory-evidence-validation-marker");
    expect(prompt(synthesisTask)).toContain("poc-worktree-preparation-marker");
    expect(prompt(synthesisTask)).toContain("Do not inspect repository state");
    expect(prompt(synthesisTask)).toContain("3165");
    expect(synthesisTask.retries).toBe(1);
    const planFrame = await render({ initialize: [initialize], prepare_poc_worktrees: [pocPreparation], inventory_research: [inventoryResearch], validate_inventory_evidence: [inventoryEvidenceValidation], inventory_synthesis: [inventorySynthesis] });
    const planTask = task(planFrame, "poc_round_plan");
    expect(prompt(planTask)).toContain("synthesis-marker");
    expect(prompt(planTask)).toContain("poc-worktree-preparation-marker");
    expect(prompt(planTask)).toContain(String(pocPreparation.baseRevision));
    expect(prompt(planTask)).toContain("sole VCS authority");
    expect(prompt(planTask)).toContain("committed tree equality");
    expect(prompt(planTask)).toContain("never by SHA equality, merge-base, or ancestry");
    expect(prompt(planTask)).toContain("machine input, not prose");
    expect(prompt(planTask)).toContain("these six exact strings");
    expect(planTask.retries).toBe(1);

    const planValidationFrame = await render({
      initialize: [initialize],
      prepare_poc_worktrees: [pocPreparation],
      inventory_research: [inventoryResearch],
      validate_inventory_evidence: [inventoryEvidenceValidation],
      inventory_synthesis: [inventorySynthesis],
      poc_round_plan: [pocRoundPlan],
    });
    const planValidationTask = task(planValidationFrame, "validate_poc_round_plan");
    expect(planValidationTask.agent).toBeUndefined();
    expect(await runTask(planValidationTask)).toMatchObject({ status: "pass", valid: true, baseMismatch: false });

    const bootstrapFrame = await render(plannedPocOutputs);
    const bootstrapTask = task(bootstrapFrame, "prepare_poc_foundation_dependencies");
    expect(bootstrapTask.agent).toBeUndefined();
    expect(bootstrapTask.retries).toBe(1);
    const foundationFrame = await render(bootstrappedPocOutputs);
    const foundationTask = task(foundationFrame, "poc_authority_foundation");
    expect(agentModels(foundationTask)).toEqual(["claude-opus-5"]);
    expect(prompt(foundationTask)).toContain("poc-plan-marker");
    expect(prompt(foundationTask)).toContain("foundation-bootstrap-marker");
    expect(prompt(foundationTask)).toContain("build-local-smithers-distribution.mjs");
    expect(prompt(foundationTask)).toContain("@smithers/connectors");
    expect(prompt(foundationTask)).toContain("Smithers durability snapshots");
    expect(prompt(foundationTask)).toContain("valid durable state");
    expect(prompt(foundationTask)).toContain("do not pack, smoke, install, or regenerate the lockfile again");
    expect(prompt(foundationTask)).toContain("discarded prior experiment needed 406 lines");
    expect(prompt(foundationTask)).toContain("Do not create application transition tables");
    expect(prompt(foundationTask)).toContain("full product build here is invalid phase coupling");
    expect(prompt(foundationTask)).toContain("serial integration task owns the one bounded product build");
    expect(prompt(foundationTask)).not.toContain("spawnSync");

    const poc = await render(prePocOutputs);
    const laneIds = ["poc_state_journal", "poc_flows_harness", "poc_platform_worldview", "poc_transcript_chat_ui"];
    for (const nodeId of laneIds) {
      expect(agentModels(task(poc, nodeId))).toEqual(["gpt-5.6-luna"]);
      expect(prompt(task(poc, nodeId))).toContain("poc-plan-marker");
      expect(prompt(task(poc, nodeId))).toContain("foundation-marker");
      expect(prompt(task(poc, nodeId))).toContain("round-base-marker");
      expect(prompt(task(poc, nodeId))).toContain("git diff --quiet roundBasePreparation.baseRevision HEAD -- .");
      expect(prompt(task(poc, nodeId))).toContain("two-endpoint tree diff");
      expect(prompt(task(poc, nodeId))).not.toContain("git rev-parse HEAD` equals");
      expect(task(poc, nodeId).retries).toBe(1);
    }
    expect(new Set(laneIds.map((nodeId) => task(poc, nodeId).parallelGroupId)).size).toBe(1);
    expect(laneIds.every((nodeId) => task(poc, nodeId).parallelMaxConcurrency === 4)).toBe(true);

    const integrationFrame = await render(pocLaneOutputs);
    const integration = task(integrationFrame, "poc_integrate_verify");
    expect(agentModels(integration)).toEqual(["gpt-5.6-sol"]);
    for (const marker of ["foundation-marker", "round-base-marker", "state-lane-marker", "flows-lane-marker", "platform-lane-marker", "transcript-lane-marker", ...Object.values(pocLaneBranches), pocIntegrationBranch, pocFoundationRevision, "1111111", "2222222", "3333333", "4444444"]) {
      expect(prompt(integration)).toContain(marker);
    }
    expect(prompt(integration)).toContain("git diff --quiet roundBasePreparation.baseRevision HEAD -- .");
    expect(prompt(integration)).toContain("durability snapshots");
    expect(new Set(integration.dependsOn)).toEqual(new Set([...laneIds, "poc_authority_foundation", "prepare_poc_round_base"]));

    const failureFrame = await render({ ...pocLaneOutputs, poc_integrate_verify: [pocIntegration] });
    expect(prompt(task(failureFrame, "poc_failure_route"))).toContain("poc-integration-marker");
    const architectureFrame = await render({ ...pocLaneOutputs, poc_integrate_verify: [pocIntegration], poc_failure_route: [pocFailure] });
    const architecturePrompt = prompt(task(architectureFrame, "architecture_learn"));
    expect(architecturePrompt).toContain("poc-failure-marker");
    expect(architecturePrompt).toContain("foundation-marker");
    expect(architecturePrompt).toContain("round-base-marker");
    expect(architecturePrompt).toContain("research-marker");
    expect(architecturePrompt).toContain("synthesis-marker");
    expect(architecturePrompt).toContain("Keep this learning pass bounded");
    expect(architecturePrompt).toContain("exact declared `architectureSitePath`");
    expect(architecturePrompt).toContain("do not install packages");
    expect(architecturePrompt).toContain("Do not run the full product build");
    for (const repo of referenceRepos) expect(architecturePrompt).toContain(repo);

    for (const graph of [initial, synthesisFrame, planFrame, bootstrapFrame, foundationFrame, poc, integrationFrame, failureFrame, architectureFrame]) {
      for (const descriptor of graph.tasks) {
        const claudeModels = agentModels(descriptor).filter((model) => model.startsWith("claude-"));
        if (descriptor.nodeId === "poc_authority_foundation") expect(claudeModels).toEqual(["claude-opus-5"]);
        else expect(claudeModels).toEqual([]);
      }
    }
  });

  test("mounts Opus divide-and-conquer planning only after the POC gate", async () => {
    expect(ids(await render())).not.toContain("production_plan_state_journal");
    const planning = await render(pocPassed);
    const domainIds = ["production_plan_state_journal", "production_plan_flows_harness", "production_plan_transcript_ui", "production_plan_platform_security"];
    for (const nodeId of domainIds) {
      expect(agentModels(task(planning, nodeId))).toEqual(["claude-opus-5"]);
      const ids = agentIds(task(planning, nodeId));
      expect(ids).toHaveLength(1);
      expect(ids[0]?.startsWith("smithers-account:")).toBe(false);
      expect(prompt(task(planning, nodeId))).toContain("architecture-marker");
      expect(prompt(task(planning, nodeId))).toContain(pocIntegrationBranch);
    }
    const supervisorFrame = await render({ ...pocPassed, ...Object.fromEntries(Object.entries(domainPlanRows).map(([name, value]) => [name, [value]])) });
    const supervisorTask = task(supervisorFrame, "production_supervisor_plan");
    expect(agentModels(supervisorTask)).toEqual(["claude-opus-5"]);
    for (const marker of ["state-plan-marker", "flows-plan-marker", "transcript-plan-marker", "platform-plan-marker"]) expect(prompt(supervisorTask)).toContain(marker);
    const waveFrame = await render(productionPlanningOutputs);
    expect(agentModels(task(waveFrame, "production_wave_plan"))).toEqual(["claude-opus-5"]);
    expect(prompt(task(waveFrame, "production_wave_plan"))).toContain("supervisor-marker");
  });

  test("fans a typed wave into distinct parallel Sol worktrees and explicitly fans every receipt into serial merge", async () => {
    const wave = await render(waveOutputs);
    expect(ids(wave)).toContain("prepare_production_worktrees");
    expect(task(wave, "prepare_production_worktrees").retries).toBe(1);
    for (const nodeId of ["commit_review", "stack_review", "review_correction", "review_e2e", "review_gate", "final_scan", "final_verify"]) {
      expect(ids(wave)).not.toContain(nodeId);
    }
    const preparedWave = await render(preparedWaveOutputs);
    for (const descriptor of sliceDescriptors) {
      const implementation = task(preparedWave, descriptor.taskId);
      expect(agentModels(implementation)).toEqual(["gpt-5.6-sol"]);
      expect(implementation.worktreeBranch).toBe(descriptor.branch);
      expect(implementation.worktreeBaseBranch).toBe(pocIntegrationBranch);
      expect(implementation.worktreePath).toContain(`/production-slices/${descriptor.taskId.replace("production_slice_", "")}`);
      expect(prompt(implementation)).toContain(descriptor.sliceId);
      expect(prompt(implementation)).toContain("wave-marker");
      expect(prompt(implementation)).toContain("supervisor-marker");
      expect(prompt(implementation)).toContain("production-worktree-preparation-marker");
      expect(implementation.retries).toBe(1);
    }
    expect(new Set(sliceDescriptors.map(({ taskId }) => task(preparedWave, taskId).parallelGroupId)).size).toBe(1);
    expect(sliceDescriptors.every(({ taskId }) => task(preparedWave, taskId).parallelMaxConcurrency === 4)).toBe(true);
    expect(new Set(sliceDescriptors.map(({ taskId }) => task(preparedWave, taskId).worktreePath)).size).toBe(3);

    const mergeFrame = await render(implementationOutputs);
    const merge = task(mergeFrame, "production_merge");
    expect(new Set(merge.dependsOn)).toEqual(new Set(["prepare_production_worktrees", "production_wave_plan", ...sliceDescriptors.map(({ taskId }) => taskId)]));
    expect(merge.parallelMaxConcurrency).toBe(1);
    expect(merge.worktreeBranch).toBe(candidateBranch);
    expect(merge.worktreeBaseBranch).toBe(pocIntegrationBranch);
    for (const descriptor of sliceDescriptors) {
      expect(prompt(merge)).toContain(descriptor.marker);
      expect(prompt(merge)).toContain(descriptor.branch);
    }
    expect(prompt(merge)).toContain("wave-marker");
    for (const nodeId of ["commit_review", "stack_review", "review_correction", "review_e2e", "review_gate", "final_scan", "final_verify"]) {
      expect(ids(mergeFrame)).not.toContain(nodeId);
    }
  });

  test("threads merge, E2E, review, correction, history, and final evidence into their direct consumers", async () => {
    const e2eFrame = await render({ ...implementationOutputs, production_merge: [productionMerge] });
    expect(prompt(task(e2eFrame, "production_e2e"))).toContain("merge-marker");
    expect(prompt(task(e2eFrame, "production_e2e"))).toContain(candidateBranch);
    const routeFrame = await render({ ...implementationOutputs, production_merge: [productionMerge], production_e2e: [productionE2e] });
    expect(prompt(task(routeFrame, "production_failure_route"))).toContain("production-e2e-marker");

    const reviews = await render(productionPassed);
    expect(ids(reviews)).toContain("commit_review");
    expect(ids(reviews)).toContain("stack_review");
    expect(ids(reviews)).not.toContain("final_scan");
    for (const nodeId of ["commit_review", "stack_review"]) {
      expect(prompt(task(reviews, nodeId))).toContain("production-gate-marker");
      expect(prompt(task(reviews, nodeId))).toContain("production-e2e-marker");
    }
    const correctionReviews = {
      ...productionPassed,
      commit_review: [row("commit_review", { ...commitReview, verdict: "changes_requested", summary: "commit-review-change-marker" })],
      stack_review: [stackReview],
    };
    const correctionFrame = await render(correctionReviews);
    expect(prompt(task(correctionFrame, "review_correction"))).toContain("commit-review-change-marker");
    const reviewE2eFrame = await render({ ...correctionReviews, review_correction: [reviewCorrection] });
    expect(prompt(task(reviewE2eFrame, "review_e2e"))).toContain("review-correction-marker");

    const finalScanFrame = await render(reviewPassed);
    expect(prompt(task(finalScanFrame, "final_scan"))).toContain("review-e2e-marker");
    const finalFixFrame = await render({ ...reviewPassed, final_scan: [finalScan] });
    expect(prompt(task(finalFixFrame, "final_fix"))).toContain("final-scan-marker");
    const architectureFrame = await render({ ...reviewPassed, final_scan: [finalScan], final_fix: [finalFix] });
    const finalArchitecturePrompt = prompt(task(architectureFrame, "final_architecture_update"));
    expect(finalArchitecturePrompt).toContain("final-fix-marker");
    expect(finalArchitecturePrompt).toContain("research-marker");
    expect(finalArchitecturePrompt).toContain("synthesis-marker");
    expect(finalArchitecturePrompt).toContain("architecture-marker");
    const historyFrame = await render({ ...reviewPassed, final_scan: [finalScan], final_fix: [finalFix], final_architecture_update: [finalArchitecture] });
    expect(prompt(task(historyFrame, "history_curate"))).toContain("final-architecture-marker");
    expect(prompt(task(historyFrame, "history_curate"))).toContain(backupBookmark);
    const commitFrame = await render({ ...reviewPassed, final_scan: [finalScan], final_fix: [finalFix], final_architecture_update: [finalArchitecture], history_curate: [history] });
    expect(prompt(task(commitFrame, "commit_series_verify"))).toContain("history-marker");
    const finalFrame = await render({ ...reviewPassed, final_scan: [finalScan], final_fix: [finalFix], final_architecture_update: [finalArchitecture], history_curate: [history], commit_series_verify: [commitVerification] });
    const final = task(finalFrame, "final_verify");
    for (const marker of ["history-marker", "commit-verification-marker", "final-architecture-marker", "review-e2e-marker", candidateBranch, backupBookmark]) expect(prompt(final)).toContain(marker);
  });

  test("derives a production-ready or blocked release solely from typed receipts", async () => {
    const passingFrame = await render(terminalOutputs(true));
    const passingRelease = task(passingFrame, "release_readiness");
    const ready = await runTask(passingRelease);
    expect(ready).toMatchObject({ status: "production-ready", architectureScore: 96, e2eStatus: "pass", blockers: [] });
    expect(schema(passingRelease).safeParse(ready).success).toBe(true);
    expect(schema(passingRelease).safeParse({ ...ready as object, undocumented: true }).success).toBe(false);

    const failingFrame = await render(terminalOutputs(false));
    const blocked = await runTask(task(failingFrame, "release_readiness"));
    expect(blocked).toMatchObject({ status: "blocked", e2eStatus: "product_failure" });
    expect((blocked as { blockers: string[] }).blockers).toContain("Final acceptance assertions did not all pass.");
  });

  test("keeps every mandatory product and architecture acceptance clause executable", async () => {
    const workflowSource = await readFile(workflowPath, "utf8");
    const promptSources = await Promise.all(["inventory-research.mdx", "inventory-synthesis.mdx", "poc-round-plan.mdx", "poc-authority-foundation.mdx", "poc-state-journal.mdx", "poc-flows-harness.mdx", "poc-platform-worldview.mdx", "production-e2e.mdx", "final-verify.mdx", "poc-integrate-verify.mdx", "final-architecture-update.mdx"].map((name) => readFile(join(promptDir, name), "utf8")));
    const contract = `${workflowSource}\n${promptSources.join("\n")}`;
    for (const clause of [
      "SQLite-backed TanStack DB authority", "one host SQLite record", "all-collection ProjectionBatch", "actor-recorded Flux", "atomic Journal", "slash, ctx.call, and button parity",
      "connectors", "workspace/branch/revision", "Harness Cell", "recursive native subagents", "external adapters",
      "worldview/memory", "renderer-neutral transcript", "Brainless Claude", "Brainless Codex", "individually vendored", "content-pinned", "never full provider session/composer blocks", "no agent tabs",
      "embedded mini-app", "same component maximized", "persistent composer", "URL-addressed durable frame graph",
      "browser back/forward", "minimize/maximize", "historical-frame fork", "accessibility", "visual", "native E2E",
      "serial host and RPC composition roots", "src/bun/index.ts", "src/shared/NativeRPC.ts",
      "@smithers/*", "@smthrs/*", "/Users/williamcory/smithers", "architecture documentation site", "file tree", "pseudocode",
      "existing components", "design tokens", "progressive disclosure", "visual diagrams",
      "flows/ui", "multi", "gui", "Flows/Harness", "Smithers-Ops",
      "/Users/williamcory/mvp/DESIGN.md", "retry failed turns", "per-message copy", "actions.replaced",
      "PlanCard", "ApprovalCard", "ArtifactCard", "DiffCard", "StatusCard", "BacklinksPanel", "OutlineView", "SurfaceHeader",
      "backend half of the NDJSON card/card.update contract", "AgentTurnFrame support", "approval-decision round trip",
      "Vitest plus Testing Library state smoke tests",
      "sole content and metric authority", "sole VCS authority", "git branch --show-current", "pocRoundPlan.baseRevision",
      "Smithers durability snapshots", "two-endpoint tree diff", "git diff --quiet",
      "newSmithersJournalResolved", "journalTransactBoundaryExercised", "noLocalJournalReimplementation",
      "Journal.transact is storage-only", "Flow bodies", "Activity bodies", "boundary prepare/settle",
      "sealed/compensable/irreversible tiers", "stable idempotency keys", "ownership fencing", "compensation/recovery evidence",
      "no local WAL or projection batch makes a remote effect atomic",
      "/Users/williamcory/flows/flows/docs/architecture/implementation-status.md",
      "newSmithersPackagesResolved", "noLocalSmithersReimplementation",
      "newSmithersConnectorPackagesResolved", "noLocalConnectorRuntimeReimplementation",
      "authority-foundation", "build-local-smithers-distribution.mjs", "externalConsumerSmoke", "packageManifestWritesSerialized",
      "hostRuntimePlacement", "rendererRuntimeIsolation", "dependencyFootprintMeasured", "copy-on-write",
      "parallelLanesManifestClean", "legacyDependenciesRemoved", "dependencyManifestFinalized", "lockfileRegenerated",
    ]) expect(contract).toContain(clause);

    expect(workflowSource).toContain('const integrationRoot = pocWorktreePath("poc-integration")');
    expect(workflowSource).toContain("cloneFoundationDependencies(integrationRoot, dependencyTargets)");
    expect(await readFile(join(promptDir, "production-slice-implement.mdx"), "utf8")).toContain("copy-on-write `node_modules` clone");

    const roundPlanPrompt = await readFile(join(promptDir, "poc-round-plan.mdx"), "utf8");
    const flowsHarnessPrompt = await readFile(join(promptDir, "poc-flows-harness.mdx"), "utf8");
    const transcriptPrompt = await readFile(join(promptDir, "poc-transcript-chat-ui.mdx"), "utf8");
    for (const source of [roundPlanPrompt, flowsHarnessPrompt, transcriptPrompt]) {
      expect(source).toContain("/Users/williamcory/mvp/DESIGN.md");
    }
    expect(roundPlanPrompt).toContain("src/shared/NativeAgent.ts");
    expect(roundPlanPrompt).toContain("relevant `src/bun` bridge files");
    expect(roundPlanPrompt).toContain("prepare_poc_foundation_dependencies");
    expect(roundPlanPrompt).toContain("must not implement application transition tables");
    expect(transcriptPrompt).toContain("BacklinksPanel");
    expect(transcriptPrompt).toContain("OutlineView");
  });
});
