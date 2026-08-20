/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { createGatewayReactRoot, useGatewayNodeOutput, useGatewayRunEvents, useGatewayRuns } from "smthrs/gateway-react";
import { ConnectionBadge, NodeOutputView, RunEventLog, RunTree, StatusPill, WorkflowUiShell } from "smthrs/gateway-ui";
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, KpiStat, SectionHeader, SmithersUiStyles, StageStrip, Tabs, TabsContent, TabsList, TabsTrigger } from "smthrs/ui";

const WORKFLOW_KEY = "production-readiness-swarm";
type Row = Record<string, unknown>;
type RunSummary = { runId: string; workflowKey?: string; status?: string };

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;
const rowOf = (value: unknown): Row => {
  if (!isRow(value)) return {};
  return isRow(value.row) ? value.row : value;
};
const runIdFromUrl = () => typeof location === "undefined" ? undefined : new URLSearchParams(location.search).get("runId") ?? undefined;

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const runsQuery = useGatewayRuns({ filter: { limit: 30 } });
  const runs = useMemo(() => ((runsQuery.data ?? []) as RunSummary[]).filter((run) => !run.workflowKey || run.workflowKey === WORKFLOW_KEY), [runsQuery.data]);
  const runId = selectedRunId ?? runs[0]?.runId;
  const events = useGatewayRunEvents(runId, { afterSeq: undefined, maxEvents: 2000 });
  const pocPreparation = useGatewayNodeOutput({ runId, nodeId: "prepare_poc_worktrees" });
  const planValidation = useGatewayNodeOutput({ runId, nodeId: "validate_poc_round_plan" });
  const foundationBootstrap = useGatewayNodeOutput({ runId, nodeId: "prepare_poc_foundation_dependencies" });
  const authorityFoundation = useGatewayNodeOutput({ runId, nodeId: "poc_authority_foundation" });
  const roundBase = useGatewayNodeOutput({ runId, nodeId: "prepare_poc_round_base" });
  const pocIntegration = useGatewayNodeOutput({ runId, nodeId: "poc_integrate_verify" });
  const pocGate = useGatewayNodeOutput({ runId, nodeId: "poc_gate" });
  const productionGate = useGatewayNodeOutput({ runId, nodeId: "production_gate" });
  const reviewGate = useGatewayNodeOutput({ runId, nodeId: "review_gate" });
  const architecture = useGatewayNodeOutput({ runId, nodeId: "final_architecture_update" });
  const finalVerify = useGatewayNodeOutput({ runId, nodeId: "final_verify" });
  const release = useGatewayNodeOutput({ runId, nodeId: "release_readiness" });
  const pocRow = rowOf(pocGate.data);
  const pocPreparationRow = rowOf(pocPreparation.data);
  const planValidationRow = rowOf(planValidation.data);
  const bootstrapRow = rowOf(foundationBootstrap.data);
  const foundationRow = rowOf(authorityFoundation.data);
  const roundBaseRow = rowOf(roundBase.data);
  const integrationRow = rowOf(pocIntegration.data);
  const footprint = isRow(bootstrapRow.dependencyFootprint) ? bootstrapRow.dependencyFootprint : isRow(foundationRow.dependencyFootprint) ? foundationRow.dependencyFootprint : {};
  const foundationAssertions = isRow(foundationRow.assertions) ? foundationRow.assertions : {};
  const productionRow = rowOf(productionGate.data);
  const reviewRow = rowOf(reviewGate.data);
  const architectureRow = rowOf(architecture.data);
  const finalRow = rowOf(finalVerify.data);
  const verdict = rowOf(release.data);
  const stages = [
    { label: "Plan contract", status: String(planValidationRow.status ?? "pending") },
    { label: "Package bootstrap", status: String(bootstrapRow.status ?? "pending") },
    { label: "Authority foundation", status: String(roundBaseRow.status ?? foundationRow.status ?? "pending") },
    { label: "Manifest finalization", status: String(integrationRow.status ?? "pending") },
    { label: "POC proof", status: String(pocRow.status ?? "pending") },
    { label: "Production E2E", status: String(productionRow.status ?? "pending") },
    { label: "Post-E2E review", status: String(reviewRow.status ?? "pending") },
    { label: "Final verification", status: String(finalRow.status ?? "pending") },
    { label: "Release", status: String(verdict.status ?? "pending") },
  ];

  return <WorkflowUiShell
    title="Production Readiness Swarm"
    testId="production-readiness-swarm-ui"
    meta={<><ConnectionBadge /><StatusPill status={String(verdict.status ?? "pending")} /></>}
  >
    <SmithersUiStyles />
    <div style={{ display: "grid", gap: 16 }}>
      <Card>
        <CardHeader><CardTitle>Evidence-gated path to release</CardTitle></CardHeader>
        <CardContent><StageStrip stages={stages} showSummary summaryLabel="Typed gates" /></CardContent>
      </Card>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
        <KpiStat label="Release verdict" value={String(verdict.status ?? "—")} />
        <KpiStat label="Pinned baseline" value={String(pocPreparationRow.baseRevision ?? "—").slice(0, 10)} />
        <KpiStat label="Machine-safe ownership" value={planValidationRow.valid === true ? "proven" : planValidationRow.status ? "repairing" : "—"} />
        <KpiStat label="Authority base" value={String(roundBaseRow.baseRevision ?? foundationRow.commitSha ?? "—").slice(0, 10)} />
        <KpiStat label="Real Smithers packages" value={String(Array.isArray((bootstrapRow.distributionManifest as Row | undefined)?.packages) ? ((bootstrapRow.distributionManifest as Row).packages as unknown[]).length : Array.isArray((foundationRow.distributionManifest as Row | undefined)?.packages) ? ((foundationRow.distributionManifest as Row).packages as unknown[]).length : "—")} />
        <KpiStat label="Dependency footprint" value={typeof footprint.installedBytes === "number" ? `${Math.round(footprint.installedBytes / 1024 / 1024)} MiB` : "—"} />
        <KpiStat label="Live host seam" value={foundationAssertions.hostRuntimePlacement === true && foundationAssertions.rendererRuntimeIsolation === true ? "proven" : foundationRow.status ? "pending proof" : "—"} />
        <KpiStat label="Legacy dependency cleanup" value={integrationRow.legacyDependenciesRemoved === true && integrationRow.lockfileRegenerated === true ? "proven" : integrationRow.status ? "pending proof" : "—"} />
        <KpiStat label="Architecture score" value={String(verdict.architectureScore ?? architectureRow.architectureScore ?? "—")} />
        <KpiStat label="Final E2E" value={String(finalRow.status ?? verdict.e2eStatus ?? "—")} />
        <KpiStat label="Evidence events" value={String(events.events?.length ?? 0)} />
      </div>
      {!runId ? <EmptyState title="No readiness run" description="Launch this workflow to stream typed evidence, convergence gates, and the release verdict." /> : <Tabs defaultValue="verdict">
        <TabsList>
          <TabsTrigger value="verdict">Verdict</TabsTrigger>
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
          <TabsTrigger value="architecture">Architecture</TabsTrigger>
          <TabsTrigger value="operations">Operations</TabsTrigger>
        </TabsList>
        <TabsContent value="verdict">
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,2fr) minmax(260px,1fr)", gap: 16 }}>
            <Card><CardHeader><CardTitle>Derived release receipt</CardTitle></CardHeader><CardContent><NodeOutputView runId={runId} nodeId="release_readiness" /></CardContent></Card>
            <Card><CardHeader><CardTitle>Safety invariants</CardTitle></CardHeader><CardContent><p>Work stays on run-scoped branches and worktrees. The workflow never force-pushes or lands on main, and product imports are gated to new <code>@smithers/*</code> implementations.</p></CardContent></Card>
          </div>
        </TabsContent>
        <TabsContent value="evidence">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16 }}>
            {["validate_poc_round_plan", "prepare_poc_foundation_dependencies", "poc_authority_foundation", "prepare_poc_round_base", "poc_integrate_verify", "poc_gate", "production_gate", "review_gate", "final_verify"].map((nodeId) => <Card key={nodeId}><CardHeader><CardTitle>{nodeId.replaceAll("_", " ")}</CardTitle></CardHeader><CardContent><NodeOutputView runId={runId} nodeId={nodeId} /></CardContent></Card>)}
          </div>
        </TabsContent>
        <TabsContent value="architecture">
          <Card><CardHeader><CardTitle>Architecture site, file tree, pseudocode, and score</CardTitle></CardHeader><CardContent><NodeOutputView runId={runId} nodeId="final_architecture_update" /></CardContent></Card>
        </TabsContent>
        <TabsContent value="operations">
          <div style={{ display: "grid", gridTemplateColumns: "minmax(320px,1fr) minmax(320px,1fr)", gap: 16 }}>
            <Card><CardHeader><CardTitle>Pinned POC checkouts</CardTitle></CardHeader><CardContent><NodeOutputView runId={runId} nodeId="prepare_poc_worktrees" /></CardContent></Card>
            <Card><CardHeader><CardTitle>POC ownership repair loop</CardTitle></CardHeader><CardContent><NodeOutputView runId={runId} nodeId="validate_poc_round_plan" /></CardContent></Card>
            <Card><CardHeader><CardTitle>Deterministic package closure</CardTitle></CardHeader><CardContent><NodeOutputView runId={runId} nodeId="prepare_poc_foundation_dependencies" /></CardContent></Card>
            <Card><CardHeader><CardTitle>Serial authority composition</CardTitle></CardHeader><CardContent><NodeOutputView runId={runId} nodeId="poc_authority_foundation" /></CardContent></Card>
            <Card><CardHeader><CardTitle>Foundation-inherited round base</CardTitle></CardHeader><CardContent><NodeOutputView runId={runId} nodeId="prepare_poc_round_base" /></CardContent></Card>
            <Card><CardHeader><CardTitle>Serial integration and manifest cleanup</CardTitle></CardHeader><CardContent><NodeOutputView runId={runId} nodeId="poc_integrate_verify" /></CardContent></Card>
            <Card><CardHeader><CardTitle>Production-wave checkouts</CardTitle></CardHeader><CardContent><NodeOutputView runId={runId} nodeId="prepare_production_worktrees" /></CardContent></Card>
            <Card><CardHeader><CardTitle>Durable stage tree</CardTitle></CardHeader><CardContent><RunTree runId={runId} /></CardContent></Card>
            <Card><CardHeader><CardTitle>Live tests and agent events</CardTitle></CardHeader><CardContent><RunEventLog runId={runId} /></CardContent></Card>
          </div>
        </TabsContent>
      </Tabs>}
      <section>
        <SectionHeader title="Recent production-readiness runs" />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {runs.map((run) => <Button key={run.runId} size="sm" variant={run.runId === runId ? "default" : "outline"} onClick={() => setSelectedRunId(run.runId)} aria-pressed={run.runId === runId}>{run.runId.slice(0, 8)} <StatusPill status={run.status ?? "unknown"} /></Button>)}
        </div>
      </section>
    </div>
  </WorkflowUiShell>;
}

createGatewayReactRoot(<App />);
