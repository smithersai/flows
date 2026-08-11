import { Jj } from "@smthrs/jj"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { Frame } from "./Frame.ts"
import { error, type TimeTravelError } from "./TimeTravelError.ts"
import { type Fork as ForkResult, TimeTravelStore } from "./TimeTravelStore.ts"
/** @since 0.1.0 @category models */
export interface ForkOptions {
  readonly parentRunId: string
  readonly frame: Frame
  readonly workspaceName: string
  readonly workspacePath: string
}
/** @since 0.1.0 @category constructors */
export const fork = (
  options: ForkOptions
): Effect.Effect<ForkResult, TimeTravelError, TimeTravelStore | RunStore.RunStore | Jj | Scope.Scope> =>
  Effect.fn("Fork.fork")(() =>
    Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      const parent = yield* runs.get(options.parentRunId).pipe(
        Effect.mapError((cause) => error("unknown", "could not read parent", cause))
      )
      if (parent.status === "running" || parent.claim !== null || parent.owner !== null) {
        return yield* Effect.fail(error("live_parent", `parent run ${options.parentRunId} is live`))
      }
      const store = yield* TimeTravelStore
      const result = yield* store.createFork(options.parentRunId, options.frame)
      const jj = yield* Jj
      yield* jj.workspaceAdd(options.workspaceName, options.workspacePath).pipe(
        Effect.mapError((cause) => error("unknown", "could not add fork workspace", cause))
      )
      yield* Effect.addFinalizer(() => jj.workspaceForget(options.workspaceName).pipe(Effect.ignore))
      return result
    })
  )()
