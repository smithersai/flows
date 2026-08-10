# `@smthrs/pty`

This page is the public API reference for the `Pty` host service: a real pseudo-terminal as a capability. Permission enforcement is provided separately by `@smthrs/kernel`, whose `Pty` decorator wraps this contract.

The package depends on `effect` alone. `Pty` is still one of the six services in the closed host list `@smthrs/host` owns; the contract lives here so a consumer that only drives a terminal does not take the rest of the host surface with it.

## Contract

| Export | Kind | Notes |
| --- | --- | --- |
| `Pty` | interface + service tag | tag key `flows/host/Pty`; `spawn` requires `Scope` |
| `PtySpawnOptions` | interface | `cols`, `rows`, optional `cwd` and `env` |
| `PtyHandle` | interface | `write`, `resize`, `output`, `attach(fromCursor)`, `exitCode` |
| `PtyError` | class | tagged `flows/host/PtyError`, carrying `code`, `module`, `method`, `message`, `exitCode` |
| `PtyErrorCode` | const + type | `unsupported`, `exited`, `not_found`, `unknown` |
| `ptyError` | constructor | builds a `PtyError` from a code plus context |
| `make`, `makeNoop`, `layerNoop` | constructors and layer | `makeNoop` fails `spawn` with `unsupported` until overridden |

A handle is scoped: closing the scope — or interrupting the fiber that owns it — kills the process. No `AbortSignal` crosses this seam.

`attach(fromCursor)` replays the retained buffer from an absolute output cursor and then continues live, so a second viewer can join a running terminal without losing scrollback. A cursor that has fallen behind the retained window resumes at the oldest byte still held rather than silently skipping.

A PTY output stream ends when the child's stdio pipes close, not when the child is reaped: `exitCode` resolves on the child's `exit`, while `output`/`attach` keep delivering anything still buffered in the pipe (or written by a grandchild that inherited it) until it closes.

## Implementations

Implementations are **not** root exports. The root is the portable contract and bundles for the browser; each implementation is imported from its own subpath.

| Import | Layer |
| --- | --- |
| `@smthrs/pty/node/NodePty` | `layer` over `node:child_process` with piped stdio and a bounded replay ring |
| `@smthrs/pty/bun/BunPty` | `layer` — Bun implements the same child-process API, so this is `NodePty.layer` |
| `@smthrs/pty/browser/BrowserPty` | `layerUnsupported` — `spawn` reports `unsupported`, echoing the requested command |

```ts
import { Pty } from "@smthrs/pty"
import * as NodePty from "@smthrs/pty/node/NodePty"
```

`NodePty` is a **skeleton, not a real PTY.** A true pseudo-terminal needs a native addon (`node-pty` / `@lydell/node-pty`), which is deliberately not a dependency yet. Until it is, the layer spawns with piped stdio: programs see a non-TTY stdout, `resize` is recorded but not delivered as `SIGWINCH`, and full-screen apps will not render. Swapping in `node-pty` means replacing `spawn`/`write`/`resize`; the contract and the replay ring stay as they are.

There is no pseudo-terminal in a browser tab — no `openpty`, no child process to attach one to — so `BrowserPty.layerUnsupported` fails in the error channel rather than omitting the tag. It is a ticket, not a silent exception.

## Durable identity

The tag key `flows/host/Pty` and the error `_tag` `flows/host/PtyError` are frozen. Step keys digest the resolved service set, and `PtyError` round-trips through the journal, so these strings name the service's identity rather than the package its module happens to live in. `packages/pty/test/index.test.ts` pins both. See [step keys](../concepts/step-keys.md).

## Browser support

`@smthrs/pty` and `@smthrs/pty/browser/BrowserPty` are gated as browser entry points by `scripts/browser-check.mjs` (`npm run browser`, and one CI step). The same gate asserts `@smthrs/pty/node/NodePty` and `@smthrs/pty/bun/BunPty` still do *not* bundle, and that the reason is `node:child_process`.

See [Hosts and capabilities](../concepts/hosts-and-capabilities.md), the [`@smthrs/host` reference](host.md), and the [`@smthrs/kernel` reference](kernel.md).
