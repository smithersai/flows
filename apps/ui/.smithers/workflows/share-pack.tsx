// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Share pack
// smithers-description: Validate, prepare, publish, and list a Smithers workflow pack in awesome-smithers.
// smithers-tags: packs, sharing, github
// smithers-system: true
/** @jsxImportSource smthrs */
import { createSmithers, UI } from "smthrs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod/v4";
import { agents } from "../agents";

const inputSchema = z.object({
  repo: z.string().optional().describe("GitHub repository to create for the pack."),
  registry: z.string().optional().describe("awesome-smithers repository override."),
  dryRun: z.boolean().default(false),
});
const stepSchema = z.object({ ok: z.boolean(), detail: z.string() });
const completionSchema = z.object({ completed: z.boolean(), detail: z.string() });
const prepareSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
  stagingId: z.string().nullable().default(null),
});
const outputSchema = z.object({
  validated: z.boolean(),
  prepared: z.boolean(),
  published: z.boolean(),
  shared: z.boolean(),
  detail: z.string(),
});
const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  validate: stepSchema,
  completion: completionSchema,
  revalidate: stepSchema,
  prepare: prepareSchema,
  publish: stepSchema,
  share: stepSchema,
  output: outputSchema,
});
const cliModule = (name: string) =>
  process.env.SMITHERS_CLI_SRC_DIR ? `${process.env.SMITHERS_CLI_SRC_DIR}/${name}.js` : `@smthrs/cli/${name}`;
const PREPARED_PREFIX = "smithers-share-stage-";
const OWNED_PREFIX = "smithers-share-run-";
const OWNERSHIP_MARKER = ".smithers-share-owner.json";

function assertDedicatedTempPath(candidate: string, prefix: string): string {
  const canonicalTmp = realpathSync(tmpdir());
  if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink()) throw new Error("staging path is missing or symbolic");
  const canonical = realpathSync(candidate);
  if (dirname(canonical) !== canonicalTmp || !basename(canonical).startsWith(prefix)) {
    throw new Error(`staging path is outside the dedicated temporary root: ${candidate}`);
  }
  return canonical;
}

/** Move CLI staging into a run-owned directory and persist only its basename. */
export function claimPreparedStagingRoot(preparedRoot: string, runId: string): string {
  const source = assertDedicatedTempPath(preparedRoot, PREPARED_PREFIX);
  const parent = mkdtempSync(join(realpathSync(tmpdir()), OWNED_PREFIX));
  const staging = join(parent, "stage");
  renameSync(source, staging);
  writeFileSync(join(parent, OWNERSHIP_MARKER), JSON.stringify({ runId, staging: "stage" }));
  return basename(parent);
}

/** Reconstruct and verify the owned staging path before publication or deletion. */
export function resolveOwnedStagingRoot(stagingId: string, runId: string): { parent: string; staging: string } {
  if (basename(stagingId) !== stagingId || !stagingId.startsWith(OWNED_PREFIX)) {
    throw new Error("invalid persisted staging identifier");
  }
  const parent = assertDedicatedTempPath(join(realpathSync(tmpdir()), stagingId), OWNED_PREFIX);
  const markerPath = join(parent, OWNERSHIP_MARKER);
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { runId?: unknown; staging?: unknown };
  if (marker.runId !== runId || marker.staging !== "stage") throw new Error("staging ownership marker does not match this run");
  const staging = realpathSync(join(parent, "stage"));
  if (dirname(staging) !== parent || lstatSync(staging).isSymbolicLink()) throw new Error("owned staging path is not contained");
  return { parent, staging };
}

async function validateManifest(repo: string | undefined, registry: string | undefined) {
  const { loadManifest } = await import(cliModule("manifest"));
  const { findPackRoot, resolveShareRepositories } = await import(cliModule("share"));
  const packRoot = findPackRoot(process.cwd());
  const manifest = loadManifest(`${packRoot}/smithers.toon`);
  try {
    resolveShareRepositories({ repository: repo, manifestRepository: manifest.repository, registry });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${reason} (manifest ${packRoot}/smithers.toon has repository=${JSON.stringify(manifest.repository)}${repo === undefined ? "" : `, input repo=${JSON.stringify(repo)}`})`,
    );
  }
  if (!manifest.description) throw new Error("smithers.toon needs a description before the pack can be listed");
  return manifest;
}

export default smithers((ctx) => {
  const validate = ctx.outputMaybe("validate", { nodeId: "validate-manifest" });
  const completion = ctx.outputMaybe("completion", { nodeId: "complete-manifest" });
  const revalidate = ctx.outputMaybe("revalidate", { nodeId: "revalidate-manifest" });
  const prepare = ctx.outputMaybe("prepare", { nodeId: "prepare-pack" });
  const publish = ctx.outputMaybe("publish", { nodeId: "publish-pack" });
  const shared = ctx.outputMaybe("share", { nodeId: "share-registry" });
  const manifestReady = validate?.ok === true || revalidate?.ok === true;
  // The agent completes an incomplete manifest exactly once; if deterministic
  // revalidation still fails afterwards, the run terminates with that detail.
  // Mount stays keyed on the validation verdict (not on completion's absence)
  // so the finished agent task remains in the tree instead of unmounting.
  const needsCompletion = validate?.ok === false;
  const canPrepare = manifestReady;
  const canPublish = prepare?.ok === true && !ctx.input.dryRun;
  const canShare = prepare?.ok === true && (ctx.input.dryRun || publish?.ok === true);
  // A failed validation is NOT terminal until the completion agent has had
  // its one chance and revalidation still fails — otherwise the terminal
  // output task would race the completion task it is supposed to wait for.
  const manifestTerminal = revalidate ? !revalidate.ok : validate?.ok === false && completion !== undefined;
  const terminalFailure = manifestTerminal || [prepare, publish, shared].some((row) => row && !row.ok);
  const done = shared?.ok === true || terminalFailure;
  return (
    <Workflow name="share-pack">
      <Sequence>
        <Task id="validate-manifest" output={outputs.validate} retries={0}>
          {async () => {
            try {
              await validateManifest(ctx.input.repo, ctx.input.registry);
              return { ok: true, detail: "smithers.toon is valid" };
            } catch (error) {
              return { ok: false, detail: error instanceof Error ? error.message : String(error) };
            }
          }}
        </Task>
        {needsCompletion ? (
          <Task id="complete-manifest" output={outputs.completion} agent={agents.cheapFast}>
            {`The pack manifest .smithers/smithers.toon in this repository is incomplete: ${validate?.detail ?? "unknown"}.
Complete it: fill in name (kebab-case, from the project), a one-sentence description, repository (owner/name${ctx.input.repo ? `; the user wants ${ctx.input.repo}` : "; derive from \`git remote get-url origin\` when available, otherwise leave it and report why"}), and reconcile contents.workflows / contents.ui with the actual files under .smithers/workflows and .smithers/ui (flat <id>.tsx or <id>/workflow.tsx forms; ui entries only for real UI entrypoints).
Edit ONLY .smithers/smithers.toon. Return completed=true when the manifest is filled, with a one-line detail of what you changed.`}
          </Task>
        ) : null}
        {completion ? (
          <Task id="revalidate-manifest" output={outputs.revalidate} retries={0}>
            {async () => {
              try {
                await validateManifest(ctx.input.repo, ctx.input.registry);
                return { ok: true, detail: "smithers.toon is valid after completion" };
              } catch (error) {
                return { ok: false, detail: error instanceof Error ? error.message : String(error) };
              }
            }}
          </Task>
        ) : null}
        {canPrepare ? (
          <Task id="prepare-pack" output={outputs.prepare} retries={0}>
            {async () => {
              try {
                const { preparePackForShare } = await import(cliModule("share"));
                // Staging-copy flow: the live .smithers is never mutated. The staging
                // path is persisted so publish uses THIS artifact and cleanup can
                // always find it, even in a fresh process after a durable retry.
                const result = preparePackForShare({ from: process.cwd(), repository: ctx.input.repo });
                return {
                  ok: true,
                  detail: result.detail,
                  stagingId: claimPreparedStagingRoot(result.stagingRoot, ctx.runId),
                };
              } catch (error) {
                return { ok: false, detail: error instanceof Error ? error.message : String(error), stagingId: null };
              }
            }}
          </Task>
        ) : null}
        {canPublish ? (
          <Task id="publish-pack" output={outputs.publish} retries={0}>
            {async () => {
              try {
                const { publishPackRepository } = await import(cliModule("share"));
                return {
                  ok: true,
                  detail: publishPackRepository({
                    from: process.cwd(),
                    repository: ctx.input.repo,
                    stagingRoot: prepare?.stagingId
                      ? resolveOwnedStagingRoot(prepare.stagingId, ctx.runId).staging
                      : undefined,
                  }),
                };
              } catch (error) {
                return { ok: false, detail: error instanceof Error ? error.message : String(error) };
              }
            }}
          </Task>
        ) : null}
        {canShare ? (
          <Task id="share-registry" output={outputs.share} retries={0}>
            {async () => {
              try {
                const { sharePack } = await import(cliModule("share"));
                const result = sharePack({
                  from: process.cwd(),
                  repository: ctx.input.repo,
                  repo: ctx.input.registry,
                  dryRun: ctx.input.dryRun,
                });
                return { ok: true, detail: result.pullRequest ?? result.entry };
              } catch (error) {
                return { ok: false, detail: error instanceof Error ? error.message : String(error) };
              }
            }}
          </Task>
        ) : null}
        {done ? (
          <Task id="output" output={outputs.output}>
            {async () => {
              // Terminal cleanup on every path (success, dry-run, or failure): the
              // staging copy must never outlive the run.
              const stagingId = prepare?.stagingId;
              if (stagingId) {
                const owned = resolveOwnedStagingRoot(stagingId, ctx.runId);
                rmSync(owned.parent, { recursive: true, force: true });
              }
              return {
                validated: manifestReady,
                prepared: prepare?.ok === true,
                published: publish?.ok === true,
                shared: shared?.ok === true,
                detail:
                  [revalidate ?? validate, prepare, publish, shared].find((row) => row && !row.ok)?.detail ??
                  shared?.detail ??
                  "Share did not complete",
              };
            }}
          </Task>
        ) : null}
      </Sequence>
      <UI entry="../ui/share-pack.tsx" />
    </Workflow>
  );
});
