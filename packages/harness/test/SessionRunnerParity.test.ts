/**
 * OpenCode session-runner parity.
 * Coverage manifest: `docs/reference/test-parity.md`.
 */
import { Cause, Effect, Exit, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import { HarnessError } from "../src/HarnessError.ts"
import { input, make as makeSession, type RecordedSession } from "./fixtures/recordedSession.ts"

const run = (session: RecordedSession) => Effect.runPromise(session.run(input()))

const errorFrom = (exit: Exit.Exit<ReadonlyArray<AgentEvent.AgentEvent>, HarnessError>): HarnessError | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

describe("Session runner parity", () => {
  it("replays the same recorded session with identical requests and events", async () => {
    const first = makeSession()
    const second = makeSession()
    const firstEvents = await run(first)
    const secondEvents = await run(second)

    expect(first.sealedRequests).toEqual(second.sealedRequests)
    expect(firstEvents).toEqual(secondEvents)
    expect(first.emittedEvents).toEqual(firstEvents)
    expect(second.emittedEvents).toEqual(secondEvents)
  })

  it("projects exactly the permitted active tools into every sealed request", async () => {
    const session = makeSession()
    await run(session)

    expect(session.sealedRequests.map((request) => request.tools.map((tool) => tool.name))).toEqual([
      ["alpha", "beta"],
      ["alpha", "beta"]
    ])
    expect(
      session.sealedRequests.every((request) =>
        request.tools.every((tool) => tool.name === "alpha" || tool.name === "beta")
      )
    ).toBe(true)
  })

  it("keeps each tool lifecycle start/progress*/settle order while restoring model-call order", async () => {
    const session = makeSession()
    const events = await run(session)

    for (const callId of ["call-alpha", "call-beta"]) {
      const lifecycle = events.filter((event) =>
        event._tag === "child-progress"
          ? event.progress.callId === callId
          : event._tag === "child-result" && event.result.callId === callId
      )
      expect(lifecycle[0]?._tag).toBe("child-progress")
      expect(lifecycle.at(-1)?._tag).toBe("child-result")
      expect(lifecycle.slice(0, -1).every((event) => event._tag === "child-progress")).toBe(true)
    }

    expect(
      events.filter((event): event is AgentEvent.ChildResult => event._tag === "child-result").map((event) =>
        event.result.callId
      )
    ).toEqual([
      "call-alpha",
      "call-beta"
    ])

    const secondRequest = session.sealedRequests[1]
    const toolMessage = secondRequest?.messages.find((message) => message.role === "tool")
    expect(toolMessage?.role === "tool" ? toolMessage.content.map((part) => part.toolCallId) : []).toEqual([
      "call-alpha",
      "call-beta"
    ])
  })

  it("pairs every turn-one tool use with a turn-two tool result", async () => {
    const session = makeSession()
    await run(session)

    const secondRequest = session.sealedRequests[1]
    const firstSettlement = session.emittedEvents.find(
      (event): event is AgentEvent.ModelSettled => event._tag === "model-settled"
    )
    const toolUseIds = firstSettlement?.message.content.flatMap((part) => part.type === "tool-call" ? [part.id] : []) ??
      []
    const toolResultIds =
      secondRequest?.messages.flatMap((message) =>
        message.role === "tool" ? message.content.map((part) => part.toolCallId) : []
      ) ?? []

    expect(toolUseIds).toEqual(["call-alpha", "call-beta"])
    expect(toolResultIds).toEqual(toolUseIds)
  })

  it("continues after a real local tool failure with the durable error result", async () => {
    const session = makeSession("tool-failure")
    const events = await run(session)
    const failed = events.find(
      (event): event is AgentEvent.ChildResult => event._tag === "child-result" && event.result.callId === "call-alpha"
    )
    const secondRequest = session.sealedRequests[1]
    const replayed = secondRequest?.messages
      .flatMap((message) => message.role === "tool" ? message.content : [])
      .find((result) => result.toolCallId === "call-alpha")

    expect(failed?.result).toMatchObject({
      outcome: "error",
      result: {
        toolCallId: "call-alpha",
        content: "alpha failed locally"
      }
    })
    expect(replayed?.content).toBe("alpha failed locally")
    expect(session.sealedRequests).toHaveLength(2)
    expect(events.at(-1)?._tag).toBe("resolved")
    expect(session.exhausted()).toBe(true)
  })

  it("records partial content before terminating a mid-stream provider error", async () => {
    const session = makeSession("provider-error")
    const exit = await Effect.runPromiseExit(session.run(input()))
    const error = errorFrom(exit)
    const tags = session.emittedEvents.map((event) => event._tag)
    const partial = session.emittedEvents.find(
      (event): event is AgentEvent.ModelSettled => event._tag === "model-settled"
    )

    expect(error).toMatchObject({ _tag: "/harness/HarnessError", code: "model_failed" })
    expect(session.sealedRequests).toHaveLength(1)
    expect(tags[0]).toBe("turn-opened")
    expect(tags.filter((tag) => tag === "model-delta").length).toBeGreaterThan(0)
    expect(partial?.message).toEqual(
      expect.objectContaining({
        content: [{ type: "text", text: "The provider started the answer." }],
        stopReason: "error"
      })
    )
    expect(partial?.message.responseId).toBeUndefined()
    expect(partial?.message.itemIds).toBeUndefined()
    expect(tags).not.toContain("resolved")
    expect(session.emittedEvents.every((event) => event._tag !== "turn-closed")).toBe(true)
  })

  it("fully consumes the recorded script and never calls an unscripted step", async () => {
    const session = makeSession()
    await run(session)

    expect(session.exhausted()).toBe(true)
    expect(session.unscriptedRequests).toEqual([])
    expect(session.sealedRequests).toHaveLength(2)
    expect(session.emittedEvents.filter((event) => event._tag === "child-result")).toHaveLength(2)
  })
})
