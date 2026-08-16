/** @jsxImportSource react */
import { useMemo, useState } from "react"
import {
  createGatewayReactRoot,
  useGatewayRun,
  useGatewayRunTree,
} from "smthrs/gateway-react"
import {
  ApprovalPanel,
  ConnectionBadge,
  NodeChatStream,
  NodeOutputView,
  RunEventLog,
  StatusPill,
  WorkflowUiShell,
  WorkflowUiStyles,
} from "smthrs/gateway-ui"
import {
  Card,
  EmptyState,
  KpiStat,
  SmithersUiStyles,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "smthrs/ui"
import type { GatewayRunNode } from "smthrs/gateway-client"

const LANES = [
  { key: "u1", title: "U1 reco card content (A-8)" },
  { key: "u2", title: "U2 Escape dismisses card (A-9)" },
  { key: "u3", title: "U3 launch overclaim" },
  { key: "u4", title: "U4 scripted deploy (dry)" },
  { key: "u5", title: "U5 invite mechanics" },
  { key: "u6", title: "U6 zero-balance UX (D-4)" },
  { key: "u7", title: "U7 headless checklist" },
  { key: "u8", title: "U8 apps-split follow-ups" },
  { key: "evals", title: "Evals suite (opus)" },
] as const

const STAGES = [
  { suffix: "Impl", label: "implement" },
  { suffix: "Review", label: "review" },
  { suffix: "Fix", label: "fix" },
  { suffix: "LandRun", label: "land" },
  { suffix: "LandVerify", label: "verify" },
  { suffix: "PolishReview", label: "polish" },
  { suffix: "PolishFix", label: "polish fix" },
] as const

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined
  return new URLSearchParams(location.search).get("runId") ?? undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Parse a node's persisted output row (JSON string or object, maybe wrapped in .row). */
function rowOf(node: GatewayRunNode | undefined): Record<string, unknown> | null {
  if (!node?.output) return null
  let value: unknown = node.output
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!isRecord(value)) return null
  if (isRecord(value.row)) return value.row
  return value
}

function col(row: Record<string, unknown> | null, camel: string): unknown {
  if (!row) return undefined
  const snake = camel.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase())
  return row[camel] ?? row[snake]
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true"
}

/** Latest row (highest iteration) for a logical node id. */
function latestNode(nodes: ReadonlyArray<GatewayRunNode>, id: string): GatewayRunNode | undefined {
  const matches = nodes.filter((n) => n.id === id)
  if (matches.length === 0) return undefined
  return matches.reduce((a, b) => ((b.iteration ?? 0) >= (a.iteration ?? 0) ? b : a))
}

function shortSha(v: unknown): string {
  return typeof v === "string" && /^[0-9a-f]{7,40}$/i.test(v) ? v.slice(0, 10) : ""
}

function LaneRow({
  lane,
  nodes,
  onSelect,
  selected,
}: {
  lane: (typeof LANES)[number]
  nodes: ReadonlyArray<GatewayRunNode>
  onSelect: (nodeId: string) => void
  selected: string | undefined
}) {
  const landCheck = rowOf(latestNode(nodes, `${lane.key}LandVerify`))
  const landed = truthy(col(landCheck, "onMain"))
  const polish = rowOf(latestNode(nodes, `${lane.key}PolishReview`))
  const lgtm = col(polish, "verdict") === "lgtm"
  return (
    <TableRow>
      <TableCell>
        <div style={{ fontWeight: 600 }}>{lane.title}</div>
        <div style={{ opacity: 0.65, fontSize: 12 }}>
          {landed ? `landed ${shortSha(col(landCheck, "verifiedTip"))}` : "not on main yet"}
          {lgtm ? " · LGTM" : ""}
        </div>
      </TableCell>
      {STAGES.map((stage) => {
        const nodeId = `${lane.key}${stage.suffix}`
        const node = latestNode(nodes, nodeId)
        return (
          <TableCell key={stage.suffix}>
            {node ? (
              <button
                type="button"
                onClick={() => onSelect(nodeId)}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  outline: selected === nodeId ? "1px solid currentColor" : "none",
                  borderRadius: 999,
                }}
                title={`${nodeId} (${stage.label})`}
              >
                <StatusPill status={node.status} />
              </button>
            ) : (
              <span style={{ opacity: 0.35 }}>—</span>
            )}
          </TableCell>
        )
      })}
    </TableRow>
  )
}

function App() {
  const runId = runIdFromUrl()
  const run = useGatewayRun(runId)
  const tree = useGatewayRunTree(runId)
  const [selected, setSelected] = useState<string | undefined>(undefined)

  const nodes = tree.nodes
  const stats = useMemo(() => {
    let landed = 0
    let lgtm = 0
    for (const lane of LANES) {
      if (truthy(col(rowOf(latestNode(nodes, `${lane.key}LandVerify`)), "onMain"))) landed += 1
      if (col(rowOf(latestNode(nodes, `${lane.key}PolishReview`)), "verdict") === "lgtm") lgtm += 1
    }
    const panelVerdict = (id: string) => {
      const v = col(rowOf(latestNode(nodes, id)), "verdict")
      return typeof v === "string" ? v : "pending"
    }
    return { landed, lgtm, codex: panelVerdict("panelCodex"), fable: panelVerdict("panelFable") }
  }, [nodes])

  const runStatus =
    isRecord(run.data) && "status" in run.data ? String((run.data as Record<string, unknown>).status) : undefined

  return (
    <WorkflowUiShell title="Alpha UI readiness" meta={`${runId ?? "no run selected"}`}>
      <WorkflowUiStyles />
      <SmithersUiStyles />
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <StatusPill status={runStatus ?? tree.status} />
        <ConnectionBadge />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: 12, marginBottom: 16 }}>
        <KpiStat label="Lanes landed" value={`${stats.landed}/${LANES.length}`} hint="verified on origin/main" />
        <KpiStat label="Polish LGTM" value={`${stats.lgtm}/${LANES.length}`} hint="post-land review converged" />
        <KpiStat label="Panel · codex sol" value={stats.codex} hint="production readiness" />
        <KpiStat label="Panel · claude fable" value={stats.fable} hint="production readiness" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 16 }}>
          <Card>
            <h2 style={{ margin: "4px 8px 8px" }}>Lanes</h2>
            {nodes.length === 0 ? (
              <EmptyState title="Waiting for the run" description="No nodes reported yet." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>lane</TableHead>
                    {STAGES.map((s) => (
                      <TableHead key={s.suffix}>{s.label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {LANES.map((lane) => (
                    <LaneRow key={lane.key} lane={lane} nodes={nodes} onSelect={setSelected} selected={selected} />
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
          <Card>
            <h2 style={{ margin: "4px 8px 8px" }}>Finale</h2>
            <Table>
              <TableBody>
                {["panelFix", "panelCodex", "panelFable", "humanTasksDoc", "humanGate"].map((id) => {
                  const node = latestNode(nodes, id)
                  return (
                    <TableRow key={id}>
                      <TableCell>{id}</TableCell>
                      <TableCell>
                        {node ? (
                          <button
                            type="button"
                            onClick={() => setSelected(id)}
                            style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
                          >
                            <StatusPill status={node.status} />
                          </button>
                        ) : (
                          <span style={{ opacity: 0.35 }}>—</span>
                        )}
                      </TableCell>
                      <TableCell style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {String(col(rowOf(node), "summary") ?? col(rowOf(node), "failures") ?? "")}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Card>
          <Card>
            <h2 style={{ margin: "4px 8px 8px" }}>Events</h2>
            <RunEventLog runId={runId} maxEvents={400} onSelectNode={(nodeId) => setSelected(nodeId)} />
          </Card>
        </div>
        <div style={{ display: "grid", gap: 16 }}>
          <Card>
            <h2 style={{ margin: "4px 8px 8px" }}>Approvals</h2>
            <ApprovalPanel
              note
              filter={runId ? { runId } : undefined}
              empty={<EmptyState title="No pending approvals" description="The human gate arms after the panel." />}
            />
          </Card>
          <Card>
            <h2 style={{ margin: "4px 8px 8px" }}>{selected ?? "Select a node"}</h2>
            {selected ? (
              <div style={{ display: "grid", gap: 12 }}>
                <NodeOutputView runId={runId} nodeId={selected} iteration={latestNode(nodes, selected)?.iteration} />
                <NodeChatStream runId={runId} nodeId={selected} />
              </div>
            ) : (
              <EmptyState title="Nothing selected" description="Click a stage pill or an event row to inspect a node." />
            )}
          </Card>
        </div>
      </div>
    </WorkflowUiShell>
  )
}

if (typeof document !== "undefined") createGatewayReactRoot(<App />)
