/**
 * The production `ControlExecutor`: the composition root that runs an agent
 * flow on the durable engine when the control plane accepts a launch.
 *
 * `ControlLive.run` resolves the executor through `Effect.serviceOption`, and
 * until this module existed nothing provided one, so every accepted run stayed
 * `pending` forever. This is the missing artifact: it takes a stored plan,
 * finds the flow's descriptor and prompt body in the registry, resolves the
 * seat's model route, and executes `CellHarness.run` as the body of one
 * durable flow execution whose id is the control run id.
 *
 * What the composition declares, because the spec says a host must:
 *
 * - **Explicit sandbox limits.** `Options.limits` is required; an unlimited
 *   QuickJS cell can hang the frame, so there is no default-unlimited path.
 * - **A resolved context window.** `Seat.contextWindowTokens` comes back from
 *   the host's resolver, so compaction is armed instead of silently disabled
 *   at zero. {@link contextWindowTokensFor} is the catalog for known models.
 * - **Steering from the durable queue.** The `Steering.Source` is
 *   `@smthrs/harness/Notifications` over the same journal-backed queue
 *   `Control.steer` admits into, so an operator steer reaches the loop at the
 *   next frame boundary.
 * - **Approval through control.** The `ask` flow is gated in the `authorize`
 *   hook — before the durable boundary opens — by registering an in-run
 *   approval token (`ControlRuntime.registerApproval`) and failing with an
 *   encoded `Permission.PermissionRequired`, which the controller turns into
 *   a real durable park. `Control.approve` resolves the token and installs
 *   the grant; the resumed attempt re-asks against the grant store as it now
 *   stands and proceeds. The park is decided outside the activity on purpose:
 *   a requirement raised inside one would be journaled and replayed forever.
 *
 * Run-status writes stay fenced: the executor waits for the control plane's
 * own `running` transition before the engine starts, writes
 * `waiting-approval` when the execution parks, and writes the terminal status
 * when it settles. Resumption is event-driven — the executor follows the
 * journal for the control plane's resume events and re-drives the parked
 * engine execution.
 *
 * Reference consulted: `reference/effect` `unstable/workflow` by way of
 * `@smthrs/engine`'s `FlowRuntime` (register/execute/poll/resume), and
 * `reference/opencode` `packages/core/src/session` for the shape of a
 * background run driver owned by a scope.
 *
 * @since 0.1.0
 */
import * as Capability from "@smthrs/capability-next/Capability"
import * as Permission from "@smthrs/capability-next/Permission"
import { LaunchFailed } from "@smthrs/control/ControlError"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { ApprovalPayload, Envelope, RunStatus } from "@smthrs/control/ControlSchema"
import * as Digest from "@smthrs/core/Digest"
import { Flow, FlowRuntime } from "@smthrs/flow-next"
import type * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as HarnessError from "@smthrs/harness/HarnessError"
import * as Notifications from "@smthrs/harness/Notifications"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import * as Steering from "@smthrs/harness/Steering"
import { Journal, JournalEvent } from "@smthrs/journal-next"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import type * as Model from "@smthrs/model/Model"
import type { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan-next"
import * as Registry from "@smthrs/registry/Registry"
import type { Crypto } from "effect"
import { Cause, Duration, Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect"
import * as CellHarness from "./CellHarness.ts"
import type * as FlowEngineLike from "./FlowEngineLike.ts"
import * as StandardFlows from "./StandardFlows.ts"

/**
 * One resolved seat: the model to stream from, the route that seals its
 * requests, and the model's context window so compaction has a real budget.
 *
 * @category models
 * @since 0.1.0
 */
export interface Seat {
  readonly model: Model.Model
  readonly route: FlowEngineLike.RouteResolver
  readonly contextWindowTokens: number
}

/**
 * A seat the host could not turn into a model route — an unknown provider, a
 * missing API key, an invalid endpoint.
 *
 * @category errors
 * @since 0.1.0
 */
export class SeatUnresolved extends Schema.TaggedError<SeatUnresolved>()(
  "flows/engine-harness/SeatUnresolved",
  {
    seat: Schema.String,
    message: Schema.String
  }
) {}

/**
 * Everything the host decides about the composition.
 *
 * `limits` is required on purpose: the composition never runs a cell without
 * an explicit memory and step budget. `flows` is the host's executable
 * catalog — filesystem, shell, memory — while the durable wait and the
 * control-wired approval are composed here, because they belong to the
 * engine and the control plane rather than to the host.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** Turns a `provider:modelId` seat into a model, a route, and a window. */
  readonly resolveSeat: (seat: string) => Effect.Effect<Seat, SeatUnresolved>
  /** Host executable-flow sources composed into every run's catalog. */
  readonly flows?: ReadonlyArray<FlowBinding.Source> | undefined
  /** The explicit sandbox budget every cell runs under. Never unlimited. */
  readonly limits: Sandbox.Limits
  /** Stable system teaching placed ahead of the cell contract. */
  readonly system?: ReadonlyArray<string> | undefined
  readonly maxFrames?: number | undefined
}

const contextWindows: ReadonlyArray<readonly [RegExp, number]> = [
  [/claude/i, 200_000],
  [/gpt-5/i, 400_000],
  [/gpt-4\.1/i, 1_000_000],
  [/gpt-4o/i, 128_000],
  [/^o[134]/i, 200_000]
]

/**
 * The context window, in tokens, of a known model id — with a conservative
 * floor for models the catalog has not met. Never zero: zero is `CellTurn`'s
 * "compaction disabled", and a composition that resolves a window must not
 * silently disable it.
 *
 * @category resolvers
 * @since 0.1.0
 */
export const contextWindowTokensFor = (modelId: string): number => {
  for (const [pattern, tokens] of contextWindows) {
    if (pattern.test(modelId)) return tokens
  }
  return 128_000
}

const sourceId = JournalEvent.SourceId.make("/control/executor")

/** The envelope an in-run ask approval binds to: the ask flow, nothing else. */
const askEnvelope: Envelope = { capabilities: [], flows: ["ask"], budget: {} }

interface AskInput {
  readonly question: string
  readonly options?: ReadonlyArray<string> | undefined
}

/**
 * The identity of one ask, derived from its run and whole input. Including the
 * run id prevents a grant for a byte-identical question in one run from
 * answering it in another, while remaining stable across this run's park and
 * resumed attempt. The raw call input and its decoded form digest identically
 * — both are plain JSON and canonical serialization sorts keys.
 */
const askIdentity = (
  runId: string,
  input: unknown
): { readonly digest: string; readonly requestId: string } => {
  const digest = Digest.digest(CanonicalJson.stringify({ input, runId }))
  return { digest, requestId: `ask/${runId}/${digest}` }
}

/**
 * Parses one formatted capability into the pattern schema, refusing anything
 * it cannot name. Dropping an unparseable entry narrows authority — the
 * fail-closed direction — because an empty envelope grants nothing.
 */
const pattern = (formatted: string): Option.Option<Capability.CapabilityPattern> => {
  const first = formatted.indexOf(":")
  if (first < 0) return Option.none()
  const head = formatted.slice(0, first)
  if (head === "*") {
    return Schema.decodeUnknownOption(Capability.CapabilityPattern)({
      action: "*",
      resource: formatted.slice(first + 1)
    })
  }
  const second = formatted.indexOf(":", first + 1)
  if (second < 0) return Option.none()
  return Schema.decodeUnknownOption(Capability.CapabilityPattern)({
    action: formatted.slice(0, second),
    resource: formatted.slice(second + 1)
  })
}

const patterns = (capabilities: ReadonlyArray<string>): ReadonlyArray<Capability.CapabilityPattern> =>
  capabilities.flatMap((formatted) => {
    const parsed = pattern(formatted)
    return Option.isSome(parsed) ? [parsed.value] : []
  })

/**
 * Renders the prompt-flow body and its decoded input into the task the run is
 * admitted with. An absent or empty input adds nothing.
 */
const prompt = (text: string, input: unknown): string => {
  const rendered = input == null ? "null" : JSON.stringify(input, null, 2)
  return rendered === "null" || rendered === "{}"
    ? text.trim()
    : `${text.trim()}\n\nInput:\n${rendered}`
}

/**
 * The one durable flow every agent run executes. Its plan-time body is inert;
 * the behaviour is the `execute` registered by {@link make}, and the
 * execution id is the control run id.
 */
const agentFlow = Flow.make("engine-harness/agent", {
  payload: { runId: Schema.String, planId: Schema.String },
  success: Schema.Unknown,
  error: Schema.Unknown,
  /* v8 ignore next -- the plan-time body is inert; register supplies the execute. */
  body: () => Node.succeed(undefined)
})

/**
 * Waits for ControlLive to publish its running transition before a driver
 * starts the engine. Keeping the bounded retry here makes the publication race
 * deterministic to exercise without coupling it to a particular scheduler.
 *
 * @category helpers
 * @since 0.1.0
 */
export const waitForRunning = (
  status: (runId: string) => Effect.Effect<RunStatus, unknown>,
  runId: string,
  attempts: number
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    if ((yield* status(runId)) === "accepted" && attempts > 0) {
      yield* Effect.yieldNow
      return yield* waitForRunning(status, runId, attempts - 1)
    }
  })

/**
 * Polls a durable execution until it is published as parked. A missing poll is
 * a still-live execution, so retries are bounded before a resume is attempted.
 *
 * @category helpers
 * @since 0.1.0
 */
export const waitForParked = (
  poll: () => Effect.Effect<Option.Option<{ readonly _tag: string }>, unknown>,
  attempts: number
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function*() {
    const result = yield* poll()
    if (Option.isNone(result)) {
      if (attempts <= 0) return false
      yield* Effect.sleep(Duration.millis(10))
      return yield* waitForParked(poll, attempts - 1)
    }
    return result.value._tag === "Suspended"
  })

/**
 * Keeps a control cancellation durable even when its engine interrupt fails.
 *
 * @category helpers
 * @since 0.1.0
 */
export const preserveDriverInterrupt = <R>(
  interrupt: () => Effect.Effect<void, unknown, R>
): Effect.Effect<void, never, R> => interrupt().pipe(Effect.catchCause(() => Effect.void))

/**
 * Translates a failed driver registration into the executor's launch error.
 *
 * @category helpers
 * @since 0.1.0
 */
export const registerDriver = (
  register: () => Effect.Effect<void, unknown>,
  runId: string
): Effect.Effect<void, LaunchFailed> =>
  register().pipe(
    Effect.mapError((cause) =>
      new LaunchFailed({
        runId,
        message: "The run driver could not be registered for cancellation",
        cause
      })
    )
  )

/**
 * Re-throws a cancelled driver while logging a non-interrupt engine failure.
 *
 * @category helpers
 * @since 0.1.0
 */
export const settleDriverFailure = (cause: Cause.Cause<unknown>, runId: string): Effect.Effect<void> =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.interrupt
    : Effect.annotateLogs(
      Effect.logError("An accepted agent run could not start on the engine"),
      { runId, cause: Cause.pretty(cause) }
    )

/** Everything the executor captures at construction and re-provides per run. */
type Services =
  | ControlRuntime
  | Crypto.Crypto
  | FlowRuntime.FlowRuntime
  | Journal.Journal
  | NotificationQueue.NotificationQueue
  | Registry.Registry

/**
 * Constructs the production executor.
 *
 * Must be built in a scope: the scope owns the registered agent flow, every
 * forked run driver, and the resume bridge that follows the journal.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options
): Effect.Effect<ControlExecutor.Service, never, Services | Scope.Scope> =>
  Effect.gen(function*() {
    const runtime = yield* ControlRuntime
    const journal = yield* Journal.Journal
    const registry = yield* Registry.Registry
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const services = yield* Effect.context<Services>()

    const emit = (
      runId: string,
      eventType: string,
      payload: unknown
    ): Effect.Effect<void, unknown> =>
      journal.emitDurable(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(runId),
          sourceId,
          eventType,
          payload: JSON.parse(JSON.stringify(payload))
        })
      )

    /**
     * Decides one ask before its durable boundary opens. An unresolved ask
     * registers its token, publishes the exact approval payload an operator
     * replays through `flows approve`, and parks the run with an encoded
     * `PermissionRequired`; a resolved one lets the activity run and read the
     * decision.
     */
    const authorize = (runId: string) => (call: Cell.Call): Effect.Effect<void, HarnessError.HarnessError> =>
      Effect.gen(function*() {
        if (call.flowName !== StandardFlows.askFlow.name) return
        const input = call.input as unknown as AskInput
        const identity = askIdentity(runId, call.input)
        const target = {
          _tag: "Node" as const,
          runId,
          requestId: identity.requestId,
          digest: identity.digest,
          envelope: askEnvelope
        }
        const token = yield* runtime.registerApproval(target).pipe(
          Effect.mapError(
            /* v8 ignore next 7 -- only a mid-run control-store failure reaches this. */
            (cause) =>
              new HarnessError.HarnessError({
                code: "engine_failed",
                message: "The approval request could not be registered with the control plane",
                cause
              })
          )
        )
        if (token.resolved) return
        const payload: ApprovalPayload = {
          target,
          scope: "run",
          idempotencyKey: `approve:${identity.requestId}`
        }
        yield* emit(runId, "control.approval.requested", {
          runId,
          requestId: identity.requestId,
          question: input.question,
          payload
        }).pipe(
          Effect.mapError(
            /* v8 ignore next 7 -- only a mid-run journal failure reaches this. */
            (cause) =>
              new HarnessError.HarnessError({
                code: "engine_failed",
                message: "The approval request could not be journaled",
                cause
              })
          )
        )
        return yield* Effect.fail(
          new HarnessError.HarnessError({
            code: "engine_failed",
            message: `Approval required: ${input.question}`,
            cause: Schema.encodeUnknownSync(Permission.PermissionRequired)(
              new Permission.PermissionRequired({
                code: "permission_required",
                requestId: identity.requestId,
                runId,
                // No action in the capability vocabulary names a human
                // decision; the request carries the question in `meta` and
                // the model seat's own action as the closest formal claim.
                capability: Capability.make("model:call", `ask/${identity.digest}`),
                tier: "irreversible",
                meta: { question: input.question }
              })
            )
          })
        )
      })

    /**
     * Answers a decided ask from the grant store. The activity only runs once
     * {@link authorize} has seen the token resolved, so the read is stable:
     * an approval installed a grant under the request id, a denial did not.
     */
    const asker = (runId: string): StandardFlows.Asker => ({
      ask: (input) =>
        Effect.gen(function*() {
          const identity = askIdentity(runId, input)
          const grants = yield* runtime.grants.pipe(
            Effect.mapError(
              /* v8 ignore next 7 -- only a mid-run grant-store failure reaches this. */
              (cause) =>
                new HarnessError.HarnessError({
                  code: "engine_failed",
                  message: `The grant store could not be read for run ${runId}`,
                  cause
                })
            )
          )
          const approved = grants.some((grant) => grant.tokenId === identity.requestId)
          return { answer: approved ? "approved" : "denied", approved }
        })
    })

    /** Writes one fenced status transition and its journal record. */
    const writeStatus = (runId: string, status: RunStatus): Effect.Effect<void> =>
      Effect.gen(function*() {
        const fence = yield* runtime.claimFence(runId)
        yield* runtime.writeStatus(runId, fence, status)
        yield* emit(runId, `control.run.${status}`, { runId, status })
      }).pipe(
        Effect.catchCause(
          /* v8 ignore next 6 -- reached only when a cancel raced the fence away. */
          (cause) =>
            Effect.annotateLogs(
              Effect.logWarning("An agent run status could not be written"),
              { runId, status, cause: Cause.pretty(cause) }
            )
        )
      )

    /**
     * Settles the control-plane status from one execution attempt's exit. A
     * suspension surfaces as an interrupt-only cause — the engine parked the
     * frame — and every re-executed attempt settles again, so the resumed
     * run writes its own terminal status.
     */
    const settle = (
      runId: string,
      suspended: boolean,
      exit: Exit.Exit<unknown, unknown>
    ): Effect.Effect<void> =>
      Exit.isSuccess(exit)
        ? writeStatus(runId, "completed")
        // Flow suspension deliberately interrupts the user body. Process
        // shutdown and Control.cancel do too, but neither sets the durable
        // execution's suspension bit; reporting those as an approval wait
        // would leave a cancelled run looking resumable.
        : suspended && Cause.hasInterruptsOnly(exit.cause)
        ? writeStatus(runId, "waiting-approval")
        : Effect.andThen(
          Effect.annotateLogs(Effect.logWarning("An agent run failed"), {
            runId,
            cause: Cause.pretty(exit.cause)
          }),
          writeStatus(runId, "failed")
        )

    /** One agent run, executed as the whole of one durable flow execution. */
    const body = (payload: { readonly runId: string; readonly planId: string }) =>
      Effect.gen(function*() {
        const plan = yield* runtime.getPlan(payload.planId)
        const card = plan.card
        const descriptor = yield* registry.get(card.flowId)
        // The launch already validated the seat and body; re-validation here
        // guards a registry that changed between acceptance and execution.
        const seatId = yield* Effect.fromOption(
          descriptor.model,
          /* v8 ignore next -- launch refuses a seatless flow before the body runs. */
          () => new SeatUnresolved({ seat: card.flowId, message: `Flow ${card.flowId} declares no model seat` })
        )
        const flowBody = yield* registry.loadBody(card.flowId)
        /* v8 ignore next 8 -- launch leaves a module-bodied flow pending before the body runs. */
        if (flowBody._tag !== "Prompt") {
          return yield* Effect.fail(
            new SeatUnresolved({
              seat: seatId,
              message: `Flow ${card.flowId} has a module body; only prompt flows run on the cell harness`
            })
          )
        }
        const seat = yield* options.resolveSeat(seatId)
        const steering = yield* Notifications.make({ runId: payload.runId, lineageId: payload.runId })
        const engineServices = yield* Effect.context<FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>()
        const tags: Array<string> = []
        yield* CellHarness.run({
          session: payload.runId,
          seat: seatId,
          prompt: prompt(flowBody.text, plan.decodedInput),
          system: options.system,
          model: seat.model,
          route: seat.route,
          registry,
          flows: [
            ...(options.flows ?? []),
            StandardFlows.clock(engineServices),
            StandardFlows.approval(asker(payload.runId))
          ],
          authorize: authorize(payload.runId),
          capabilityEnvelope: patterns(card.envelope.capabilities),
          contextWindowTokens: seat.contextWindowTokens,
          limits: options.limits,
          maxFrames: options.maxFrames
        }).pipe(
          Stream.runForEach((event) => Effect.sync(() => tags.push(event._tag))),
          Effect.provide(QuickJSSandbox.layer),
          Effect.provideService(Steering.Source, steering)
        )
        return tags
      })

    const driver = (runId: string, planId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        yield* waitForRunning(
          (id) => runtime.getRun(id).pipe(Effect.orDie, Effect.map((run) => run.status)),
          runId,
          4000
        )
        yield* engine.execute(agentFlow, {
          executionId: runId,
          payload: { runId, planId },
          discard: true
        }).pipe(
          // ControlRuntime owns this driver fiber. Turn that cancellation
          // into the engine's durable cancellation before the fiber exits.
          Effect.onInterrupt(() => preserveDriverInterrupt(() => engine.interrupt(agentFlow, runId)))
        )
      }).pipe(
        Effect.catchCause((cause) => settleDriverFailure(cause, runId))
      )

    const awaitParked = (runId: string, attempts: number): Effect.Effect<boolean, unknown> =>
      waitForParked(
        () =>
          engine.poll(agentFlow, runId).pipe(
            // The journal carries resume events for runs other executors own —
            // a paused system flow, a shared control database. An execution
            // this engine does not know will not become parked by waiting, so
            // it is published as a settled non-parked state: the wait ends
            // now instead of holding the single-concurrency bridge through
            // the whole retry budget.
            Effect.catchTag(
              "@smthrs/flow-next/FlowExecutionNotFound",
              () => Effect.succeed(Option.some({ _tag: "NotFound" }))
            )
          ),
        attempts
      )

    const resumeExecution = (runId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const parked = yield* awaitParked(runId, 500)
        // False when the execution settled before the resume arrived, or when
        // the resumed run belongs to an executor other than this one.
        if (parked) yield* engine.resume(agentFlow, runId)
      }).pipe(
        Effect.catchCause(
          /* v8 ignore next 6 -- reached only when the engine refuses the re-drive. */
          (cause) =>
            Effect.annotateLogs(
              Effect.logWarning("A parked agent run could not be resumed"),
              { runId, cause: Cause.pretty(cause) }
            )
        )
      )

    /**
     * Follows the journal for the control plane's resume events and re-drives
     * the parked engine execution. `Control.resume` and `Control.run`'s
     * `Resume` branch record different event types; both mean the same thing
     * here.
     */
    const resumeBridge = Effect.gen(function*() {
      const subscription = yield* journal.changes
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter((entry) => entry.eventType === "control.run.resume" || entry.eventType === "control.run.resumed"),
        Stream.mapEffect((entry) => resumeExecution(entry.runId), { concurrency: 1 }),
        Stream.runDrain
      )
    }).pipe(
      Effect.catchCause(
        /* v8 ignore next 6 -- reached only when the journal subscription itself fails. */
        (cause) =>
          Effect.annotateLogs(
            Effect.logError("The executor resume bridge stopped"),
            { cause: Cause.pretty(cause) }
          )
      )
    )

    yield* engine.register(agentFlow, (payload) =>
      Effect.gen(function*() {
        const instance = yield* FlowRuntime.FlowInstance
        return yield* body(payload).pipe(
          Effect.onExit((exit) => settle(payload.runId, instance.suspended, exit)),
          Effect.provide(services)
        )
      })).pipe(Scope.provide(scope))

    yield* Effect.forkIn(resumeBridge, scope)

    const launch = (
      input: ControlExecutor.Launch
    ): Effect.Effect<ControlExecutor.Acceptance, LaunchFailed> =>
      Effect.gen(function*() {
        const flowId = input.plan.card.flowId
        const descriptor = yield* registry.getOption(flowId)
        if (Option.isNone(descriptor) || Option.isNone(descriptor.value.model)) {
          // Not an agent flow — a system flow, or a flow this composition
          // cannot execute. Pending is the honest acceptance: nothing runs.
          return "pending" as const
        }
        const flowBody = yield* registry.loadBody(flowId).pipe(
          Effect.mapError(
            /* v8 ignore next 6 -- reached only when a discovered body becomes unreadable. */
            (cause) =>
              new LaunchFailed({
                runId: input.run.runId,
                message: `The body of flow ${flowId} could not be loaded`,
                cause: String(cause)
              })
          )
        )
        if (flowBody._tag !== "Prompt") return "pending" as const
        // Resolve the seat now, so a missing key refuses the launch as a
        // typed failure instead of failing the run after it was accepted.
        yield* options.resolveSeat(descriptor.value.model.value).pipe(
          Effect.mapError((error) =>
            new LaunchFailed({
              runId: input.run.runId,
              message: error.message,
              cause: { seat: error.seat }
            })
          )
        )
        const fiber = yield* Effect.forkIn(driver(input.run.runId, input.plan.card.planId), scope)
        yield* registerDriver(
          () => runtime.registerFiber(input.run.runId, fiber),
          input.run.runId
        )
        return "accepted" as const
      })

    return ControlExecutor.make({
      launch: Effect.fn("HarnessExecutor.launch")(launch)
    })
  })

/**
 * Provides the production {@link ControlExecutor.ControlExecutor}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<ControlExecutor.ControlExecutor, never, Services> =>
  Layer.effect(ControlExecutor.ControlExecutor)(make(options))
