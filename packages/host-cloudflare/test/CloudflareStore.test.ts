import { describe, expect, it } from "vitest"
import * as CloudflareStore from "../src/CloudflareStore.ts"

describe("CloudflareStore", () => {
  it("exports the Durable Object database layer constructor", () =>
    expect(CloudflareStore.layer).toBeTypeOf("function"))
})
