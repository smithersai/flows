/**
 * Typed unsupported PTY layer for Vercel Edge.
 *
 * TICKET: Vercel local pty — see .smithers/tickets/vercel-local-pty.md
 * @since 0.1.0
 */
import * as PtyService from "@flows/host/Pty"
import type { Pty } from "@flows/host/Pty"
import type { Layer } from "effect"

/** Provides the `unsupported` PTY implementation. @category layers @since 0.1.0 */
export const layer: Layer.Layer<Pty> = PtyService.layerNoop({})
