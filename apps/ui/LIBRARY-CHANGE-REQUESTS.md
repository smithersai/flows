# Library change requests from the apps/ui flow port

`packages/*` was read-only for this port. Each entry below is a place where the
app took a workaround instead of changing a library. Will approves library
changes personally.

## 1. `FlowBinding` refusals lose the raw handler message

- **File**: `packages/harness/src/FlowBinding.ts`
- **What**: `make`'s runner wraps every handler failure as
  `` `Flow ${descriptor.name} failed: ${describe(produced.failure)}` `` and puts
  that single string in `CallResult.message`. The original failure value is not
  carried anywhere on the result.
- **Why it matters here**: the app dispatches user-facing affordances through
  the same bindings the agent calls. A handler's failure IS the copy the human
  reads ("send needs the text to submit"), so the framing prefix is noise on the
  UI surface while being useful on the cell surface. With only the framed string
  available, the host has to re-derive the raw message by stripping a prefix it
  reconstructs from the flow name — a string contract between two modules that
  the type system does not check, and that silently degrades to the framed text
  if the library ever rewords it.
- **Workaround taken**: `apps/ui/src/mainview/commands/Commands.ts` has an
  `unframe(name, message)` helper that strips the exact
  `` `Flow ${name} failed: ` `` prefix when present and otherwise passes the
  message through. It is correct today and fails safe (worst case the human sees
  the framed text), but it duplicates a library string.
- **Proposed diff sketch**: add an optional raw field to `Cell.CallResult` and
  populate it in `FlowBinding.make`:

  ```diff
   export class CallResult extends Schema.Class<CallResult>("flows/harness/Cell/CallResult")({
     outcome: Schema.Literals(["success", "failure"]),
     value: Schema.Json,
  -  message: Schema.optional(Schema.String)
  +  message: Schema.optional(Schema.String),
  +  /** The handler's own refusal, unframed, for hosts that surface it directly. */
  +  detail: Schema.optional(Schema.String)
   }) {}
  ```

  ```diff
  -const refused = (message: string): CallResult => new CallResult({ outcome: "failure", value: null, message })
  +const refused = (message: string, detail?: string): CallResult =>
  +  new CallResult({ outcome: "failure", value: null, message, ...(detail === undefined ? {} : { detail }) })
  ```

  with the handler-failure branch passing `describe(produced.failure)` as
  `detail`. Nothing existing reads `detail`, so the change is additive.
