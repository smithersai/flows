# Alpha handoff: human tasks

The production-readiness panel passed on `origin/main` at
`81d310d771f967ae549ffbf3dda4be6b339f000e`. Two independent verifiers (codex,
fable) both returned PRODUCTION-READY with no findings. Three decisions and
checks remain that only a human owner can perform.

## H1. Ratify the remote trust posture, or direct a change

A2 shipped a control-plane trust posture: bearer-token auth for remote
control, loopback (`127.0.0.1`) bind by default, non-loopback binds refused
unless `--listen` is passed, noop auth confined to loopback, and an empty
token failing closed. Ratify this posture for the alpha, or direct a change
before release.

Evidence:

- Commit on main: `3905ddef` ("🔐 feat(cli): enforce the alpha remote trust
  posture").
- Posture document: `docs/guides/control-plane-trust.md` (loopback default,
  `--listen` opt-in, empty token fails closed).
- Tests: `packages/cli/test/ControlSurface.test.ts` (14/14 green), including
  "runs plan, approval, launch, and finite logs through an authenticated
  remote server", "refuses an unauthenticated request on an explicitly
  exposed bind", "refuses non-loopback binds without --listen and always
  confines noop auth", and "uses the bearer credential for the remote
  WebSocket projection".

## H2. Rule on D11 and the plugin boundary

Plain statement: A4's reconciliation does not need a new owner decision. The
design record, the code, and the docs ledger already agree. D11 blesses
`@smthrs/plugin` for the bounded cell-loop role only, with the hook catalog
trimmed to `cellRegistry`, `cellFlows`, and `cellModelRequest`; durable-core
lifecycle policy is explicitly not a hook catalog. The remaining human action
is to read D11 and confirm it, or overturn it before the alpha ships.

Evidence:

- Commit on main: `c1653096` ("📝 docs: bless the cell-loop plugin boundary").
- Design record: `docs/architecture/design-decisions.md`, section "D11. Core
  extension is dependency injection; cell-loop extension uses the plugin
  kernel"; the ledger row in `docs/pages/design-decisions.md` agrees.
- Code: `packages/plugin/src/Hooks.ts` retains only `config`/`configResolved`
  plus the three bounded cell hooks; `@smthrs/engine-harness` dispatches them
  through the cell harness. Plugin suite 50/50 green.

## H3. Final human verification that `flows run` is alpha-shippable

Both verifiers exercised the full path (composition root, auth, sandboxed
tools, approvals) through the automated suites. A human should run the same
path once with a real provider key before declaring the alpha shippable.

Automated evidence already on main:

- End-to-end executor: `packages/engine-harness/test/HarnessExecutor.test.ts`
  (11/11), including "drives a 2-frame run through control → executor →
  engine, then replays it from the recorded fixture" (QuickJS-sandboxed tool
  call executed exactly once across a park, operator steer at the frame
  boundary, ask parks as `waiting-approval`, `Control.approve` resumes to
  completed). The composition root is `NodeRuntime.layer` from
  `@smthrs/flows-next/NodeRuntime`.
- Sandbox ceilings: `packages/harness/test/Sandbox.test.ts` (57/57),
  including "defaults every supported safety ceiling and preserves explicit
  raises" (defaults: 128 MiB, 1000 steps, 30 s, per
  `packages/harness/README.md`).
- CLI: 35/35 green; `--version` prints `flows v0.1.0`; malformed `--data`
  exits 2 with a `UsageError`.

Commands to run (from `packages/cli/README.md`, "Manual smoke"):

```sh
# 1. Create a prompt flow.
mkdir -p flows/hello
cat > flows/hello/flow.mdx <<'EOF'
---
description: Replies with one short greeting sentence.
model: anthropic:claude-sonnet-4-5
---
Reply with one short greeting sentence, then complete with that sentence
as your output.
EOF

# 2. Provide the seat's provider key.
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Plan, approve, run, and watch the run settle.
approval="$(flows --json plan hello | jq -c '.approval')"
flows --json approve "$approval" --scope run
flows --json run "$approval"
flows ps
flows logs <run-id> --follow
```

Expected: `flows run` prints the accepted receipt with the run id; `flows ps`
shows the durable run state; a run that asks for approval parks as
`waiting-approval` and journals a `control.approval.requested` event, and
`flows run --resume <run-id>` re-drives the parked execution. Sign off on the
alpha once this matches what you see.
