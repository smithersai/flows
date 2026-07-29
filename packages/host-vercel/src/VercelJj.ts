/**
 * Typed unavailable jj layer for Vercel Edge.
 *
 * TICKET: Vercel local jj — see .smithers/tickets/vercel-local-jj.md
 * @since 0.1.0
 */
import * as JjService from "@flows/host/Jj"
import type { Jj } from "@flows/host/Jj"
import type { Layer } from "effect"

/** Provides the `not_installed` jj implementation. @category layers @since 0.1.0 */
export const layer: Layer.Layer<Jj> = JjService.layerNoop({})
