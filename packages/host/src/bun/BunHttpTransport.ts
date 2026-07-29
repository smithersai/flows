/**
 * Bun single-hop HTTP transport.
 *
 * Bun's global `fetch` implements the same web platform surface used by the
 * browser transport. Redirect following remains disabled.
 *
 * @since 0.1.0
 */
import type * as Layer from "effect/Layer"
import * as BrowserHttpTransport from "../browser/BrowserHttpTransport.ts"
import type { HttpTransport } from "../HttpTransport.ts"

/**
 * Provides a fetch-backed Bun HTTP transport.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<HttpTransport> = BrowserHttpTransport.layer
