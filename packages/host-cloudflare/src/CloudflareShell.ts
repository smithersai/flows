/** Cloudflare's default local shell. @since 0.1.0 */
import * as Shell from "@flows/host/Shell"
import type { Layer } from "effect"
/** No Worker local spawn exists. TICKET: .smithers/tickets/cloudflare-local-shell.md. @category layers @since 0.1.0 */
export const layer: Layer.Layer<Shell.Shell> = Shell.layerNoop({})
