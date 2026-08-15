---
name: production-readiness-swarm
description: Run a bounded, evidence-driven workflow that prototypes, implements, verifies, reviews, and issues a deterministic production-readiness verdict.
workflow: production-readiness-swarm
---

# Production Readiness Swarm

Use this workflow for a full production-readiness pass when the repository needs architecture discovery, disposable POC learning, dependency-aware implementation waves, deterministic E2E verification, review, and curated history. It ends with either `production-ready` or a typed `blocked` result.

## Inputs

The free-form `prompt` supplies operator context when using `bunx smthrs workflow run`. Structured inputs are: `targetRepo` (string, default `/Users/williamcory/mvp`), `architectureSitePath` (string, default `docs/architecture`), `maxPrototypeRounds` (integer 1–5, default `3`), `maxProductionRounds` (integer 1–6, default `4`), `maxConcurrency` (positive integer, default `4`), `acceptanceCommands` (array of non-empty strings, default `[]`), and `sourceRepos` (array of non-empty strings, with the provisioned source-repository defaults).

## Start

Run with context:

```sh
bunx smthrs workflow run production-readiness-swarm --prompt "Assess and prepare this repository for production."
```

For structured inputs, use `--input '{"targetRepo":"/Users/williamcory/mvp","maxProductionRounds":4}'`, or run `smithers up .smithers/workflows/production-readiness-swarm.tsx`.

## Detached runs

Add `-d` to detach, then monitor with:

```sh
smithers ps
smithers logs <runId> -f
smithers inspect <runId>
```

## Visualize

```sh
bunx smthrs graph .smithers/workflows/production-readiness-swarm.tsx
```

Add `--interactive` for the TUI. This workflow declares a custom UI; open it for a run with `smithers ui <runId>`.

## Blocked states

Use `smithers approve <runId>` for approval gates, `smithers why <runId>` for signal waits, and `smithers cancel <runId>` to stop a run. This workflow has no planned human gates, but these commands apply if a run is paused by its control plane.

Suggest next: run it, watch it in the custom UI, and iterate by re-running `create-workflow` with a follow-up prompt.
