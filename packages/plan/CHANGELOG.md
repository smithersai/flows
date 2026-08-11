# @smthrs/plan

## [Unreleased]

### Added

- The persisted plan: `Plan` (compile, append, conflict annotation),
  `PlanStore` (append-only SQL, migration block `4000`), `PlanDiff`, and the
  `KeyMaterial` → `StepKey` compiler revived from the module deleted at
  `f5f3dda` — now producing `@smthrs/keys` `Key` values rather than a second
  digest format.
