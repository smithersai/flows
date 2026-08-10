# `@smthrs/jj`

This page is the public API reference for the `Jj` host service: version control as a capability. Permission enforcement is provided separately by `@smthrs/kernel`, whose `Jj` decorator wraps this contract.

The package depends on `effect` alone. `Jj` is still one of the six services in the closed host list `@smthrs/host` owns; the contract lives here so a consumer that only snapshots a working copy does not take a shell, a pty, and an HTTP transport with it.

## Contract

| Export | Kind | Notes |
| --- | --- | --- |
| `Jj` | interface + service tag | tag key `flows/host/Jj` |
| `ChangeId` | type | the durable handle a run uses to name workspace state |
| `snapshot`, `restore`, `diff`, `workspaceAdd`, `workspaceForget`, `status` | methods | every one fails with `JjError` |
| `JjError` | class | tagged `flows/host/JjError`, carrying `code`, `module`, `method`, `message`, and the `command` that produced it |
| `JjErrorCode` | const + type | `not_installed`, `conflict`, `invalid_ref`, `unknown` |
| `jjError` | constructor | builds a `JjError` from a code plus context |
| `make`, `makeNoop`, `layerNoop` | constructors and layer | `makeNoop` fails every method with `not_installed` until overridden |

`snapshot` describes the current change, reads its id, and opens a fresh one — the id returned is the state a later `restore` goes back to.

## Implementations

Implementations are **not** root exports. The root is the portable contract and bundles for the browser; each implementation is imported from its own subpath.

| Import | Layer |
| --- | --- |
| `@smthrs/jj/node/NodeJj` | `layer` spawning the `jj` CLI with argv, never a shell string |
| `@smthrs/jj/bun/BunJj` | `layer` — Bun implements the same child-process API, so this is `NodeJj.layer` |
| `@smthrs/jj/browser/BrowserJj` | `layerUnsupported` — every operation reports `not_installed` |

```ts
import { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
```

`NodeJj` deliberately spawns its own children rather than going through `Shell`: jj invocations are argv arrays with no shell interpretation, and the host must be able to checkpoint work even where a user-facing shell is unavailable or sandboxed. Errors are classified from jj's own stderr vocabulary onto the stable codes, the way `NodeFileSystem` classifies errno.

jj is a native binary, so there is nothing to run in a browser tab. `BrowserJj.layerUnsupported` reports `not_installed` — the same code the Node layer uses when the binary is absent, so a caller needs no browser-specific branch. It is a ticket, not a silent exception; see `Concepts/Browser jj` in the spec vault.

## Durable identity

The tag key `flows/host/Jj` and the error `_tag` `flows/host/JjError` are frozen. Step keys digest the resolved service set, and `JjError` round-trips through the journal, so these strings name the service's identity rather than the package its module happens to live in. `packages/jj/test/index.test.ts` pins both. See [step keys](../concepts/step-keys.md).

## Browser support

`@smthrs/jj` and `@smthrs/jj/browser/BrowserJj` are gated as browser entry points by `scripts/browser-check.mjs` (`npm run browser`, and one CI step). The same gate asserts `@smthrs/jj/node/NodeJj` and `@smthrs/jj/bun/BunJj` still do *not* bundle, and that the reason is `node:child_process`.

See [Hosts and capabilities](../concepts/hosts-and-capabilities.md), the [`@smthrs/host` reference](host.md), the [`@smthrs/kernel` reference](kernel.md), and [time travel](../concepts/time-travel.md), which uses `Jj` for workspace snapshot and restore.
