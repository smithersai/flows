/**
 * The public, stable error contract of `@smithers/engine-store`.
 *
 * Every error here carries a `code` literal that is part of the public API:
 * consumers may switch on `code` (or `_tag`) and the strings will not change
 * without a major version. The classes themselves are declared next to the
 * logic that raises them (`internal/ActivityPersistence.ts`,
 * `@smithers/engine`'s `FlowEngine.ts`); this module is the barrel-exported
 * surface so that `internal/` never has to be imported by consumers.
 *
 * Design notes: [[Events And Errors]]
 * (`docs/specs/Concepts/Events And Errors.md`), [[Engine Hardening Round 1]]
 * (`docs/specs/Concepts/Engine Hardening Round 1.md`),
 * `docs/specs/Concepts/Run Ownership.md`,
 * `docs/architecture/implementation-status.md`.
 *
 * @since 0.1.0
 */
export { FlowCycleDetected } from "@smithers/engine/FlowEngine"
export { AttemptAdmissionRejected, CacheConflictDetected, CacheCorruptionDetected } from "./internal/ActivityPersistence.ts"
