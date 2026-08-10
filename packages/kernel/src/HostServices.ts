/**
 * The closed Host service list, raw and permission-aware.
 *
 * One module owns both halves so the slots can never drift: {@link HostService}
 * / {@link HostServiceTags} / {@link HostServiceIds} are the raw platform
 * ports, and {@link ProtectedHostService} / {@link ProtectedHostServiceTags}
 * are the guarded projections in the same slot order.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md`,
 * `docs/specs/Concepts/Trust Granularity.md`, and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 0.1.0
 */
import { Jj as JjPort } from "@smthrs/jj"
import { Pty as PtyPort } from "@smthrs/pty"
import { FileSystem as EffectFileSystem, Layer, Path as EffectPath } from "effect"
import { ChildProcessSpawner as ChildProcessSpawnerPort } from "effect/unstable/process/ChildProcessSpawner"
import * as ChildProcessSpawner from "./ChildProcessSpawner.ts"
import * as FileSystem from "./FileSystem.ts"
import * as HttpClient from "./HttpClient.ts"
import { HttpTransport } from "./HttpTransport.ts"
import * as Jj from "./Jj.ts"
import * as Path from "./Path.ts"
import * as Pty from "./Pty.ts"

/**
 * The CLOSED LIST of platform ports the kernel protects.
 *
 * Everything that touches the outside world enters `flows` through exactly one
 * of these tags — there is no ambient `node:fs`, no bare `spawn`, no global
 * `Date.now()`. Two things depend on that closure:
 *
 *  1. The capability kernel wraps precisely this list. A service that is not
 *     here cannot be attenuated, denied, or audited, so it must not exist.
 *  2. Step keys digest this list as their `layers` component. Which platform
 *     implementations were in scope is part of a step's identity, so a replay
 *     under different layers is a different step rather than a silent lie.
 *
 * `Path` is intentionally retained as an explicit pass-through decision. The
 * single-hop `HttpTransport` port is an implementation requirement for the
 * protected higher-level `HttpClient`; it is not republished as a guarded raw
 * tag because that would erase permission failures from its error channel.
 *
 * `Clock` and `Random` are Effect core built-ins: already port-shaped, already
 * swappable via `Effect.provideService`, so they are named in
 * {@link HostBuiltinNames} for completeness but are not ours to define.
 * `ChildProcessSpawner` is the same story one layer out: process spawning is
 * `effect/unstable/process`, and the slot holds Effect's tag rather than a
 * `flows` wrapper around it.
 *
 * @category models
 * @since 0.1.0
 */
export type HostService =
  | EffectFileSystem.FileSystem
  | EffectPath.Path
  | ChildProcessSpawnerPort
  | PtyPort
  | JjPort
  | HttpTransport

/**
 * The platform-port tags consumed by the kernel at runtime, and digested by
 * the step-key planner.
 *
 * @category models
 * @since 0.1.0
 */
export const HostServiceTags = [
  EffectFileSystem.FileSystem,
  EffectPath.Path,
  ChildProcessSpawnerPort,
  PtyPort,
  JjPort,
  HttpTransport
] as const

/**
 * Stable slot identifiers shared by host composition, kernel attenuation, and
 * step-layer resolution.
 *
 * These strings are FROZEN. They are digested into step keys, so they name a
 * service's identity, not the package its module happens to live in: `Pty` and
 * `Jj` moved to `@smthrs/pty` and `@smthrs/jj`, and `HttpTransport` moved here
 * from the dissolved `@smthrs/host`, without changing behaviour. Renaming them
 * would invalidate every cached step for no reason.
 *
 * The third slot is the exception that proves the rule: dropping the `Shell`
 * wrapper for Effect's own `ChildProcessSpawner` replaced the *service*, not
 * just its home, so `flows/host/Shell` became
 * `effect/process/ChildProcessSpawner` and every step that ran a command is
 * correctly a different step.
 *
 * @category models
 * @since 0.1.0
 */
export const HostServiceIds = [
  "effect/FileSystem",
  "effect/Path",
  "effect/process/ChildProcessSpawner",
  "flows/host/Pty",
  "flows/host/Jj",
  "flows/host/HttpTransport"
] as const

/** Built-ins provided by Effect itself; listed by name only. @category models */
export const HostBuiltinNames = ["effect/Clock", "effect/Random"] as const

/**
 * The permission-aware services exposed above the platform ports.
 *
 * `HttpClient` is the protected projection of the host's single-hop
 * `HttpTransport` slot; all other entries correspond positionally to the
 * shared `HostServiceIds` contract.
 *
 * @category models
 * @since 0.1.0
 */
export type ProtectedHostService =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Pty.Pty
  | Jj.Jj
  | HttpClient.HttpClient

/**
 * Permission-aware tags exposed by `layer`, in the same slot order as
 * `HostServiceIds`.
 *
 * @category models
 * @since 0.1.0
 */
export const ProtectedHostServiceTags = [
  FileSystem.FileSystem,
  Path.Path,
  ChildProcessSpawner.ChildProcessSpawner,
  Pty.Pty,
  Jj.Jj,
  HttpClient.HttpClient
] as const

/**
 * Builds the full protected Host surface over a host platform bundle and a
 * `GrantStore`. `Workspace` remains a requirement so the exact same root
 * service can be supplied to both the grant store and filesystem decorators.
 *
 * The layer exposes permission-aware kernel tags whose TypeScript error
 * channels include permission failures. Raw HTTP tags are never republished;
 * consumers must use `@smthrs/kernel/HttpClient`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.mergeAll(
  FileSystem.layer,
  Path.layer,
  ChildProcessSpawner.layer,
  Pty.layer,
  Jj.layer,
  HttpClient.layer
)
