/**
 * Default Vercel Edge shell layer.
 *
 * Edge functions have no local process API. The service remains present and
 * returns the closed `shell_unavailable` error until a remote sandbox layer is
 * selected.
 *
 * TICKET: Vercel local shell — see .smithers/tickets/vercel-local-shell.md
 * @since 0.1.0
 */
import * as ShellService from "@flows/host/Shell"
import type { Shell } from "@flows/host/Shell"
import type { Layer } from "effect"

/** Provides the typed unavailable shell. @category layers @since 0.1.0 */
export const layer: Layer.Layer<Shell> = ShellService.layerNoop({})
