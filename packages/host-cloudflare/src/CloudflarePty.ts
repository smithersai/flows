/** Cloudflare's default local pseudo-terminal. @since 0.1.0 */
import * as Pty from "@flows/host/Pty"
import type { Layer } from "effect"
/** No Worker PTY exists. TICKET: .smithers/tickets/cloudflare-local-pty.md. @category layers @since 0.1.0 */
export const layer: Layer.Layer<Pty.Pty> = Pty.layerNoop({})
