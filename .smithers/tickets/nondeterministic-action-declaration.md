# Surface declared nondeterminism for keyed actions

Plan-scheduled sealed steps can declare that multiple recorded results are legitimate. The declaration is folded into both plan and dispatch keys, persisted on attempt metadata, and makes cache conflicts resolve as first-writer-wins without invoking the hermeticity `Inconsistency` receiver.

The keyed-action path does not yet expose the same declaration. Add an optional literal-`true` declaration to the flow `Action` builder, fold it into the sealed keyed identity in `packages/engine/src/FlowEngine/ActionKey.ts`, carry it through `FlowEngine.ActionExecuteOptions` in `Encoded.ts` and `make.ts`, then forward it from `packages/engine-store/src/EngineStore.ts` to `ActionPersistence.ActionInput.nondeterministic`. Absence must keep existing keys byte-identical and continue to claim determinism.

Acceptance test: run two durable keyed sealed actions with identical declared inputs and declared nondeterminism so both observe a miss and produce different encoded results. Both runs succeed with their own durable attempt result, the shared cache retains the first row, and the laggard journals one idempotent `conflict_first_writer` provenance record. The same setup without the declaration still fails with `CacheConflictDetected`, and a later cache hit replays normally without executing the action body.
