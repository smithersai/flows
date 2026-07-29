/**
 * Direct `@cloudflare/sandbox` adapter for Worker entry points.
 *
 * Kept off the root barrel so Node and generic browser consumers do not load
 * Cloudflare Container runtime code.
 *
 * @since 0.1.0
 */
import { getSandbox } from "@cloudflare/sandbox"
import type { Sandbox, SandboxEnv } from "@cloudflare/sandbox"
import * as CloudflareSandbox from "./CloudflareSandbox.ts"

/** Cloudflare Durable Object namespace accepted by the Sandbox SDK. @category models @since 0.1.0 */
export type SandboxNamespace = SandboxEnv<Sandbox>["Sandbox"]

/**
 * Binds a Cloudflare Sandbox Durable Object namespace to `RemoteSandbox`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromNamespace = (
  namespace: SandboxNamespace,
  session = "flows"
): CloudflareSandbox.SandboxProvider =>
  CloudflareSandbox.fromBinding((requested) => getSandbox(namespace, requested), session)
