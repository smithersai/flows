// smithers-source: authored
// smithers-metadata-version: 1
// smithers-display-name: DESIGN Engineering Callouts
// smithers-description: Implements and reviews the backend card and approval contracts without racing the universal-runtime landing.
// smithers-tags: mvp, cards, approvals, review
/** @jsxImportSource smthrs */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Parallel, Ralph, Sequence, Task, Worktree, createSmithers, fallbackAgents } from "smthrs";
import { z } from "zod/v4";
import { providers } from "../agents";

const testReceipt = z.strictObject({
  command: z.string().min(1),
  status: z.enum(["pass", "fail", "not_run"]),
  evidence: z.string().min(1),
});

const preflightSchema = z.strictObject({
  ready: z.boolean(),
  baseRevision: z.string().regex(/^[a-f0-9]{40}$/),
  baseRef: z.string().min(1),
  designPath: z.string().min(1),
  blockers: z.array(z.string().min(1)),
  summary: z.string().min(1),
});

const implementationSchema = z.strictObject({
  readyForReview: z.boolean(),
  branch: z.string().min(1),
  commitSha: z.string().min(7).nullable(),
  changedFiles: z.array(z.string().min(1)),
  callouts: z.strictObject({
    backendCardFrames: z.boolean(),
    approvalRoundTrip: z.boolean(),
    flowNameOnCards: z.boolean(),
    agentTurnFrameWidened: z.boolean(),
  }),
  tests: z.array(testReceipt),
  blockers: z.array(z.string().min(1)),
  summary: z.string().min(1),
});

const snapshotSchema = z.strictObject({
  revisionId: z.string().regex(/^[a-f0-9]{40}$/),
  branch: z.string().min(1),
  changedFiles: z.array(z.string().min(1)),
  clean: z.literal(true),
});

const reviewIssue = z.strictObject({
  severity: z.enum(["blocker", "major", "minor"]),
  file: z.string().min(1).nullable(),
  description: z.string().min(1),
  requiredFix: z.string().min(1),
});

const reviewSchema = z.strictObject({
  reviewer: z.enum(["fable", "sol"]),
  revisionId: z.string().regex(/^[a-f0-9]{40}$/),
  approved: z.boolean(),
  signature: z.string().min(1),
  issues: z.array(reviewIssue),
  checks: z.array(testReceipt).min(1),
  summary: z.string().min(1),
}).superRefine((value, ctx) => {
  if (value.approved && value.issues.some((issue) => issue.severity !== "minor")) {
    ctx.addIssue({ code: "custom", path: ["approved"], message: "approved reviews cannot retain blocker or major issues" });
  }
  if (value.approved && value.checks.some((check) => check.status !== "pass")) {
    ctx.addIssue({ code: "custom", path: ["approved"], message: "approved reviews require passing checks" });
  }
});

const revisionSchema = z.strictObject({
  commitSha: z.string().min(7),
  fixed: z.array(z.string().min(1)),
  tests: z.array(testReceipt),
  summary: z.string().min(1),
});

const reportSchema = z.strictObject({
  ready: z.literal(true),
  branch: z.string().min(1),
  revisionId: z.string().regex(/^[a-f0-9]{40}$/),
  changedFiles: z.array(z.string().min(1)),
  landedOnMain: z.literal(false),
  summary: z.string().min(1),
});

const inputSchema = z.strictObject({
  targetRepo: z.string().min(1).default("/Users/williamcory/mvp"),
  baseRef: z.string().min(1).default("smithers/production-readiness/run-1786190116704/round-02/poc-authority-foundation"),
  baseRevision: z.string().regex(/^[a-f0-9]{40}$/).default("04c1d0f0092fbcea888bc912da55220793e82572"),
  workspaceRoot: z.string().min(1).default("/Users/williamcory/.smithers-worktrees/design-engineering-callouts"),
  maxReviewRounds: z.number().int().min(1).max(5).default(4),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  preflight: preflightSchema,
  implementation: implementationSchema,
  snapshot: snapshotSchema,
  review: reviewSchema,
  revision: revisionSchema,
  report: reportSchema,
});

const run = (cwd: string, command: string, args: string[]) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const slug = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, "-");

const preflight = (input: z.infer<typeof inputSchema>): z.infer<typeof preflightSchema> => {
  const blockers: string[] = [];
  const designPath = path.join(input.targetRepo, "DESIGN.md");
  let actualBase = input.baseRevision;
  try {
    actualBase = run(input.targetRepo, "git", ["rev-parse", input.baseRef]);
  } catch (error) {
    blockers.push(`Cannot resolve ${input.baseRef}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (actualBase !== input.baseRevision) blockers.push(`Base ref resolves to ${actualBase}, expected ${input.baseRevision}.`);
  if (!existsSync(designPath)) blockers.push(`Missing ${designPath}.`);
  for (const file of ["src/shared/NativeAgent.ts", "src/shared/NativeRPC.ts", "src/bun/CloudAgent.ts", "src/mainview/state/AppController.ts", "src/mainview/state/AppState.ts"]) {
    if (!existsSync(path.join(input.targetRepo, file))) blockers.push(`Missing ${file}.`);
  }
  return {
    ready: blockers.length === 0,
    baseRevision: input.baseRevision,
    baseRef: input.baseRef,
    designPath,
    blockers,
    summary: blockers.length === 0
      ? "Pinned the callout work to the reviewed authority-foundation commit and current DESIGN handoff."
      : "The callout lane cannot start until its base and contract files resolve.",
  };
};

const snapshot = (cwd: string, baseRevision: string): z.infer<typeof snapshotSchema> => {
  const dirty = run(cwd, "git", ["status", "--porcelain"]);
  if (dirty !== "") throw new Error(`Callout worktree is not clean:\n${dirty}`);
  const revisionId = run(cwd, "git", ["rev-parse", "HEAD"]);
  if (revisionId === baseRevision) throw new Error("Implementation did not create a commit.");
  const changed = run(cwd, "git", ["diff", "--name-only", baseRevision, revisionId]);
  return {
    revisionId,
    branch: run(cwd, "git", ["branch", "--show-current"]),
    changedFiles: changed === "" ? [] : changed.split("\n"),
    clean: true,
  };
};

const implementationPrompt = (cwd: string, branch: string, input: z.infer<typeof inputSchema>) => `
You are the Sol xhigh implementation engineer. Work only in ${cwd} on ${branch}, based on ${input.baseRevision}. Read AGENTS.md and DESIGN.md directly before editing.

Implement the four engineering callouts as one narrow end-to-end contract:
1. The Bun backend must accept valid mid-turn NDJSON {type:"card",card} and {type:"card.update",id,patch} frames from chat.smithers.sh and publish them through the native bridge. Invalid frames fail closed without ending the text stream; unknown frames remain ignored.
2. Make approval decisions perform a real typed round trip behind forwardApprovalDecision: renderer -> NativeRPC -> Bun/CloudAgent -> configured Smithers Cloud approval endpoint -> typed acknowledgement/failure. Do not freeze an ApprovalCard before a successful acknowledgement, and expose an honest retryable failure state. Never invent backend success.
3. Add a required or deliberately backward-compatible Flow name field to the canonical Card/CardPatch schema and render it in card headers. Pick one spelling (flow) across wire, state, journal, and UI.
4. Widen src/shared/NativeAgent.ts so AgentTurnFrame is the single shared union for delta, card, card.update, and done; delete the controller-local duplicate frame union.

The separate source-library fix in /Users/williamcory/smithers commit 0b451ada62ee3faa323b7b18f5bdde5f48df3254 already adds ReactNode ChatComposer sendLabel/stopLabel props. Do not edit /Users/williamcory/smithers and do not import new legacy @smthrs code into product source.

Add focused tests for split NDJSON chunks, multiple frames per chunk, malformed/unknown frames, card/update publication, Flow-name validation/rendering, approval success, rejection/network failure, duplicate clicks, and native RPC typing. Keep React projection-only and do not add useEffect. Run focused tests and TypeScript checks. Run at most one whole-product Vite build with a 360-second bound; reviewers will not repeat it. Explicitly stage only owned source/test paths, commit once, and do not push or land on main.

Return the exact typed implementation receipt. A callout is true only when code and tests prove it.
`;

const reviewPrompt = (
  reviewer: "fable" | "sol",
  cwd: string,
  input: z.infer<typeof inputSchema>,
  current: z.infer<typeof snapshotSchema>,
) => `
You are the ${reviewer === "fable" ? "Fable ultracode" : "Sol xhigh"} reviewer. Review only; do not edit files.

Review exactly ${current.revisionId} in ${cwd} against base ${input.baseRevision}. Inspect the actual diff and the current DESIGN.md. The required slice is: backend card/card.update NDJSON publication mid-turn; one canonical shared AgentTurnFrame; Flow name on cards; and an honest approval decision round trip behind forwardApprovalDecision that freezes only after acknowledgement and represents failure/retry. Preserve no-useEffect, projection-only React, typed NativeRPC, fail-closed validation, and no new legacy @smthrs dependency.

Run focused checks only; do not repeat the whole Vite build. Approve when this slice is real and tested without demanding unrelated post-demo scope. Return reviewer=${reviewer} and revisionId=${current.revisionId} exactly. Use a stable failure signature.
`;

const revisionPrompt = (
  cwd: string,
  current: z.infer<typeof snapshotSchema>,
  fable: z.infer<typeof reviewSchema> | undefined,
  sol: z.infer<typeof reviewSchema> | undefined,
) => `
You are the Sol xhigh correction engineer in ${cwd}. Fix every supported blocker and major issue in these reviews of ${current.revisionId}; do not expand scope.

Fable review:\n${JSON.stringify(fable, null, 2)}

Sol review:\n${JSON.stringify(sol, null, 2)}

Run focused tests, stage explicit paths, commit the corrections, keep the worktree clean, and do not push or land on main. Return the typed revision receipt.
`;

export default smithers((ctx) => {
  const input = inputSchema.parse(ctx.input);
  const runSlug = slug(ctx.runId);
  const worktreePath = path.join(input.workspaceRoot, runSlug);
  const branch = `agent/design-engineering-callouts/${runSlug}`;
  const gate = ctx.outputMaybe(outputs.preflight, { nodeId: "preflight" });
  const implementation = ctx.outputMaybe(outputs.implementation, { nodeId: "implement" });
  const initialSnapshot = ctx.outputMaybe(outputs.snapshot, { nodeId: "capture_initial" });
  const revisedSnapshot = ctx.latest(outputs.snapshot, "capture_revision");
  const current = revisedSnapshot ?? initialSnapshot;
  const fableReview = ctx.latest(outputs.review, "review_fable");
  const solReview = ctx.latest(outputs.review, "review_sol");
  const approved = current !== undefined
    && fableReview?.approved === true
    && solReview?.approved === true
    && fableReview.revisionId === current.revisionId
    && solReview.revisionId === current.revisionId;
  const fableAgents = fallbackAgents({
    providers: ["claude-code"],
    models: { "claude-code": "claude-fable-5" },
    fallback: [],
    seed: `${ctx.runId}:fable-review`,
  });

  return (
    <Workflow name="design-engineering-callouts">
      <Sequence>
        <Task id="preflight" output={outputs.preflight} sideEffect={{ idempotent: true }}>
          {() => preflight(input)}
        </Task>
        {gate?.ready ? (
          <Worktree path={worktreePath} branch={branch} baseBranch={input.baseRef}>
            <Sequence>
              <Task id="implement" output={outputs.implementation} agent={providers.codex1Sol} retries={2} timeoutMs={90 * 60_000} heartbeatTimeoutMs={15 * 60_000}>
                {implementationPrompt(worktreePath, branch, input)}
              </Task>
              {implementation?.readyForReview ? (
                <Task id="capture_initial" output={outputs.snapshot} dependsOn={["implement"]}>
                  {() => snapshot(worktreePath, input.baseRevision)}
                </Task>
              ) : null}
              {implementation?.readyForReview && current ? (
                <Ralph id="consensus" until={approved} maxIterations={input.maxReviewRounds} onMaxReached="fail">
                  <Sequence>
                    <Parallel id="reviews" maxConcurrency={2}>
                      <Task id="review_fable" output={outputs.review} agent={fableAgents} retries={2} timeoutMs={60 * 60_000} heartbeatTimeoutMs={15 * 60_000}>
                        {reviewPrompt("fable", worktreePath, input, current)}
                      </Task>
                      <Task id="review_sol" output={outputs.review} agent={providers.codex2Sol} retries={2} timeoutMs={60 * 60_000} heartbeatTimeoutMs={15 * 60_000}>
                        {reviewPrompt("sol", worktreePath, input, current)}
                      </Task>
                    </Parallel>
                    {!approved ? (
                      <Sequence>
                        <Task id="revise" output={outputs.revision} dependsOn={["review_fable", "review_sol"]} agent={providers.codex1Sol} retries={2} timeoutMs={60 * 60_000} heartbeatTimeoutMs={15 * 60_000}>
                          {revisionPrompt(worktreePath, current, fableReview, solReview)}
                        </Task>
                        <Task id="capture_revision" output={outputs.snapshot} dependsOn={["revise"]}>
                          {() => snapshot(worktreePath, input.baseRevision)}
                        </Task>
                      </Sequence>
                    ) : null}
                  </Sequence>
                </Ralph>
              ) : null}
              {approved && current ? (
                <Task id="final_report" output={outputs.report} dependsOn={["review_fable", "review_sol"]}>
                  {() => ({
                    ready: true as const,
                    branch: current.branch,
                    revisionId: current.revisionId,
                    changedFiles: current.changedFiles,
                    landedOnMain: false as const,
                    summary: "Both required reviewers approved the DESIGN engineering callouts. The branch remains isolated until the universal-runtime landing is complete, preventing a race on shared MVP bridge files.",
                  })}
                </Task>
              ) : null}
            </Sequence>
          </Worktree>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
