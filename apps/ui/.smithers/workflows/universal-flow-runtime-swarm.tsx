// smithers-source: authored
// smithers-metadata-version: 1
// smithers-display-name: Universal Flow Runtime Swarm
// smithers-description: Competes two cross-runtime implementations, synthesizes them, reviews to consensus, lands locally, and keeps GitHub PRs as mirrors only.
// smithers-tags: architecture, flows, worktrees, review
/** @jsxImportSource smthrs */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Parallel, Ralph, Sequence, Task, Worktree, createSmithers, fallbackAgents } from "smthrs";
import { z } from "zod/v4";
import { providers } from "../agents";

const repoName = z.enum(["mvp", "flows", "agent", "plue"]);
const laneName = z.enum(["fable", "sol", "judge"]);
const checkStatus = z.enum(["pass", "fail", "not_run"]);

const repository = z.strictObject({
  name: repoName,
  sourcePath: z.string().min(1),
  githubRepo: z.string().min(1),
  baseBranch: z.literal("main"),
  baseSha: z.string().min(7),
  dirtyFiles: z.number().int().nonnegative(),
});

const workspaceRepository = repository.extend({
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
});

const preflightSchema = z.strictObject({
  ready: z.boolean(),
  repositories: z.array(repository).length(4),
  githubAuthenticated: z.boolean(),
  blockers: z.array(z.string().min(1)),
  summary: z.string().min(1),
});

const workspaceSchema = z.strictObject({
  lane: laneName,
  root: z.string().min(1),
  repositories: z.array(workspaceRepository).length(4),
  summary: z.string().min(1),
});

const decision = z.strictObject({
  title: z.string().min(1),
  decision: z.string().min(1),
  rationale: z.string().min(1),
});

const testReceipt = z.strictObject({
  repo: repoName,
  command: z.string().min(1),
  status: checkStatus,
  summary: z.string().min(1),
});

const repoChange = z.strictObject({
  repo: repoName,
  status: z.enum(["changed", "unchanged", "blocked"]),
  branch: z.string().min(1),
  commitSha: z.string().min(7).nullable(),
  changedFiles: z.array(z.string().min(1)),
  summary: z.string().min(1),
});

const candidateSchema = z.strictObject({
  lane: z.enum(["fable", "sol"]),
  readyForJudge: z.boolean(),
  designSummary: z.string().min(1),
  executionContract: z.string().min(1),
  permissionModel: z.string().min(1),
  placementModel: z.string().min(1),
  decisions: z.array(decision).min(1),
  changes: z.array(repoChange).length(4),
  tests: z.array(testReceipt),
  blockers: z.array(z.string().min(1)),
});

const synthesisSchema = z.strictObject({
  readyForReview: z.boolean(),
  designSummary: z.string().min(1),
  executionContract: z.string().min(1),
  permissionModel: z.string().min(1),
  placementModel: z.string().min(1),
  selectedFromFable: z.array(z.string().min(1)),
  selectedFromSol: z.array(z.string().min(1)),
  improvedDecisions: z.array(decision).min(1),
  changes: z.array(repoChange).length(4),
  tests: z.array(testReceipt),
  blockers: z.array(z.string().min(1)),
});

const prReceipt = z.strictObject({
  lane: laneName,
  repo: repoName,
  branch: z.string().min(1),
  status: z.enum(["opened", "existing", "skipped"]),
  number: z.number().int().positive().nullable(),
  url: z.string().nullable(),
  reason: z.string().nullable(),
});

const mirrorSchema = z.strictObject({
  lane: laneName,
  success: z.boolean(),
  prs: z.array(prReceipt),
  blockers: z.array(z.string().min(1)),
  summary: z.string().min(1),
});

const snapshotSchema = z.strictObject({
  revisionId: z.string().min(7),
  heads: z.array(z.strictObject({ repo: repoName, sha: z.string().min(7) })).length(4),
});

const reviewIssue = z.strictObject({
  severity: z.enum(["blocker", "major", "minor"]),
  repo: repoName,
  file: z.string().nullable(),
  description: z.string().min(1),
  requiredFix: z.string().min(1),
});

const reviewSchema = z
  .strictObject({
    reviewer: z.enum(["fable", "sol"]),
    revisionId: z.string().min(7),
    approved: z.boolean(),
    signature: z.string().min(1),
    issues: z.array(reviewIssue),
    checks: z.array(z.strictObject({ command: z.string().min(1), status: checkStatus, evidence: z.string().min(1) })).min(1),
    summary: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.approved && value.issues.some((issue) => issue.severity !== "minor")) {
      ctx.addIssue({ code: "custom", path: ["approved"], message: "approved reviews cannot contain blocker or major issues" });
    }
    if (value.approved && value.checks.some((check) => check.status !== "pass")) {
      ctx.addIssue({ code: "custom", path: ["approved"], message: "approved reviews require every declared check to pass" });
    }
  });

const revisionSchema = z.strictObject({
  summary: z.string().min(1),
  resolvedSignatures: z.array(z.string().min(1)),
  changes: z.array(repoChange).length(4),
  tests: z.array(testReceipt),
  blockers: z.array(z.string().min(1)),
});

const landSchema = z.strictObject({
  landed: z.boolean(),
  repositories: z.array(
    z.strictObject({ repo: repoName, changed: z.boolean(), mainSha: z.string().min(7), pushed: z.boolean() }),
  ).length(4),
  monorepoSha: z.string().min(7).nullable(),
  closedPrs: z.array(z.strictObject({ repo: repoName, number: z.number().int().positive() })),
  blockers: z.array(z.string().min(1)),
  summary: z.string().min(1),
});

const reportSchema = z.strictObject({
  reportPath: z.string().min(1),
  landed: z.boolean(),
  summary: z.string().min(1),
});

const inputSchema = z.strictObject({
  goal: z
    .string()
    .min(1)
    .default(
      "Implement one capability-scoped Flow execution contract across a browser Service Worker, Cloudflare Worker, local Bun host, and Smithers Cloud/Plue sandbox. Reuse the new Host, Placement, Kernel, QuickJS, Journal, Engine, and Harness abstractions; do not create a second orchestration system.",
    ),
  workspaceRoot: z.string().min(1).default("/Users/williamcory/.smithers-worktrees/universal-flow-runtime"),
  maxReviewRounds: z.number().int().min(1).max(6).default(5),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  preflight: preflightSchema,
  workspace: workspaceSchema,
  candidate: candidateSchema,
  synthesis: synthesisSchema,
  mirror: mirrorSchema,
  snapshot: snapshotSchema,
  review: reviewSchema,
  revision: revisionSchema,
  land: landSchema,
  report: reportSchema,
});

type Repo = z.infer<typeof repoName>;
type Lane = z.infer<typeof laneName>;
type Repository = z.infer<typeof repository>;
type Workspace = z.infer<typeof workspaceSchema>;
type Mirror = z.infer<typeof mirrorSchema>;

const SOURCE_REPOSITORIES: ReadonlyArray<Omit<Repository, "baseSha" | "dirtyFiles"> & { readonly baseRef: string }> = [
  { name: "mvp", sourcePath: "/Users/williamcory/mvp", githubRepo: "smithersai/mvp", baseBranch: "main", baseRef: "main" },
  { name: "flows", sourcePath: "/Users/williamcory/flows/flows", githubRepo: "smithersai/flows", baseBranch: "main", baseRef: "main" },
  { name: "agent", sourcePath: "/Users/williamcory/flows/agent", githubRepo: "smithersai/agent", baseBranch: "main", baseRef: "main" },
  { name: "plue", sourcePath: "/Users/williamcory/plue", githubRepo: "smithersai/plue", baseBranch: "main", baseRef: "HEAD" },
] as const;

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80) || "run";
}

function run(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  }).trim();
}

function tryRun(cwd: string, command: string, args: string[]) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
}

function branchFor(runSlug: string, lane: Lane): string {
  return `agent/universal-flow-runtime/${runSlug}/${lane}`;
}

function inspectPreflight(): z.infer<typeof preflightSchema> {
  const auth = tryRun(process.cwd(), "gh", ["auth", "status"]);
  const repositories = SOURCE_REPOSITORIES.map((spec) => ({
    name: spec.name,
    sourcePath: spec.sourcePath,
    githubRepo: spec.githubRepo,
    baseBranch: spec.baseBranch,
    baseSha: run(spec.sourcePath, "git", ["rev-parse", spec.baseRef]),
    dirtyFiles: run(spec.sourcePath, "git", ["status", "--porcelain"])
      .split("\n")
      .filter(Boolean).length,
  }));
  const blockers = [
    ...(auth.status === 0 ? [] : ["GitHub CLI is not authenticated."]),
    ...repositories.flatMap((repo) =>
      existsSync(repo.sourcePath) ? [] : [`Missing source repository: ${repo.sourcePath}`],
    ),
  ];
  return {
    ready: blockers.length === 0,
    repositories,
    githubAuthenticated: auth.status === 0,
    blockers,
    summary: blockers.length === 0
      ? "Pinned all four source repositories and verified GitHub authentication. Dirty source checkouts will remain untouched."
      : "Preflight is blocked.",
  };
}

function ensureNestedWorktree(source: Repository, target: string, branch: string): void {
  if (existsSync(target)) {
    const actual = tryRun(target, "git", ["rev-parse", "--show-toplevel"]);
    if (actual.status !== 0) throw new Error(`Existing path is not a worktree: ${target}`);
    return;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const branchExists = tryRun(source.sourcePath, "git", ["show-ref", "--verify", `refs/heads/${branch}`]).status === 0;
  run(
    source.sourcePath,
    "git",
    branchExists
      ? ["worktree", "add", target, branch]
      : ["worktree", "add", "-b", branch, target, source.baseSha],
  );
}

function prepareWorkspace(lane: Lane, root: string, branch: string, sources: Repository[]): Workspace {
  mkdirSync(root, { recursive: true });
  const mvp = sources.find((repo) => repo.name === "mvp");
  if (!mvp) throw new Error("MVP repository missing from preflight.");
  const actualRoot = run(root, "git", ["rev-parse", "--show-toplevel"]);
  if (path.resolve(actualRoot) !== path.resolve(root)) throw new Error(`Unexpected MVP worktree root: ${actualRoot}`);

  const excludePath = run(root, "git", ["rev-parse", "--git-path", "info/exclude"]);
  const exclude = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (!exclude.includes(".smithers-federated/")) appendFileSync(excludePath, "\n.smithers-federated/\n");

  const repositories = sources.map((repo) => {
    const worktreePath = repo.name === "mvp" ? root : path.join(root, ".smithers-federated", repo.name);
    if (repo.name !== "mvp") ensureNestedWorktree(repo, worktreePath, branch);
    return { ...repo, worktreePath, branch };
  });
  return { lane, root, repositories, summary: `Prepared isolated ${lane} worktrees for all four repositories.` };
}

function heads(workspace: Workspace): z.infer<typeof snapshotSchema> {
  const values = workspace.repositories.map((repo) => ({ repo: repo.name, sha: run(repo.worktreePath, "git", ["rev-parse", "HEAD"]) }));
  const revisionId = values.map((value) => `${value.repo}:${value.sha}`).join("|");
  return { revisionId, heads: values };
}

function mirrorLane(workspace: Workspace): Mirror {
  const prs: z.infer<typeof prReceipt>[] = [];
  const blockers: string[] = [];
  for (const repo of workspace.repositories) {
    const dirty = run(repo.worktreePath, "git", ["status", "--porcelain"]);
    if (dirty) {
      blockers.push(`${repo.name} has uncommitted changes in ${workspace.lane} worktree.`);
      continue;
    }
    const changed = tryRun(repo.worktreePath, "git", ["diff", "--quiet", repo.baseSha, "HEAD", "--", "."]).status !== 0;
    if (!changed) {
      prs.push({ lane: workspace.lane, repo: repo.name, branch: repo.branch, status: "skipped", number: null, url: null, reason: "No changes." });
      continue;
    }
    try {
      run(repo.worktreePath, "git", ["push", "--set-upstream", "origin", repo.branch]);
      const existing = tryRun(repo.worktreePath, "gh", ["pr", "view", repo.branch, "--repo", repo.githubRepo, "--json", "number,url,state"]);
      if (existing.status === 0) {
        const parsed = JSON.parse(existing.stdout) as { number: number; url: string };
        prs.push({ lane: workspace.lane, repo: repo.name, branch: repo.branch, status: "existing", number: parsed.number, url: parsed.url, reason: null });
        continue;
      }
      const title = `WIP mirror: universal Flow runtime (${workspace.lane})`;
      const body = [
        "This draft PR is a mirror of local Smithers worktree progress.",
        "",
        "Do not merge this PR on GitHub. The synthesized result will be reviewed, merged in a clean local clone, pushed to main, and this mirror will be closed.",
      ].join("\n");
      const url = run(repo.worktreePath, "gh", ["pr", "create", "--draft", "--repo", repo.githubRepo, "--base", repo.baseBranch, "--head", repo.branch, "--title", title, "--body", body]);
      const parsed = JSON.parse(run(repo.worktreePath, "gh", ["pr", "view", url, "--repo", repo.githubRepo, "--json", "number,url"])) as { number: number; url: string };
      prs.push({ lane: workspace.lane, repo: repo.name, branch: repo.branch, status: "opened", number: parsed.number, url: parsed.url, reason: null });
    } catch (error) {
      blockers.push(`${repo.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    lane: workspace.lane,
    success: blockers.length === 0,
    prs,
    blockers,
    summary: blockers.length === 0 ? `Published ${workspace.lane} mirror branches and draft PRs.` : `Failed to publish every ${workspace.lane} mirror.`,
  };
}

function workspacePrompt(workspace: Workspace): string {
  return workspace.repositories
    .map((repo) => `- ${repo.name}: ${repo.worktreePath} (branch ${repo.branch}, base ${repo.baseSha})`)
    .join("\n");
}

function candidatePrompt(lane: "fable" | "sol", goal: string, workspace: Workspace): string {
  return [
    lane === "fable" ? "ultracode" : "",
    `You are the ${lane === "fable" ? "Claude Fable ultracode" : "Codex Sol xhigh"} lead architect and implementer.`,
    goal,
    "Independently design the smallest coherent architecture, then implement it in your isolated worktrees. Do not merely write a plan.",
    "The required invariant is one Flow definition and one capability envelope across client Service Worker, local Bun, Cloudflare Worker, and Smithers Cloud/Plue sandbox placement. Reuse current @smithers Host, Placement, Kernel, QuickJS, Journal, Engine, Control, and Harness contracts. Do not port legacy @smthrs runtime code or create a second orchestration engine.",
    "Read every repository's AGENTS.md/CLAUDE.md before editing. Treat /Users/williamcory/Smithers-Ops and /Users/williamcory/smithers as read-only evidence. Keep proposals labelled as proposals.",
    "Work only in these worktrees; never edit the source checkouts:",
    workspacePrompt(workspace),
    "Implement the narrowest end-to-end vertical slice justified by source. Add focused tests. Commit every changed repository to its existing lane branch with explicit path staging. Do not push; the next deterministic step creates mirror PRs.",
    `Return lane=${lane} exactly. Report all four repositories, including unchanged ones, and include the final design plus the changes and tests that taught you whether it works.`,
  ].filter(Boolean).join("\n\n");
}

function synthesisPrompt(goal: string, workspace: Workspace, fable: unknown, sol: unknown): string {
  return [
    "You are the independent synthesis judge. Implement the best architecture, not a compromise average.",
    goal,
    "You have both candidates' typed designs below. Their branches are visible from each corresponding repository in your judge worktrees; inspect their commits and diffs directly before deciding.",
    `Fable candidate:\n${JSON.stringify(fable, null, 2)}`,
    `Sol candidate:\n${JSON.stringify(sol, null, 2)}`,
    "Judge worktrees:",
    workspacePrompt(workspace),
    "Select the strongest invariants from each candidate, correct their mistakes, and implement a simpler synthesized design in the judge branches. You may cherry-pick individual commits or reimplement, but do not merge candidate branches wholesale. Run focused tests and commit every changed repository. Do not push; the mirror step follows.",
    "Report all four repositories and clearly state what came from Fable, what came from Sol, and what you improved.",
  ].join("\n\n");
}

function reviewPrompt(reviewer: "fable" | "sol", goal: string, workspace: Workspace, synthesis: unknown, snapshot: z.infer<typeof snapshotSchema>): string {
  return [
    reviewer === "fable" ? "ultracode" : "",
    `You are the ${reviewer === "fable" ? "Claude Fable ultracode" : "Codex Sol xhigh"} reviewer. Review only; do not edit files.`,
    goal,
    `Review revisionId=${snapshot.revisionId} exactly.`,
    `Synthesized design:\n${JSON.stringify(synthesis, null, 2)}`,
    "Judge worktrees:",
    workspacePrompt(workspace),
    "Inspect the actual diff from each repository's baseSha to HEAD and run the most relevant focused checks. Approve only when the architecture is one placement-neutral runtime, code validation is explicit, capabilities are minimal and Host-enforced, lifecycle/durability are correct for each environment, and tests prove the implemented slice. Do not demand speculative feature breadth.",
    `Return reviewer=${reviewer} and revisionId=${snapshot.revisionId} exactly. Use a stable failure signature so three repeated signatures can be recognized.`,
  ].filter(Boolean).join("\n\n");
}

function revisionPrompt(workspace: Workspace, fableReview: unknown, solReview: unknown): string {
  return [
    "Revise the synthesized implementation as its judge/owner.",
    `Fable review:\n${JSON.stringify(fableReview, null, 2)}`,
    `Sol review:\n${JSON.stringify(solReview, null, 2)}`,
    "Judge worktrees:",
    workspacePrompt(workspace),
    "Resolve every blocker and major issue supported by source evidence. If the same signature has recurred three times, change strategy instead of repeating the same patch. Run focused tests, commit every changed repository, and push the existing judge branches so their draft mirror PRs stay current.",
    "Report all four repositories, including unchanged ones, and the exact signatures resolved.",
  ].join("\n\n");
}

function ensureLandingClone(root: string, repo: Workspace["repositories"][number]): string {
  const target = path.join(root, ".smithers-federated", "landing", repo.name);
  if (!existsSync(target)) {
    mkdirSync(path.dirname(target), { recursive: true });
    run(path.dirname(target), "git", ["clone", `git@github.com:${repo.githubRepo}.git`, target]);
  }
  run(target, "git", ["fetch", "origin", repo.baseBranch, repo.branch]);
  run(target, "git", ["checkout", repo.baseBranch]);
  run(target, "git", ["reset", "--hard", `origin/${repo.baseBranch}`]);
  return target;
}

function closeMirrors(mirrors: Mirror[]): Array<{ repo: Repo; number: number }> {
  const closed: Array<{ repo: Repo; number: number }> = [];
  for (const receipt of mirrors.flatMap((mirror) => mirror.prs)) {
    if (receipt.number === null || receipt.status === "skipped") continue;
    const spec = SOURCE_REPOSITORIES.find((repo) => repo.name === receipt.repo);
    if (!spec) continue;
    const state = tryRun(process.cwd(), "gh", ["pr", "view", String(receipt.number), "--repo", spec.githubRepo, "--json", "state"]);
    if (state.status === 0 && (JSON.parse(state.stdout) as { state: string }).state === "OPEN") {
      run(process.cwd(), "gh", ["pr", "close", String(receipt.number), "--repo", spec.githubRepo, "--comment", "Closing this mirror before the reviewed synthesis is merged in a clean local clone and pushed to main. No GitHub merge action is used."]);
    }
    closed.push({ repo: receipt.repo, number: receipt.number });
  }
  return closed;
}

function updateMonorepo(root: string): string | null {
  const target = path.join(root, ".smithers-federated", "landing", "monorepo");
  if (!existsSync(target)) {
    mkdirSync(path.dirname(target), { recursive: true });
    run(path.dirname(target), "git", ["clone", "git@github.com:smithersai/monorepo.git", target]);
  }
  run(target, "git", ["fetch", "origin", "main"]);
  run(target, "git", ["checkout", "main"]);
  run(target, "git", ["reset", "--hard", "origin/main"]);
  run(target, "git", ["submodule", "update", "--init", "flows", "agent", "mvp"]);
  for (const child of ["flows", "agent", "mvp"]) {
    const childPath = path.join(target, child);
    run(childPath, "git", ["fetch", "origin", "main"]);
    run(childPath, "git", ["checkout", "--detach", "origin/main"]);
  }
  run(target, "git", ["add", "flows", "agent", "mvp"]);
  if (tryRun(target, "git", ["diff", "--cached", "--quiet"]).status === 0) return run(target, "git", ["rev-parse", "HEAD"]);
  run(target, "git", ["commit", "-m", "chore: advance universal flow runtime submodules"]);
  run(target, "git", ["push", "origin", "main"]);
  return run(target, "git", ["rev-parse", "HEAD"]);
}

function land(workspace: Workspace, snapshot: z.infer<typeof snapshotSchema>, mirrors: Mirror[]): z.infer<typeof landSchema> {
  const actual = heads(workspace);
  if (actual.revisionId !== snapshot.revisionId) throw new Error("Judge heads changed after the approved reviews.");
  const prepared: Array<{ repo: Workspace["repositories"][number]; target: string; changed: boolean }> = [];
  for (const repo of workspace.repositories) {
    if (run(repo.worktreePath, "git", ["status", "--porcelain"])) throw new Error(`Judge ${repo.name} worktree is dirty.`);
    run(repo.worktreePath, "git", ["push", "--set-upstream", "origin", repo.branch]);
    const target = ensureLandingClone(workspace.root, repo);
    const changed = Number(run(repo.worktreePath, "git", ["rev-list", "--count", `${repo.baseSha}..HEAD`])) > 0;
    if (changed) run(target, "git", ["merge", "--no-ff", "--no-edit", `origin/${repo.branch}`]);
    prepared.push({ repo, target, changed });
  }

  const closedPrs = closeMirrors(mirrors);
  const repositories = prepared.map(({ repo, target, changed }) => {
    run(target, "git", ["push", "origin", repo.baseBranch]);
    return { repo: repo.name, changed, mainSha: run(target, "git", ["rev-parse", "HEAD"]), pushed: true };
  });
  const monorepoSha = updateMonorepo(workspace.root);
  return {
    landed: true,
    repositories,
    monorepoSha,
    closedPrs,
    blockers: [],
    summary: "Merged the reviewed synthesis in clean local clones, pushed main, advanced monorepo submodules, and closed mirror PRs without using GitHub merge.",
  };
}

function htmlEscape(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function writeReport(runSlug: string, candidateFable: unknown, candidateSol: unknown, synthesis: z.infer<typeof synthesisSchema>, reviews: unknown[], landed: z.infer<typeof landSchema>): z.infer<typeof reportSchema> {
  const directory = path.join("/Users/williamcory/.smithers-artifacts/universal-flow-runtime", runSlug);
  mkdirSync(directory, { recursive: true });
  const reportPath = path.join(directory, "final-design.html");
  const decisions = synthesis.improvedDecisions.map((item) => `<li><strong>${htmlEscape(item.title)}</strong>: ${htmlEscape(item.decision)}<br><small>${htmlEscape(item.rationale)}</small></li>`).join("");
  const changes = synthesis.changes.map((item) => `<tr><td>${htmlEscape(item.repo)}</td><td>${htmlEscape(item.status)}</td><td>${htmlEscape(item.summary)}</td></tr>`).join("");
  const reviewRows = reviews.map((item) => `<pre>${htmlEscape(JSON.stringify(item, null, 2))}</pre>`).join("");
  writeFileSync(reportPath, `<!doctype html><html><head><meta charset="utf-8"><title>Universal Flow Runtime</title><style>body{font:16px/1.5 system-ui;max-width:1000px;margin:40px auto;padding:0 24px;color:#17211f}h1,h2{letter-spacing:-.02em}code,pre{background:#eef3f1;padding:12px;border-radius:8px;overflow:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #cbd7d3;padding:8px;text-align:left}small{color:#52635e}</style></head><body><h1>Universal Flow Runtime — final design</h1><p>${htmlEscape(synthesis.designSummary)}</p><h2>Execution contract</h2><pre>${htmlEscape(synthesis.executionContract)}</pre><h2>Placement</h2><p>${htmlEscape(synthesis.placementModel)}</p><h2>Permissions</h2><p>${htmlEscape(synthesis.permissionModel)}</p><h2>Decisions</h2><ul>${decisions}</ul><h2>Implemented changes</h2><table><thead><tr><th>Repository</th><th>Status</th><th>Summary</th></tr></thead><tbody>${changes}</tbody></table><h2>Review evidence</h2>${reviewRows}<h2>Landing</h2><pre>${htmlEscape(JSON.stringify(landed, null, 2))}</pre><details><summary>Candidate designs</summary><h3>Fable</h3><pre>${htmlEscape(JSON.stringify(candidateFable, null, 2))}</pre><h3>Sol</h3><pre>${htmlEscape(JSON.stringify(candidateSol, null, 2))}</pre></details></body></html>`);
  return { reportPath, landed: landed.landed, summary: "Wrote the final synthesized design, implementation receipts, reviews, and landing evidence." };
}

export default smithers((ctx) => {
  const input = inputSchema.parse(ctx.input);
  const runSlug = slug(ctx.runId);
  const fableAgents = fallbackAgents({
    providers: ["claude-code"],
    models: { "claude-code": "claude-fable-5" },
    fallback: [],
    seed: `${ctx.runId}:fable`,
  });
  const root = path.join(input.workspaceRoot, runSlug);
  const preflight = ctx.outputMaybe(outputs.preflight, { nodeId: "preflight" });
  const sources = preflight?.repositories ?? [];
  const fableWorkspace = ctx.outputMaybe(outputs.workspace, { nodeId: "prepare_fable" });
  const solWorkspace = ctx.outputMaybe(outputs.workspace, { nodeId: "prepare_sol" });
  const judgeWorkspace = ctx.outputMaybe(outputs.workspace, { nodeId: "prepare_judge" });
  const fableCandidate = ctx.outputMaybe(outputs.candidate, { nodeId: "candidate_fable" });
  const solCandidate = ctx.outputMaybe(outputs.candidate, { nodeId: "candidate_sol" });
  const fableMirror = ctx.outputMaybe(outputs.mirror, { nodeId: "mirror_fable" });
  const solMirror = ctx.outputMaybe(outputs.mirror, { nodeId: "mirror_sol" });
  const synthesis = ctx.outputMaybe(outputs.synthesis, { nodeId: "synthesize" });
  const judgeMirror = ctx.outputMaybe(outputs.mirror, { nodeId: "mirror_judge" });
  const initialSnapshot = ctx.outputMaybe(outputs.snapshot, { nodeId: "capture_initial" });
  const revisionSnapshot = ctx.latest(outputs.snapshot, "capture_revision");
  const currentSnapshot = revisionSnapshot ?? initialSnapshot;
  const fableReview = ctx.latest(outputs.review, "review_fable");
  const solReview = ctx.latest(outputs.review, "review_sol");
  const reviewsApproved = currentSnapshot !== undefined
    && fableReview?.approved === true
    && solReview?.approved === true
    && fableReview.revisionId === currentSnapshot.revisionId
    && solReview.revisionId === currentSnapshot.revisionId;
  const landed = ctx.outputMaybe(outputs.land, { nodeId: "land" });

  return (
    <Workflow name="universal-flow-runtime-swarm">
      <Sequence>
        <Task id="preflight" output={outputs.preflight} sideEffect={{ idempotent: true }}>{inspectPreflight}</Task>

        {preflight?.ready ? (
          <Parallel id="candidate-lanes" maxConcurrency={2}>
            {(["fable", "sol"] as const).map((lane) => {
              const branch = branchFor(runSlug, lane);
              const laneRoot = path.join(root, lane);
              const workspace = lane === "fable" ? fableWorkspace : solWorkspace;
              return (
                <Worktree key={lane} path={laneRoot} branch={branch} baseBranch="main">
                  <Sequence>
                    <Task id={`prepare_${lane}`} output={outputs.workspace} dependsOn={["preflight"]} sideEffect={{ idempotent: true }}>
                      {() => prepareWorkspace(lane, laneRoot, branch, sources)}
                    </Task>
                    <Task id={`candidate_${lane}`} output={outputs.candidate} dependsOn={[`prepare_${lane}`]} agent={lane === "fable" ? fableAgents : providers.codex1Sol} retries={2} timeoutMs={3 * 60 * 60_000} heartbeatTimeoutMs={15 * 60_000}>
                      {workspace ? candidatePrompt(lane, input.goal, workspace) : `Wait for prepare_${lane}.`}
                    </Task>
                    <Task id={`mirror_${lane}`} output={outputs.mirror} dependsOn={[`candidate_${lane}`]}>
                      {() => {
                        if (!workspace) throw new Error(`Missing ${lane} workspace.`);
                        return mirrorLane(workspace);
                      }}
                    </Task>
                  </Sequence>
                </Worktree>
              );
            })}
          </Parallel>
        ) : null}

        {fableCandidate && solCandidate && fableMirror?.success && solMirror?.success ? (
          <Worktree path={path.join(root, "judge")} branch={branchFor(runSlug, "judge")} baseBranch="main">
            <Sequence>
              <Task id="prepare_judge" output={outputs.workspace} dependsOn={["mirror_fable", "mirror_sol"]} sideEffect={{ idempotent: true }}>
                {() => prepareWorkspace("judge", path.join(root, "judge"), branchFor(runSlug, "judge"), sources)}
              </Task>
              <Task id="synthesize" output={outputs.synthesis} dependsOn={["prepare_judge"]} agent={providers.claudeOpus} retries={2} timeoutMs={4 * 60 * 60_000} heartbeatTimeoutMs={15 * 60_000}>
                {judgeWorkspace ? synthesisPrompt(input.goal, judgeWorkspace, fableCandidate, solCandidate) : "Wait for the judge workspace."}
              </Task>
              <Task id="capture_initial" output={outputs.snapshot} dependsOn={["synthesize"]}>
                {() => {
                  if (!judgeWorkspace) throw new Error("Missing judge workspace.");
                  return heads(judgeWorkspace);
                }}
              </Task>
              <Task id="mirror_judge" output={outputs.mirror} dependsOn={["capture_initial"]} sideEffect={{ idempotent: true }}>
                {() => {
                  if (!judgeWorkspace) throw new Error("Missing judge workspace.");
                  return mirrorLane(judgeWorkspace);
                }}
              </Task>

              {synthesis && judgeMirror?.success && currentSnapshot ? (
                <Ralph id="consensus-review" until={reviewsApproved} maxIterations={Math.min(6, input.maxReviewRounds + 1)} onMaxReached="fail">
                  <Sequence>
                    <Parallel id="review-panel" maxConcurrency={2}>
                      <Task id="review_fable" output={outputs.review} agent={fableAgents} retries={2} timeoutMs={90 * 60_000} heartbeatTimeoutMs={15 * 60_000}>
                        {reviewPrompt("fable", input.goal, judgeWorkspace!, synthesis, currentSnapshot)}
                      </Task>
                      <Task id="review_sol" output={outputs.review} agent={providers.codex2Sol} retries={2} timeoutMs={90 * 60_000} heartbeatTimeoutMs={15 * 60_000}>
                        {reviewPrompt("sol", input.goal, judgeWorkspace!, synthesis, currentSnapshot)}
                      </Task>
                    </Parallel>
                    {!reviewsApproved ? (
                      <Sequence>
                        <Task id="revise_synthesis" output={outputs.revision} dependsOn={["review_fable", "review_sol"]} agent={providers.claudeOpus} retries={2} timeoutMs={3 * 60 * 60_000} heartbeatTimeoutMs={15 * 60_000}>
                          {revisionPrompt(judgeWorkspace!, fableReview, solReview)}
                        </Task>
                        <Task id="capture_revision" output={outputs.snapshot} dependsOn={["revise_synthesis"]}>
                          {() => heads(judgeWorkspace!)}
                        </Task>
                      </Sequence>
                    ) : null}
                  </Sequence>
                </Ralph>
              ) : null}

              {reviewsApproved && currentSnapshot && fableMirror && solMirror && judgeMirror ? (
                <Sequence>
                  <Task id="land" output={outputs.land} dependsOn={["review_fable", "review_sol"]} sideEffect={{ idempotent: true }} timeoutMs={90 * 60_000}>
                    {() => land(judgeWorkspace!, currentSnapshot, [fableMirror, solMirror, judgeMirror])}
                  </Task>
                  <Task id="final_report" output={outputs.report} dependsOn={["land"]}>
                    {() => {
                      if (!landed) throw new Error("Missing landing receipt.");
                      return writeReport(runSlug, fableCandidate, solCandidate, synthesis, [fableReview, solReview], landed);
                    }}
                  </Task>
                </Sequence>
              ) : null}
            </Sequence>
          </Worktree>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
