# Disaster recovery

How to back up a durable flows store, verify the backup, and restore it after data loss. The durable state of a deployment is one SQLite file (journal, runs, attempts, step cache, engine state) plus one content-addressed objects directory. The tooling lives in `@smthrs/engine-store-next`'s `DisasterRecovery` module and is exposed to operators as `scripts/flows-backup.mjs`. The automated restore drill that pins this whole procedure is `packages/engine-store/test/RestoreDrill.test.ts`.

## What a backup contains

| File | Content | How it is captured |
| --- | --- | --- |
| `store.sqlite3` | every table in the store, including the out-of-ladder objects created outside the migration ladder | `VACUUM INTO` — one consistent read transaction under WAL |
| `objects/<xx>/<digest>` | the content-addressed artifact blobs | copied after the database snapshot, digest-verified during the copy |
| `manifest.json` | the database digest and size, the applied migration ladder, and every blob digest | written last, so its presence marks a complete backup |

The order matters. Artifacts are published to the store before anything references them, and the blob walk runs after the database snapshot, so every digest the snapshot references is in the backup. A blob whose bytes no longer hash to its address fails the backup instead of being captured; repair the store before backing it up.

## Taking a backup

Backups are hot. `VACUUM INTO` reads one consistent snapshot while writers keep committing; nothing is paused and no lock is held against the engine. Writes that commit after the snapshot's read transaction starts are not in the backup.

```sh
node scripts/flows-backup.mjs backup <database-file> <backup-directory> [objects-directory]
```

The backup directory must be empty or absent. From code, compose `DisasterRecovery.backup` over the existing layers — `SqlClient` on the live database, `FileSystem`, and `Crypto`:

```ts
import { DisasterRecovery } from "@smthrs/engine-store-next"

const manifest = yield* DisasterRecovery.backup({
  directory: "/backups/2026-08-13T12-00",
  objectsDirectory: "/srv/flows/.flows/objects"
})
```

### Cadence

The backup interval is your data-loss bound: everything committed after the last backup is lost on restore. Choose the interval from how much re-work a restore may cost, not from backup cost — a snapshot is one read pass and never blocks writers.

- Run backups on a schedule (cron or a supervisor timer). Hourly is a reasonable default for an active workspace.
- Run `verify` immediately after each capture, and periodically against stored backups — storage rots.
- Keep several generations and copy them off the host. A backup beside the store it protects shares its disk failures.

```sh
node scripts/flows-backup.mjs verify <backup-directory>
```

`verify` re-hashes the database file and every listed blob against the manifest and refuses anything missing or altered.

## Restoring

Restore lands in a fresh directory. The damaged store is never modified, so a restore attempt cannot make an incident worse.

1. Pick the newest backup whose `verify` passes.
2. Restore it:

   ```sh
   node scripts/flows-backup.mjs restore <backup-directory> <target-directory>
   ```

This calls `DisasterRecovery.restoreAndFence`: every byte is verified against the manifest as it copies, a `restored.json` marker records which backup was restored and when, and the restored database is fenced before the command exits. It refuses a non-empty target.
3. Point the engine composition at the restored store: `NodeDatabase.layer({ filename: <target>/store.sqlite3 })` and `ArtifactStore.layerFileSystem({ directory: <target>/objects })`.
4. Retire every process that was attached to the old store. The old store still exists and is untouched; two engines writing two diverging stores is an outage of its own.

Runs that were `running` at backup time come back `suspended` with no owner. A resuming engine claims them immediately — no heartbeat-staleness wait, no liveness evidence — and drives them from their recorded attempts: completed steps replay from the store without re-executing, and attempts that were in flight at backup time re-execute under the new owner.

### Fencing: why a stale engine cannot resurrect

Every durable write in the store is fenced by an `OwnerId` equality check compiled into the same SQL statement — Temporal's shard `rangeID` compare-and-swap reduced to one predicate. A restored database still carries the pre-backup owner columns, so an engine that survived the incident and reattached would heartbeat successfully and keep writing: the resurrection hazard.

`DisasterRecovery.fence` is the restore-time epoch bump. In one serialized write transaction it clears every pending claim and suspends every `running` run with its owner and heartbeat cleared. After it, every fenced operation from a pre-backup owner is refused — `heartbeat` and `transitionOwned` report `FenceLost`, fenced journal appends fail with `fence_lost` — while fresh owners claim the runs normally. `fence` also checks the schema version: the manifest's recorded migration ladder must be a prefix of the restored database's applied ladder (equal for the same binary, extended when a newer binary migrated the file forward on open).

The restore script runs the one-shot `restoreAndFence` API. If you need separate staging, run `restore` and then `fence` yourself before any engine adopts the restored database:

```ts
const restored = yield* DisasterRecovery.restore({ backupDirectory, targetDirectory })
const summary = yield* DisasterRecovery.fence(restored.manifest) // over the restored database's layers
```

## Expectations

| Property | Value |
| --- | --- |
| Data-loss bound (RPO) | the backup interval; everything after the captured snapshot is lost |
| Recovery time (RTO) | verify + copy + fence — minutes, dominated by file size |
| Completed steps | replay from the restored store without re-executing |
| In-flight attempts at backup time | re-execute under the new owner: at-least-once, exactly like a crash at that point |
| Stale engines | fenced out of the restored store by `fence`; the source store is untouched |
| Schema drift | restore refuses digest mismatches; `fence` refuses a database whose ladder diverges from the manifest |

## What is not covered

- **Writes after the snapshot.** Lost by definition. The backup interval is the bound.
- **External side effects.** The store records what ran; it cannot undo an email, a push, or an API call made after the snapshot, and an in-flight attempt re-executes on resume. Side effects need the same idempotency they need to survive a crash.
- **Workspace trees and jj state.** Only the database and the objects directory are captured. Action workspaces, sandbox trees, and jj repositories are not part of the backup.
- **Remote artifact tiers.** `RemoteArtifacts` content is not walked. The backup captures the local objects directory; a restored store backed by a remote tier heals remote misses through the normal read-through path.
- **Retention, encryption, and off-host transport.** The backup directory is plain files; scheduling, rotation, encryption, and shipping it off the host are the operator's platform.
- **Non-SQLite backends.** `backup` speaks SQLite (`VACUUM INTO`) and fails with its `sql` error code on any other `SqlClient`.
- **Restarting the work.** Restore and fence make the store usable again; they do not run anything. Abandoned runs are not auto-resumed in this release: the supervision runtime in `@smthrs/gateway` is a noop (`packages/gateway/src/SuperviseRuntime.ts`), so nothing scans a restored store and launches a worker for it. Bring up a process composed through `@smthrs/flows-next/NodeRuntime` with every relevant flow registered, and its heartbeat-cadence sweep reclaims stale rows through the ordinary claim/steal path within the 30-second stale window. The procedure is in [Using the durable engine](https://github.com/smithersai/flows/blob/main/docs/guides/durable-engine.md#abandoned-runs-are-not-auto-resumed).
