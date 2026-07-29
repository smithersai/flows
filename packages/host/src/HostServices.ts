/**
 * @since 0.1.0
 *
 * The CLOSED LIST of Host services.
 *
 * Everything that touches the outside world enters `flows` through exactly one
 * of these tags — there is no ambient `node:fs`, no bare `spawn`, no global
 * `Date.now()`. Two things depend on that closure:
 *
 *  1. The capability kernel wraps precisely this list. A service that is not
 *     here cannot be attenuated, denied, or audited, so it must not exist.
 *  2. Step keys digest this list as their `layers` component. Which Host
 *     implementations were in scope is part of a step's identity, so a replay
 *     under different layers is a different step rather than a silent lie.
 *
 * Adding a Host capability means adding it here, to the kernel, and to the
 * digest — in that order.
 *
 * `Clock` and `Random` are Effect core built-ins: already Host-shaped, already
 * swappable via `Effect.provideService`, so they are named here for
 * completeness but are not ours to define.
 */
import { FileSystem, Path } from "effect"
import { HttpTransport } from "./HttpTransport.ts"
import { Jj } from "./Jj.ts"
import { Pty } from "./Pty.ts"
import { Shell } from "./Shell.ts"

/** @category models */
export type HostService = FileSystem.FileSystem | Path.Path | Shell | Pty | Jj | HttpTransport

/**
 * The same list at runtime, for the capability kernel and the step-key digest.
 * @category models
 */
export const HostServiceTags = [FileSystem.FileSystem, Path.Path, Shell, Pty, Jj, HttpTransport] as const

/**
 * Stable identifiers for the closed Host surface. Planners include the
 * resolved implementation identities for these services in step-key layers.
 *
 * @category models
 * @since 0.1.0
 */
export const HostServiceIds = [
  "effect/FileSystem",
  "effect/Path",
  "flows/host/Shell",
  "flows/host/Pty",
  "flows/host/Jj",
  "flows/host/HttpTransport"
] as const

/** Built-ins provided by Effect itself; listed by name only. @category models */
export const HostBuiltinNames = ["effect/Clock", "effect/Random"] as const
