/**
 * Pins the backup/restore contract of `DisasterRecovery`: a hot backup is a
 * verified, manifest-described snapshot; a restore refuses anything that no
 * longer hashes to that manifest; and the fence step invalidates every
 * persisted ownership fence the snapshot carried.
 *
 * The restore drill — a live engine, a mid-activity backup, and a resumed run
 * on the restored store — lives in `RestoreDrill.test.ts`. This suite covers
 * the file and manifest edges with hand-tampered backups.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { DurableWriter } from "@smthrs/database-next"
import * as NodeDatabase from "@smthrs/database-next/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database-next/test/TestDatabase"
import * as Cause from "effect/Cause"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as DisasterRecovery from "../src/DisasterRecovery.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { runPromise, sha256 } from "./Sha256.ts"

const root = () => mkdtempSync(join(tmpdir(), "flows-dr-"))

type Environment =
  | DurableWriter.DurableWriter
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | Crypto.Crypto

/** The migrated in-memory database plus the real host filesystem. */
const environment = Layer.mergeAll(TestStores.database, NodeFileSystem.layer)

const run = <A, E>(effect: Effect.Effect<A, E, Environment>): Promise<A> =>
  runPromise(Effect.provide(effect, environment))

const restoredDatabase = (databaseFile: string) =>
  Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: databaseFile }))

/** Plants a blob at its content address inside a store objects directory. */
const plantBlob = (objectsDirectory: string, bytes: string): string => {
  const digest = sha256(bytes)
  mkdirSync(join(objectsDirectory, digest.slice(0, 2)), { recursive: true })
  writeFileSync(join(objectsDirectory, digest.slice(0, 2), digest), bytes)
  return digest
}

const failure = <A>(
  exit: Exit.Exit<A, DisasterRecovery.DisasterRecoveryError>
): DisasterRecovery.DisasterRecoveryError => {
  if (!Exit.isFailure(exit)) throw new Error("expected the operation to fail")
  return Cause.squash(exit.cause) as DisasterRecovery.DisasterRecoveryError
}

describe("backup", () => {
  it("captures the database, the artifact blobs, and a manifest written last", async () => {
    const base = root()
    const objects = join(base, "objects")
    const backupDirectory = join(base, "backup")
    const digestOne = plantBlob(objects, "artifact-one")
    const digestTwo = plantBlob(objects, "artifact-two")
    // Not part of the store's address space: a scratch file, a stray file,
    // and a blob parked under the wrong fanout prefix.
    writeFileSync(join(objects, digestOne.slice(0, 2), `${digestOne}.tmp-abc-0`), "scratch")
    writeFileSync(join(objects, "junk.txt"), "junk")
    const wrongPrefix = digestOne.slice(0, 2) === "ff" ? "00" : "ff"
    mkdirSync(join(objects, wrongPrefix), { recursive: true })
    writeFileSync(join(objects, wrongPrefix, digestOne), "artifact-one")

    const manifest = await run(
      DisasterRecovery.backup({ directory: backupDirectory, objectsDirectory: objects })
    )

    expect(manifest.formatVersion).toBe(1)
    expect(manifest.database.file).toBe(DisasterRecovery.databaseFileName)
    expect(manifest.database.migrations.length).toBeGreaterThan(0)
    const databaseBytes = readFileSync(join(backupDirectory, DisasterRecovery.databaseFileName))
    expect(sha256(databaseBytes)).toBe(manifest.database.sha256)
    expect(manifest.database.sizeBytes).toBe(databaseBytes.length)
    expect(manifest.artifacts.map((entry) => entry.digest)).toEqual([digestOne, digestTwo].sort())
    for (const entry of manifest.artifacts) {
      const copied = readFileSync(
        join(backupDirectory, DisasterRecovery.objectsDirectoryName, entry.digest.slice(0, 2), entry.digest)
      )
      expect(sha256(copied)).toBe(entry.digest)
      expect(copied.length).toBe(entry.sizeBytes)
    }
    const written = JSON.parse(
      readFileSync(join(backupDirectory, DisasterRecovery.manifestFileName), "utf8")
    ) as DisasterRecovery.BackupManifest
    expect(written).toEqual(manifest)

    const verified = await run(DisasterRecovery.verify(backupDirectory))
    expect(verified).toEqual(manifest)
  })

  it("accepts a pre-created empty directory and no artifact tier at all", async () => {
    const backupDirectory = join(root(), "backup")
    mkdirSync(backupDirectory, { recursive: true })
    const manifest = await run(DisasterRecovery.backup({ directory: backupDirectory }))
    expect(manifest.artifacts).toEqual([])
  })

  it("records no blobs when the objects directory does not exist yet", async () => {
    const base = root()
    const manifest = await run(
      DisasterRecovery.backup({
        directory: join(base, "backup"),
        objectsDirectory: join(base, "never-created")
      })
    )
    expect(manifest.artifacts).toEqual([])
  })

  it("refuses a target directory that already holds anything", async () => {
    const backupDirectory = join(root(), "backup")
    mkdirSync(backupDirectory, { recursive: true })
    writeFileSync(join(backupDirectory, "existing.txt"), "occupied")
    const exit = await run(DisasterRecovery.backup({ directory: backupDirectory }).pipe(Effect.exit))
    expect(failure(exit).code).toBe("not_empty")
  })

  it("refuses to capture a blob whose bytes no longer hash to its address", async () => {
    const base = root()
    const objects = join(base, "objects")
    const digest = plantBlob(objects, "honest-bytes")
    writeFileSync(join(objects, digest.slice(0, 2), digest), "tampered-bytes")
    const exit = await run(
      DisasterRecovery.backup({ directory: join(base, "backup"), objectsDirectory: objects }).pipe(Effect.exit)
    )
    expect(failure(exit).code).toBe("artifact_corruption")
  })

  it("surfaces the host filesystem's refusal as the io code", async () => {
    const base = root()
    // A regular file where the objects directory should be: `exists` reports
    // it, listing it fails.
    const notADirectory = join(base, "objects")
    writeFileSync(notADirectory, "a file, not a directory")
    const exit = await run(
      DisasterRecovery.backup({ directory: join(base, "backup"), objectsDirectory: notADirectory }).pipe(
        Effect.exit
      )
    )
    expect(failure(exit).code).toBe("io")
  })

  it("surfaces the database's refusal as the sql code", async () => {
    // An unmigrated database has no flows_migrations table to record.
    const exit = await runPromise(
      DisasterRecovery.backup({ directory: join(root(), "backup") }).pipe(
        Effect.exit,
        Effect.provide(Layer.mergeAll(TestDatabase.layer, NodeFileSystem.layer))
      )
    )
    expect(failure(exit).code).toBe("sql")
  })
})

describe("verify", () => {
  const captured = async () => {
    const base = root()
    const objects = join(base, "objects")
    const digest = plantBlob(objects, "verified-artifact")
    const backupDirectory = join(base, "backup")
    const manifest = await run(
      DisasterRecovery.backup({ directory: backupDirectory, objectsDirectory: objects })
    )
    return { base, backupDirectory, manifest, digest }
  }

  it("refuses a directory with no manifest", async () => {
    const empty = root()
    const exit = await run(DisasterRecovery.verify(empty).pipe(Effect.exit))
    expect(failure(exit).code).toBe("missing_file")
  })

  it("refuses a manifest that does not decode", async () => {
    const { backupDirectory } = await captured()
    writeFileSync(join(backupDirectory, DisasterRecovery.manifestFileName), "{\"formatVersion\": 2}")
    const exit = await run(DisasterRecovery.verify(backupDirectory).pipe(Effect.exit))
    expect(failure(exit).code).toBe("invalid_manifest")
  })

  it("refuses a database snapshot that rotted in storage", async () => {
    const { backupDirectory } = await captured()
    appendFileSync(join(backupDirectory, DisasterRecovery.databaseFileName), "rot")
    const exit = await run(DisasterRecovery.verify(backupDirectory).pipe(Effect.exit))
    expect(failure(exit).code).toBe("digest_mismatch")
  })

  it("refuses a backup whose database file vanished", async () => {
    const { backupDirectory } = await captured()
    rmSync(join(backupDirectory, DisasterRecovery.databaseFileName))
    const exit = await run(DisasterRecovery.verify(backupDirectory).pipe(Effect.exit))
    expect(failure(exit).code).toBe("missing_file")
  })

  it("refuses a backup missing a listed artifact blob", async () => {
    const { backupDirectory, digest } = await captured()
    rmSync(join(backupDirectory, DisasterRecovery.objectsDirectoryName, digest.slice(0, 2), digest))
    const exit = await run(DisasterRecovery.verify(backupDirectory).pipe(Effect.exit))
    expect(failure(exit).code).toBe("missing_file")
  })
})

describe("restore", () => {
  it("lands the verified store, the blobs, and the restored marker", async () => {
    const base = root()
    const objects = join(base, "objects")
    const digest = plantBlob(objects, "restored-artifact")
    const backupDirectory = join(base, "backup")
    const manifest = await run(
      DisasterRecovery.backup({ directory: backupDirectory, objectsDirectory: objects })
    )

    const target = join(base, "restored")
    const restored = await run(DisasterRecovery.restore({ backupDirectory, targetDirectory: target }))

    expect(restored.databaseFile).toBe(join(target, DisasterRecovery.databaseFileName))
    expect(restored.objectsDirectory).toBe(join(target, DisasterRecovery.objectsDirectoryName))
    expect(restored.manifest).toEqual(manifest)
    expect(sha256(readFileSync(restored.databaseFile))).toBe(manifest.database.sha256)
    expect(sha256(readFileSync(join(restored.objectsDirectory, digest.slice(0, 2), digest)))).toBe(digest)
    const marker = JSON.parse(
      readFileSync(join(target, DisasterRecovery.restoredMarkerFileName), "utf8")
    ) as { backupCreatedAtMs: number; databaseSha256: string }
    expect(marker.backupCreatedAtMs).toBe(manifest.createdAtMs)
    expect(marker.databaseSha256).toBe(manifest.database.sha256)
  })

  it("refuses a target directory that already holds anything", async () => {
    const base = root()
    const backupDirectory = join(base, "backup")
    await run(DisasterRecovery.backup({ directory: backupDirectory }))
    const target = join(base, "restored")
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, "existing.txt"), "occupied")
    const exit = await run(
      DisasterRecovery.restore({ backupDirectory, targetDirectory: target }).pipe(Effect.exit)
    )
    expect(failure(exit).code).toBe("not_empty")
  })

  it("offers a one-shot restore-and-fence API over a supplied database layer", async () => {
    const base = root()
    const backupDirectory = join(base, "backup")
    const manifest = await run(DisasterRecovery.backup({ directory: backupDirectory }))
    const restored = await run(
      DisasterRecovery.restoreAndFence({
        backupDirectory,
        targetDirectory: join(base, "restored"),
        databaseLayer: restoredDatabase
      })
    )

    expect(restored.manifest).toEqual(manifest)
    expect(restored.fence).toEqual({ clearedClaims: 0, suspendedRuns: 0 })
    const marker = JSON.parse(
      readFileSync(join(base, "restored", DisasterRecovery.restoredMarkerFileName), "utf8")
    ) as { databaseSha256: string }
    expect(marker.databaseSha256).toBe(manifest.database.sha256)
  })
})

describe("fence", () => {
  const restoredStore = async () => {
    const base = root()
    const backupDirectory = join(base, "backup")
    const manifest = await run(DisasterRecovery.backup({ directory: backupDirectory }))
    const restored = await run(
      DisasterRecovery.restore({ backupDirectory, targetDirectory: join(base, "restored") })
    )
    return { manifest, restored }
  }

  it("admits the exact schema and reports an unfenced empty store", async () => {
    const { manifest, restored } = await restoredStore()
    const summary = await runPromise(
      DisasterRecovery.fence(manifest).pipe(Effect.provide(restoredDatabase(restored.databaseFile)))
    )
    expect(summary).toEqual({ clearedClaims: 0, suspendedRuns: 0 })
  })

  it("admits a database migrated forward past the manifest", async () => {
    const { manifest, restored } = await restoredStore()
    const shorter = {
      ...manifest,
      database: {
        ...manifest.database,
        migrations: manifest.database.migrations.slice(0, manifest.database.migrations.length - 1)
      }
    }
    const summary = await runPromise(
      DisasterRecovery.fence(shorter).pipe(Effect.provide(restoredDatabase(restored.databaseFile)))
    )
    expect(summary).toEqual({ clearedClaims: 0, suspendedRuns: 0 })
  })

  it("refuses a manifest recording migrations the database never applied", async () => {
    const { manifest, restored } = await restoredStore()
    const longer = {
      ...manifest,
      database: {
        ...manifest.database,
        migrations: [...manifest.database.migrations, { migrationId: 99_999, name: "future_change" }]
      }
    }
    const exit = await runPromise(
      DisasterRecovery.fence(longer).pipe(
        Effect.exit,
        Effect.provide(restoredDatabase(restored.databaseFile))
      )
    )
    expect(failure(exit).code).toBe("schema_mismatch")
  })

  it("refuses a database whose applied ladder diverges from the manifest", async () => {
    const { manifest, restored } = await restoredStore()
    const diverged = {
      ...manifest,
      database: {
        ...manifest.database,
        migrations: manifest.database.migrations.map((migration, index) =>
          index === 0 ? { ...migration, name: "someone_elses_ladder" } : migration
        )
      }
    }
    const exit = await runPromise(
      DisasterRecovery.fence(diverged).pipe(
        Effect.exit,
        Effect.provide(restoredDatabase(restored.databaseFile))
      )
    )
    expect(failure(exit).code).toBe("schema_mismatch")
  })
})
