Repair the generated reusable Smithers workflow at `/Users/williamcory/mvp/.smithers/workflows/production-readiness-swarm.tsx` and its dedicated test, UI, and prompts as needed. This is a bounded workflow-authoring task; do not implement the MVP product yet and do not touch unrelated generated workflows or user files.

The current implementation is structurally decorative and must become executable:

- Replace `Ralph until={false}` with output-driven convergence using documented Smithers primitives and typed fields.
- Remove deterministic gates and release output that always return blocked. Every gate and final release verdict must derive from prior typed outputs; `production-ready` is possible only when all evidence passes.
- Replace the permissive shared evidence schema with task-specific Zod contracts sufficient for downstream decisions. Include stable status enums, pass/failure classification, evidence refs, blockers, commands/results, architecture lessons/scores, review receipts, history/commit receipts, and final E2E/legacy-boundary/frame-navigation assertions where relevant.
- POC fleet uses Codex Luna in four parallel disposable lanes. POC integration/repair uses Codex Sol. Production planning/supervision uses Claude Opus with Codex Sol implementation waves. Review nodes are unreachable until production E2E passes.
- Worktrees are isolated, do not use fixed colliding `/tmp` paths, operate safely on `targetRepo`, never force-push, and never land on `main`.
- Missing initial E2E commands are work to build, not an initialize blocker.
- Product code may depend only on new Smithers in `/Users/williamcory/flows` (`@smithers/*`). Forbid legacy `@smthrs/*` and `/Users/williamcory/smithers` product imports. Workflow/control UI may import `smthrs` because it is control-plane tooling.
- Mandatory acceptance covers SQLite-backed TanStack DB authority; actor-recorded Flux plus atomic Journal for every mutation; one Flow registry with slash/`ctx.call`/button parity; connectors; workspace/branch/revision; Harness Cell executing Smithers scripts; recursive native subagents and external adapters; worldview/memory; renderer-neutral transcript with Brainless Claude/Codex renderers; no agent tabs; new content as embedded mini-app; same component maximized; persistent composer chrome; URL-addressed durable frame graph; browser back/forward; minimize/maximize; historical-frame fork; accessibility/visual/native E2E; and an architecture documentation site with file tree and pseudocode.
- Strengthen the dedicated Bun `renderWorkflow` tests so they fail for hardcoded false loops, always-blocked terminal gates, permissive schemas, wrong agent seats, missing dependency/gating relations, and absent acceptance clauses. Fix current strict-null errors.
- Provide a thoughtful shipped-component workflow UI; its tabs are allowed because it is not product UI.
- Run the dedicated test, a targeted typecheck proving changed artifacts even if unrelated seeded files or upstream linked React types fail, graph render, and any available UI compilation check.
- Use `apply_patch` for edits. Preserve the running baseline MVP process and Gateway. Do not review; this is the pre-E2E fast implementation stage.

Return exact validation commands/results and known environment-only failures.
