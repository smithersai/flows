import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { GraphBuildError } from "../src/GraphBuildError.ts"
import * as internal from "../src/internal/node.ts"
import * as Node from "../src/Node.ts"
import * as Planned from "../src/Planned.ts"

const tagged = <T extends internal.NodeAst["_tag"]>(
  ast: Node.Ast,
  tag: T
): Extract<internal.NodeAst, { readonly _tag: T }> => {
  expect(ast._tag).toBe(tag)
  return ast as Extract<internal.NodeAst, { readonly _tag: T }>
}

describe("Node", () => {
  it("records a constant", () => {
    expect(Node.succeed(1).ast).toEqual({ _tag: "Succeed", value: 1 })
    expect(Node.isNode(Node.succeed(1))).toBe(true)
    expect(Node.isNode({ ast: { _tag: "Succeed", value: 1 } })).toBe(false)
  })

  it("combines independent children by name", () => {
    const node = Node.all({ left: Node.succeed(1), right: Node.succeed("two") })
    expect(tagged(node.ast, "All").nodes).toEqual({
      left: { _tag: "Succeed", value: 1 },
      right: { _tag: "Succeed", value: "two" }
    })
  })

  it("preserves an own __proto__ child", () => {
    const members = Object.create(null) as Record<string, Node.Any>
    Object.defineProperty(members, "__proto__", { enumerable: true, value: Node.succeed("safe") })
    const nodes = tagged(Node.all(members).ast, "All").nodes
    expect(Object.hasOwn(nodes, "__proto__")).toBe(true)
    expect(nodes.__proto__).toEqual({ _tag: "Succeed", value: "safe" })
  })

  it("refuses a member of Node.all that is not a node", () => {
    let refusal: unknown
    try {
      Node.all({ left: Node.succeed(1), right: 2 as unknown as Node.Any })
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(GraphBuildError)
    expect(refusal).toMatchObject({
      code: "invalid_all_member",
      node: "right",
      path: [],
      message: "Node.all expected a Node at member \"right\""
    })
  })

  it("stores a digest for a mapper and keeps the function beside the AST", () => {
    const node = Node.succeed(2).pipe(Node.map((value) => value + 1))
    const ast = tagged(node.ast, "Map")
    expect(ast.first).toEqual({ _tag: "Succeed", value: 2 })
    expect(ast.mapper).toMatchObject({ _tag: "FunctionIdentity", algorithm: "fnv1a32-source/v1" })
    expect(ast.mapper.digest).toMatch(/^[0-9a-f]{8}$/)
    expect(internal.operation(ast)?.(2)).toBe(3)
  })

  it("defers a continuation builder and reveals nothing until the graph is built", () => {
    let built = 0
    const node = Node.succeed(2).pipe(Node.andThen((value: Planned.Planned<number>) => {
      built++
      return Node.succeed(value)
    }))
    const ast = tagged(node.ast, "AndThen")
    expect(built).toBe(0)
    expect(ast.next).toBeUndefined()
    expect(ast.continuation.digest).not.toBe("static-node")
    const continued = internal.operation(ast)?.(Planned.make<number>("upstream"))
    expect(built).toBe(1)
    expect(Node.isNode(continued)).toBe(true)
  })

  it("records a directly supplied continuation as static topology", () => {
    const node = Node.succeed(2).pipe(Node.andThen(Node.succeed("done")))
    const ast = tagged(node.ast, "AndThen")
    expect(ast.next).toEqual({ _tag: "Succeed", value: "done" })
    expect(ast.continuation.digest).toBe("static-node")
    expect(internal.operation(ast)).toBeUndefined()
  })

  it("refuses a direct continuation that is not a node", () => {
    expect(() => Node.andThen(Node.succeed(1), 2 as unknown as Node.Any)).toThrow(expect.objectContaining({
      code: "invalid_continuation",
      node: "andThen/next",
      message: "Node.andThen expected its direct continuation to be a Node"
    }))
  })

  it("builds each branch arm exactly once, against the symbolic subject", () => {
    const seen: Array<Planned.Reference | undefined> = []
    let evaluated = 0
    const node = Node.succeed(1).pipe(Node.branch({
      if: (value) => value >= 100,
      then: (value) => {
        evaluated++
        seen.push(Planned.reference(value))
        return Node.succeed("done")
      },
      else: (value) => {
        evaluated++
        seen.push(Planned.reference(value))
        return Node.succeed("again")
      }
    }))
    const ast = tagged(node.ast, "Branch")
    expect(evaluated).toBe(2)
    expect(seen).toHaveLength(2)
    expect(seen[0]?.node).toBe(ast.subject)
    expect(seen[1]?.node).toBe(ast.subject)
    expect(ast.subject).toMatch(/^branch\/subject\/\d+$/)
    expect(ast.first).toEqual({ _tag: "Succeed", value: 1 })
    expect(ast.then).toEqual({ _tag: "Succeed", value: "done" })
    expect(ast.else).toEqual({ _tag: "Succeed", value: "again" })
    expect(internal.predicate(ast)?.(100)).toBe(true)
    expect(internal.predicate(ast)?.(99)).toBe(false)
  })

  it("builds a catch failure arm once against its own symbolic error", () => {
    const seen: Array<Planned.Reference | undefined> = []
    let evaluated = 0
    const build = () =>
      Node.succeed(1).pipe(Node.catch({
        onFailure: (error: Planned.Planned<string>) => {
          evaluated++
          seen.push(Planned.reference(error))
          return Node.succeed(error)
        }
      }))
    const ast = tagged(build().ast, "Catch")

    expect(evaluated).toBe(1)
    expect(seen).toEqual([{ node: ast.subject, path: [] }])
    expect(ast.subject).toMatch(/^catch\/subject\/\d+$/)
    expect(ast.protected).toEqual({ _tag: "Succeed", value: 1 })
    expect(ast.failure).toEqual({
      _tag: "Succeed",
      value: { _tag: "PlannedReference", node: ast.subject, path: [] }
    })
    expect(ast.filter).toBeUndefined()
    expect(Node.catchFilter(ast)).toBeUndefined()
    expect(Node.catchFilter(Node.succeed(1).ast)).toBeUndefined()
    // Each catch mints its own token, so a nested arm cannot rebind an outer
    // one to the inner catch's protected node.
    expect(tagged(build().ast, "Catch").subject).not.toBe(ast.subject)
  })

  it("records a catch schema identity and keeps the live filter beside the AST", () => {
    const error = Schema.Literal("recoverable")
    const ast = tagged(
      Node.catch(Node.succeed(1), { error, onFailure: () => Node.succeed(0) }).ast,
      "Catch"
    )

    expect(ast.filter).toEqual(Schema.toJsonSchemaDocument(error))
    expect(Node.catchFilter(ast)).toBe(error)
  })

  it("refuses a catch failure arm that does not return a node", () => {
    expect(() =>
      Node.catch(Node.succeed(1), {
        onFailure: () => 1 as unknown as Node.Node<number>
      })
    ).toThrow(expect.objectContaining({
      code: "invalid_continuation",
      node: Node.catchSubject,
      message: "Node.catch expected its failure arm to return a Node"
    }))
  })

  it("hands a driver the deferred mapper and the run-time predicate, and nothing else", () => {
    const mapped = Node.succeed(2).pipe(Node.map((value) => value + 1))
    const decided = Node.succeed(2).pipe(
      Node.branch({ if: (value) => value >= 100, then: () => Node.succeed("done"), else: () => Node.succeed("again") })
    )

    expect(Node.mapper(mapped.ast)?.(2)).toBe(3)
    expect(Node.predicate(decided.ast)?.(100)).toBe(true)
    expect(Node.predicate(decided.ast)?.(99)).toBe(false)
    // Each accessor answers for its own variant only, so a driver switching on
    // the AST tag never has to guard the lookup itself.
    expect(Node.mapper(decided.ast)).toBeUndefined()
    expect(Node.predicate(mapped.ast)).toBeUndefined()
    // A rehydrated AST left its side tables behind.
    expect(Node.mapper(JSON.parse(JSON.stringify(mapped.ast)) as Node.Ast)).toBeUndefined()
    expect(Node.predicate(JSON.parse(JSON.stringify(decided.ast)) as Node.Ast)).toBeUndefined()
  })

  it("refuses a branch arm that does not return a node", () => {
    const notANode = 1 as unknown as Node.Node<string>
    for (const side of ["then", "else"]) {
      let refusal: unknown
      try {
        Node.branch(Node.succeed(1), {
          if: (value) => value >= 100,
          then: () => side === "then" ? notANode : Node.succeed("done"),
          else: () => side === "else" ? notANode : Node.succeed("again")
        })
      } catch (error) {
        refusal = error
      }
      expect(refusal).toMatchObject({
        code: "invalid_continuation",
        node: `${Node.branchSubject}/${side}`,
        path: [],
        message: `Node.branch expected its "${side}" arm to return a Node`
      })
    }
  })

  it("keeps the AST closure-free and JSON serializable", () => {
    const node = Node.succeed({ path: "counter.txt" }).pipe(
      Node.map((value) => value.path),
      Node.andThen(Node.all({ count: Node.succeed(1) })),
      Node.branch({
        if: (value) => value.count >= 100,
        then: () => Node.succeed("done"),
        else: () => Node.succeed("again")
      })
    )
    const json = JSON.stringify(node.ast)
    expect(json).not.toContain("=>")
    expect(json).not.toContain("function")
    expect(JSON.parse(json)).toEqual(node.ast)
  })

  it("digests a function by its source, so identical sources key identically", () => {
    const increment = (value: number): number => value + 1
    const alsoIncrement = (value: number): number => value + 1
    const decrement = (value: number): number => value - 1
    const digest = (f: (value: number) => number): string =>
      tagged(Node.succeed(1).pipe(Node.map(f)).ast, "Map").mapper.digest
    expect(digest(increment)).toBe(digest(alsoIncrement))
    expect(digest(increment)).not.toBe(digest(decrement))

    const continueWithValue = (value: Planned.Planned<number>) => Node.succeed(value)
    const alsoContinueWithValue = (value: Planned.Planned<number>) => Node.succeed(value)
    const continueWithZero = (_value: Planned.Planned<number>): Node.Node<number> => Node.succeed(0)
    const continuationDigest = (
      f: (value: Planned.Planned<number>) => Node.Any
    ): string => tagged(Node.andThen(Node.succeed(1), f).ast, "AndThen").continuation.digest
    expect(continuationDigest(continueWithValue)).toBe(continuationDigest(alsoContinueWithValue))
    expect(continuationDigest(continueWithValue)).not.toBe(continuationDigest(continueWithZero))
  })
})

describe("internal/node call factories", () => {
  it("records a flow call with its mode, payload, and declaration", () => {
    const declaration = { tag: "counter/count-to-100" }
    const ast = internal.flowCall(declaration, "counter/count-to-100", "boundary", { path: "counter.txt" })
    expect(ast).toEqual({
      _tag: "FlowCall",
      flow: "counter/count-to-100",
      mode: "boundary",
      payload: { path: "counter.txt" }
    })
    expect(internal.declaration(ast)).toBe(declaration)

    const handoff = Node.flowCall(declaration, "counter/count-to-100", "handoff", { value: 2 })
    expect(handoff.ast).toMatchObject({
      _tag: "FlowCall",
      flow: "counter/count-to-100",
      mode: "handoff",
      payload: { value: 2 }
    })
  })

  it("records an activity call with its payload and declaration", () => {
    const declaration = { tag: "counter/read" }
    const ast = internal.activityCall(declaration, "counter/read", { path: "counter.txt" })
    expect(ast).toEqual({
      _tag: "ActivityCall",
      activity: "counter/read",
      payload: { path: "counter.txt" }
    })
    expect(internal.declaration(ast)).toBe(declaration)
    expect(JSON.parse(JSON.stringify(ast))).toEqual(ast)
  })

  it("exposes private node factories to the flow package and serializes planned payload references", () => {
    const declaration = { tag: "counter/read" }
    const planned = Planned.make<{ readonly path: string }>("previous")
    const shared = { literal: true }
    const flow = Node.flowCall(declaration, "counter/next", "inline", { path: planned.path })
    const activity = Node.activityCall(declaration, "counter/read", {
      paths: [planned.path],
      shared: [shared, shared]
    })
    expect(flow.ast).toEqual({
      _tag: "FlowCall",
      flow: "counter/next",
      mode: "inline",
      payload: {
        path: { _tag: "PlannedReference", node: "previous", path: ["path"] }
      }
    })
    expect(activity.ast).toEqual({
      _tag: "ActivityCall",
      activity: "counter/read",
      payload: {
        paths: [{ _tag: "PlannedReference", node: "previous", path: ["path"] }],
        shared: [{ literal: true }, { literal: true }]
      }
    })
    expect(internal.declaration(tagged(flow.ast, "FlowCall"))).toBe(declaration)
    expect(internal.declaration(tagged(activity.ast, "ActivityCall"))).toBe(declaration)
    expect(JSON.parse(JSON.stringify({ flow: flow.ast, activity: activity.ast }))).toEqual({
      flow: flow.ast,
      activity: activity.ast
    })
  })

  it("preserves an own __proto__ payload field without changing the clone prototype", () => {
    const payload = Object.create(null) as Record<string, unknown>
    Object.defineProperty(payload, "__proto__", { enumerable: true, value: "safe" })
    const ast = internal.activityCall({}, "safe", payload)
    const cloned = ast.payload as Record<string, unknown>
    expect(Object.getPrototypeOf(cloned)).toBeNull()
    expect(Object.hasOwn(cloned, "__proto__")).toBe(true)
    expect(cloned.__proto__).toBe("safe")
  })

  it("reads back the declaration and the continuation a graph builder needs", () => {
    const declaration = { tag: "counter/read" }
    const activity = Node.activityCall(declaration, "counter/read", { path: "counter.txt" })
    const flow = Node.flowCall(declaration, "counter/next", "inline", { path: "counter.txt" })
    expect(Node.declaration(tagged(activity.ast, "ActivityCall"))).toBe(declaration)
    expect(Node.declaration(tagged(flow.ast, "FlowCall"))).toBe(declaration)

    const built = Node.andThen(Node.succeed(1), (value: Planned.Planned<number>) => Node.succeed(value))
    const continued = Node.continuation(tagged(built.ast, "AndThen"))?.(Planned.make<number>("upstream"))
    expect(Node.isNode(continued)).toBe(true)
    const supplied = Node.andThen(Node.succeed(1), Node.succeed(2))
    expect(Node.continuation(tagged(supplied.ast, "AndThen"))).toBeUndefined()
  })

  it("digests a function the AST does not store the same way it digests one it does", () => {
    const mapper = (value: number): number => value + 1
    const identity: Node.FunctionIdentity = Node.functionIdentity(mapper)

    expect(identity).toEqual(tagged(Node.map(Node.succeed(1), mapper).ast, "Map").mapper)
    expect(Node.functionIdentity((value: number): number => value + 2)).not.toEqual(identity)
  })
})
