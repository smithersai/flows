# @smthrs/time-travel

One injectable `TimeTravel` service — inspect, fork, rewind — over the journal
and engine-store contracts. It owns both in-memory and SQL state stores and
records effect-boundary evidence used to make time-travel decisions.

```sh
pnpm add @smthrs/time-travel
```

## Public API

Time travel is ONE injectable service. `TimeTravel` is exported flat — the
service key is the door — beside the namespaces you inject or integrate with,
also available from matching `@smthrs/time-travel/*` subpaths.

| Export                  | Public surface                                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TimeTravel`            | The service key. Operations `inspect(position, projection)`, `fork(position, options?)`, and `rewind(position, options?)`, where a `Position` is `{ runId, frame }`. `TimeTravel.layer` provides it from `TimeTravelStore`, `Journal`, `RunStore`, `CacheStore`, and `Jj`, and recovers on build.    |
| `Frame`                 | `Frame` schema/type plus `LineageEdgeKind` schema/type and `LineageEdge`.                                                                                                                                                                                                                            |
| `TimeTravelError`       | `TimeTravelErrorCode` schema/type, `TimeTravelError`, and `error(code, message, cause?)`.                                                                                                                                                                                                            |
| `TimeTravelStore`       | Models `Snapshot`, `Descendants`, `Audit`, `Receipt`, `ArchiveResult`, and `Fork`; `Service` / `TimeTravelStore` operations `snapshotAt`, `descendants`, `writeAudit`, `updateAudit`, `pendingAudits`, `archiveAndTruncate`, `createFork`, and `recordReceipt`; `make`, `makeNoop`, and `layerNoop`. |
| `MemoryTimeTravelStore` | `JournalRecord`, `MemoryState`, and `Options`; deterministic `make(options?)` and `layer(options?)`.                                                                                                                                                                                                 |
| `SqlTimeTravelStore`    | Database-backed `migrate`, `make`, and `layer`.                                                                                                                                                                                                                                                      |
| `EffectBoundary`        | The producer side: `EffectTier`, `EffectStatus`, `EffectRecord`, and `Description`; `eventType`; `guard`, `fromEntry`, and `fromEntries`.                                                                                                                                                            |

`Replay`, `Fork`, `Rewind`, `Retry`, `Recovery`, `Compensation`, and
`EffectHandlerRegistry` are internal machinery under `src/internal/`, blocked at
the package `exports` map. Recovery is never a call: building `TimeTravel.layer`
finishes or rolls back any rewind a crash interrupted.

A rewind (and its crash recovery) fences the run through the ordinary
`RunStore` ownership operations, and that fencing is journaled: the run
state fold makes a row write without its event impossible
(`docs/specs/Concepts/Run State Fold.md`), so the surgery's own
`claimed`/`activated` land inside the very suffix it archives — and are
archived with it — and its post-restore transitions and closing `released`
land past the restored frame and stay. Every consumer compensates by
namespace, not suppression: replay excludes the `flows.run.*`,
`flows.attempt.*`, and `flows.consensus.*` entries it does not own, and
recovery's archive-commit evidence — "no live entries after the frame" —
counts only entries replay owns. The audit row remains the durable record
of who drove a rewind, and cancelling a detached child stays recorded in
that child's surviving journal.

```ts
import { TimeTravel } from "@smthrs/time-travel"
import { Effect } from "effect"

const rewound = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  return yield* timeTravel.rewind({
    runId: "build-42",
    frame: { lineageId: "build-42/root", seq: 17 }
  })
})
```

See the [time-travel reference](../../docs/reference/time-travel.md) and
[time-travel concepts](../../docs/concepts/time-travel.md).
