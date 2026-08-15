import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Framing from "../src/Framing.ts"

const encoder = new TextEncoder()

const split = (input: Uint8Array, size: number): ReadonlyArray<Uint8Array> => {
  const chunks: Array<Uint8Array> = []
  for (let index = 0; index < input.length; index += size) chunks.push(input.slice(index, index + size))
  return chunks
}

const decode = (input: string, size: number) =>
  Effect.runPromise(
    Stream.runCollect(Framing.sse.frame(Stream.fromIterable(split(encoder.encode(input), size))))
  ).then(Array.from)

describe("Framing.sse", () => {
  const fixture =
    ": keepalive\r\nid: event-1\r\nevent: message\r\ndata: first\r\ndata: second\r\n\r\nevent: unicode\ndata: café\n\n"
  const expected = ["first\nsecond", "café"]

  it.each([1, 3, 7, 4096])("decodes byte-split SSE at chunk size %s", async (size) => {
    await expect(decode(fixture, size)).resolves.toEqual(expected)
  })

  it("drops the terminal sentinel before protocol JSON decoding", async () => {
    await expect(decode("data: [DONE]\n\n", 1)).resolves.toEqual([])
  })

  it("drops a truncated final frame without failing the stream", async () => {
    await expect(decode("data: complete\n\ndata: incomplete", 3)).resolves.toEqual(["complete"])
  })

  it("deliberately ignores retry directives", async () => {
    await expect(decode("data: before\n\nretry: 100\n\ndata: after\n\n", 2)).resolves.toEqual(["before", "after"])
  })
})
