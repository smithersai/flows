/**
 * The closed permission-aware Host service list.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md`,
 * `docs/specs/Concepts/Trust Granularity.md`, and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 0.1.0
 */
import {
  type HostService as SharedHostService,
  HostServiceIds as SharedHostServiceIds,
  HostServiceTags as SharedHostServiceTags
} from "@smthrs/host/HostServices"
import { Layer } from "effect"
import * as FileSystem from "./FileSystem.ts"
import * as HttpClient from "./HttpClient.ts"
import * as Jj from "./Jj.ts"
import * as Path from "./Path.ts"
import * as Pty from "./Pty.ts"
import * as Shell from "./Shell.ts"

/**
 * The CLOSED LIST of platform ports the kernel protects.
 *
 * Every capability-bearing Host operation reaches the outside world through
 * one of these tags. Keeping this list closed makes attenuation and auditing
 * complete: a service omitted here cannot be permission-decorated. `Path` is
 * intentionally retained as an explicit pass-through decision. The shared
 * Host's single-hop `HttpTransport` is an implementation requirement for the
 * protected higher-level `HttpClient`; it is not republished as a guarded raw
 * tag because that would erase permission failures from its error channel.
 *
 * @category models
 * @since 0.1.0
 */
export type HostService = SharedHostService

/**
 * The platform-port tags consumed by the kernel at runtime.
 *
 * @category models
 * @since 0.1.0
 */
export const HostServiceTags = SharedHostServiceTags

/**
 * Stable slot identifiers shared by host composition, kernel attenuation, and
 * step-layer resolution.
 *
 * @category models
 * @since 0.1.0
 */
export const HostServiceIds = SharedHostServiceIds

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
  | Shell.Shell
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
  Shell.Shell,
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
  Shell.layer,
  Pty.layer,
  Jj.layer,
  HttpClient.layer
)
