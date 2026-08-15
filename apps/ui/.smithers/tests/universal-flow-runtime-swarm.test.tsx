import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderWorkflow } from "smthrs/testing";
import monitor from "../monitor/universal-flow-runtime-swarm.tsx";
import workflow from "../workflows/universal-flow-runtime-swarm.tsx";

const workflowPath = path.join(import.meta.dir, "..", "workflows", "universal-flow-runtime-swarm.tsx");
const monitorPath = path.join(import.meta.dir, "..", "monitor", "universal-flow-runtime-swarm.tsx");
const input = {
  goal: "Implement the universal Flow runtime.",
  workspaceRoot: "/Users/williamcory/.smithers-worktrees/universal-flow-runtime-test",
  maxReviewRounds: 3,
};

type Outputs = Record<string, unknown[]>;
type Graph = Awaited<ReturnType<typeof renderWorkflow>>;

function row(nodeId: string, value: Record<string, unknown>, iteration = 0) {
  return { nodeId, iteration, ...value };
}

function task(graph: Graph, nodeId: string) {
  const found = graph.tasks.find((candidate) => candidate.nodeId === nodeId);
  if (!found) throw new Error(`Missing task ${nodeId}`);
  return found;
}

function ids(graph: Graph) {
  return graph.tasks.map((candidate) => candidate.nodeId);
}

function models(graph: Graph, nodeId: string) {
  const agent = task(graph, nodeId).agent;
  return (Array.isArray(agent) ? agent : agent ? [agent] : []).map((value) => (value as { model?: string }).model);
}

const repositories = [
  ["mvp", "/Users/williamcory/mvp", "smithersai/mvp"],
  ["flows", "/Users/williamcory/flows/flows", "smithersai/flows"],
  ["agent", "/Users/williamcory/flows/agent", "smithersai/agent"],
  ["plue", "/Users/williamcory/plue", "smithersai/plue"],
].map(([name, sourcePath, githubRepo], index) => ({
  name,
  sourcePath,
  githubRepo,
  baseBranch: "main",
  baseSha: `${index + 1}`.repeat(40),
  dirtyFiles: 0,
}));

const preflight = {
  ready: true,
  repositories,
  githubAuthenticated: true,
  blockers: [],
  summary: "ready",
};

function workspace(lane: "fable" | "sol" | "judge") {
  const root = `${input.workspaceRoot}/test-run/${lane}`;
  const branch = `agent/universal-flow-runtime/test-run/${lane}`;
  return {
    lane,
    root,
    repositories: repositories.map((repo) => ({
      ...repo,
      worktreePath: repo.name === "mvp" ? root : `${root}/.smithers-federated/${repo.name}`,
      branch,
    })),
    summary: `${lane} workspace`,
  };
}

function changes(lane: "fable" | "sol" | "judge") {
  return repositories.map((repo) => ({
    repo: repo.name,
    status: repo.name === "agent" ? "changed" : "unchanged",
    branch: `agent/universal-flow-runtime/test-run/${lane}`,
    commitSha: repo.name === "agent" ? "a".repeat(40) : null,
    changedFiles: repo.name === "agent" ? ["packages/runtime.ts"] : [],
    summary: repo.name === "agent" ? "Implemented runtime." : "No change required.",
  }));
}

function candidate(lane: "fable" | "sol") {
  return {
    lane,
    readyForJudge: true,
    designSummary: `${lane} design`,
    executionContract: "execute(flow, input, placement, capabilities)",
    permissionModel: "Kernel-enforced Host capabilities",
    placementModel: "client/local/remote/sandbox",
    decisions: [{ title: "One runner", decision: "Use placement adapters", rationale: "Keeps Flow code portable" }],
    changes: changes(lane),
    tests: [{ repo: "agent", command: "bun test", status: "pass", summary: "passed" }],
    blockers: [],
  };
}

function mirror(lane: "fable" | "sol" | "judge") {
  return {
    lane,
    success: true,
    prs: repositories.map((repo, index) => ({
      lane,
      repo: repo.name,
      branch: `agent/universal-flow-runtime/test-run/${lane}`,
      status: repo.name === "agent" ? "opened" : "skipped",
      number: repo.name === "agent" ? index + 1 : null,
      url: repo.name === "agent" ? `https://github.com/${repo.githubRepo}/pull/${index + 1}` : null,
      reason: repo.name === "agent" ? null : "No changes.",
    })),
    blockers: [],
    summary: "mirrored",
  };
}

const synthesis = {
  readyForReview: true,
  designSummary: "Synthesized design",
  executionContract: "execute(flow, input, placement, capabilities)",
  permissionModel: "Kernel-enforced Host capabilities",
  placementModel: "client/local/remote/sandbox",
  selectedFromFable: ["browser-safe QuickJS"],
  selectedFromSol: ["durable placement runner"],
  improvedDecisions: [{ title: "One runner", decision: "Use placement adapters", rationale: "One contract" }],
  changes: changes("judge"),
  tests: [{ repo: "agent", command: "bun test", status: "pass", summary: "passed" }],
  blockers: [],
};

const snapshot = {
  revisionId: repositories.map((repo) => `${repo.name}:${"b".repeat(40)}`).join("|"),
  heads: repositories.map((repo) => ({ repo: repo.name, sha: "b".repeat(40) })),
};

function approvedReview(reviewer: "fable" | "sol") {
  return {
    reviewer,
    revisionId: snapshot.revisionId,
    approved: true,
    signature: "approved",
    issues: [],
    checks: [{ command: "bun test", status: "pass", evidence: "all focused tests passed" }],
    summary: "approved",
  };
}

async function render(outputs: Outputs = {}) {
  return renderWorkflow(workflow, { workflowPath, input, outputs, runId: "test-run" });
}

describe("universal-flow-runtime-swarm", () => {
  test("fans out Fable ultracode and Sol xhigh into isolated worktrees", async () => {
    const initial = await render();
    expect(ids(initial)).toEqual(["preflight"]);

    const graph = await render({ preflight: [row("preflight", preflight)] });
    for (const nodeId of ["prepare_fable", "candidate_fable", "mirror_fable", "prepare_sol", "candidate_sol", "mirror_sol"]) {
      expect(ids(graph)).toContain(nodeId);
    }
    expect(models(graph, "candidate_fable").length).toBeGreaterThan(1);
    expect(models(graph, "candidate_fable").every((model) => model === "claude-fable-5")).toBe(true);
    expect(models(graph, "candidate_sol")).toEqual(["gpt-5.6-sol"]);
    expect(task(graph, "candidate_fable").worktreePath).not.toEqual(task(graph, "candidate_sol").worktreePath);
    expect(task(graph, "candidate_fable").dependsOn).toContain("prepare_fable");
    expect(task(graph, "mirror_fable").dependsOn).toContain("candidate_fable");
    const source = await readFile(workflowPath, "utf8");
    expect(source).toContain('lane === "fable" ? "ultracode"');
    expect(source).toContain("providers.codex1Sol");
  });

  test("gives the judge both typed candidates and starts a two-model consensus loop", async () => {
    const outputs: Outputs = {
      preflight: [row("preflight", preflight)],
      workspace: [row("prepare_fable", workspace("fable")), row("prepare_sol", workspace("sol")), row("prepare_judge", workspace("judge"))],
      candidate: [row("candidate_fable", candidate("fable")), row("candidate_sol", candidate("sol"))],
      mirror: [row("mirror_fable", mirror("fable")), row("mirror_sol", mirror("sol")), row("mirror_judge", mirror("judge"))],
      synthesis: [row("synthesize", synthesis)],
      snapshot: [row("capture_initial", snapshot)],
    };
    const graph = await render(outputs);
    expect(ids(graph)).toContain("synthesize");
    expect(models(graph, "synthesize")).toEqual(["claude-opus-5"]);
    expect(ids(graph)).toContain("review_fable");
    expect(ids(graph)).toContain("review_sol");
    expect(ids(graph)).toContain("revise_synthesis");
    expect(ids(graph)).toContain("capture_revision");
    expect(models(graph, "review_fable").length).toBeGreaterThan(1);
    expect(models(graph, "review_fable").every((model) => model === "claude-fable-5")).toBe(true);
    expect(models(graph, "review_sol")).toEqual(["gpt-5.6-sol"]);
    expect(models(graph, "revise_synthesis")).toEqual(["claude-opus-5"]);
    expect(ids(graph)).not.toContain("land");
  });

  test("lands only when both reviewers approve the exact current revision", async () => {
    const base: Outputs = {
      preflight: [row("preflight", preflight)],
      workspace: [row("prepare_fable", workspace("fable")), row("prepare_sol", workspace("sol")), row("prepare_judge", workspace("judge"))],
      candidate: [row("candidate_fable", candidate("fable")), row("candidate_sol", candidate("sol"))],
      mirror: [row("mirror_fable", mirror("fable")), row("mirror_sol", mirror("sol")), row("mirror_judge", mirror("judge"))],
      synthesis: [row("synthesize", synthesis)],
      snapshot: [row("capture_initial", snapshot)],
      review: [row("review_fable", approvedReview("fable")), row("review_sol", approvedReview("sol"))],
    };
    const approved = await render(base);
    expect(ids(approved)).toContain("land");
    expect(task(approved, "land").dependsOn).toEqual(["review_fable", "review_sol"]);

    const stale = structuredClone(base);
    (stale.review[1] as { revisionId: string }).revisionId = "stale-revision";
    const rejected = await render(stale);
    expect(ids(rejected)).not.toContain("land");
    expect(ids(rejected)).toContain("revise_synthesis");
  });

  test("uses strict output contracts and ships an automatic monitor", async () => {
    const graph = await render({ preflight: [row("preflight", preflight)] });
    const valid = candidate("fable");
    expect(task(graph, "candidate_fable").outputSchema.safeParse(valid).success).toBe(true);
    expect(task(graph, "candidate_fable").outputSchema.safeParse({ ...valid, surprise: true }).success).toBe(false);

    const judgeGraph = await render({
      preflight: [row("preflight", preflight)],
      candidate: [row("candidate_fable", candidate("fable")), row("candidate_sol", candidate("sol"))],
      mirror: [row("mirror_fable", mirror("fable")), row("mirror_sol", mirror("sol"))],
    });
    expect(task(judgeGraph, "synthesize").outputSchema.safeParse(synthesis).success).toBe(true);

    const monitorGraph = await renderWorkflow(monitor, {
      workflowPath: monitorPath,
      input: { watchRunId: "test-run" },
      runId: "monitor-test",
    });
    expect(monitorGraph.tasks.length).toBeGreaterThan(0);
  });
});
