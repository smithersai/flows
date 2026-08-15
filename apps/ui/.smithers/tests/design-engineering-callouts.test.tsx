import { describe, expect, test } from "bun:test";
import path from "node:path";
import { renderWorkflow } from "smthrs/testing";
import workflow from "../workflows/design-engineering-callouts.tsx";

const workflowPath = path.join(import.meta.dir, "..", "workflows", "design-engineering-callouts.tsx");
const input = {
  targetRepo: "/Users/williamcory/mvp",
  baseRef: "smithers/production-readiness/run-1786190116704/round-02/poc-authority-foundation",
  baseRevision: "04c1d0f0092fbcea888bc912da55220793e82572",
  workspaceRoot: "/Users/williamcory/.smithers-worktrees/design-engineering-callouts-test",
  maxReviewRounds: 4,
};

type Outputs = Record<string, unknown[]>;
type Graph = Awaited<ReturnType<typeof renderWorkflow>>;

function row(nodeId: string, value: Record<string, unknown>, iteration = 0) {
  return { nodeId, iteration, ...value };
}

function ids(graph: Graph) {
  return graph.tasks.map((task) => task.nodeId);
}

function models(graph: Graph, nodeId: string) {
  const task = graph.tasks.find((candidate) => candidate.nodeId === nodeId);
  if (!task) throw new Error(`Missing task ${nodeId}`);
  const agent = task.agent;
  return (Array.isArray(agent) ? agent : agent ? [agent] : []).map((value) => (value as { model?: string }).model);
}

const preflight = {
  ready: true,
  baseRevision: input.baseRevision,
  baseRef: input.baseRef,
  designPath: "/Users/williamcory/mvp/DESIGN.md",
  blockers: [],
  summary: "ready",
};

const implementation = {
  readyForReview: true,
  branch: "agent/design-engineering-callouts/test-run",
  commitSha: "a".repeat(40),
  changedFiles: ["src/shared/NativeAgent.ts"],
  callouts: {
    backendCardFrames: true,
    approvalRoundTrip: true,
    flowNameOnCards: true,
    agentTurnFrameWidened: true,
  },
  tests: [{ command: "bun test", status: "pass", evidence: "focused tests passed" }],
  blockers: [],
  summary: "implemented",
};

const snapshot = {
  revisionId: "b".repeat(40),
  branch: implementation.branch,
  changedFiles: implementation.changedFiles,
  clean: true,
};

function review(reviewer: "fable" | "sol") {
  return {
    reviewer,
    revisionId: snapshot.revisionId,
    approved: true,
    signature: "approved",
    issues: [],
    checks: [{ command: "bun test", status: "pass", evidence: "focused tests passed" }],
    summary: "approved",
  };
}

async function render(outputs: Outputs = {}) {
  return renderWorkflow(workflow, { workflowPath, input, outputs, runId: "test-run" });
}

describe("design-engineering-callouts", () => {
  test("starts from the pinned authority base and assigns Sol xhigh", async () => {
    expect(ids(await render())).toEqual(["preflight"]);

    const graph = await render({ preflight: [row("preflight", preflight)] });
    expect(ids(graph)).toContain("implement");
    expect(models(graph, "implement")).toEqual(["gpt-5.6-sol"]);
  });

  test("requires Fable and Sol approval of the exact captured revision", async () => {
    const base: Outputs = {
      preflight: [row("preflight", preflight)],
      implementation: [row("implement", implementation)],
      snapshot: [row("capture_initial", snapshot)],
    };
    const reviewGraph = await render(base);
    expect(ids(reviewGraph)).toContain("review_fable");
    expect(ids(reviewGraph)).toContain("review_sol");
    expect(ids(reviewGraph)).toContain("revise");
    expect(models(reviewGraph, "review_fable").length).toBeGreaterThan(1);
    expect(models(reviewGraph, "review_fable").every((model) => model === "claude-fable-5")).toBe(true);
    expect(models(reviewGraph, "review_sol")).toEqual(["gpt-5.6-sol"]);

    const approved = await render({
      ...base,
      review: [row("review_fable", review("fable")), row("review_sol", review("sol"))],
    });
    expect(ids(approved)).toContain("final_report");
    expect(ids(approved)).not.toContain("revise");

    const staleSol = review("sol");
    staleSol.revisionId = "c".repeat(40);
    const stale = await render({
      ...base,
      review: [row("review_fable", review("fable")), row("review_sol", staleSol)],
    });
    expect(ids(stale)).not.toContain("final_report");
    expect(ids(stale)).toContain("revise");
  });
});
