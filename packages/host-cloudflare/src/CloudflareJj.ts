/** Cloudflare's default local jj service. @since 0.1.0 */
import * as Jj from "@flows/host/Jj"
import type { Layer } from "effect"
/** Workers do not contain the jj binary. TICKET: .smithers/tickets/cloudflare-local-jj.md. @category layers @since 0.1.0 */
export const layer: Layer.Layer<Jj.Jj> = Jj.layerNoop({})
