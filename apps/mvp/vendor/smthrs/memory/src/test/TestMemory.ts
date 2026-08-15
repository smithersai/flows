/**
 * In-memory SQLite memory layer for tests.
 *
 * @since 0.1.0
 */
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Layer from "effect/Layer"
import * as MemoryStore from "../MemoryStore.ts"

/**
 * Provides the authoritative memory store over a fresh in-memory database.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = MemoryStore.layer.pipe(Layer.provide(TestDatabase.layer))

/**
 * Provides both the authoritative memory store and its in-memory Database.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWithDatabase = Layer.provideMerge(MemoryStore.layer, TestDatabase.layer)
